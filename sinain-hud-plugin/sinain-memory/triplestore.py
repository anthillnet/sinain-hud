#!/usr/bin/env python3
"""EAV Triple Store — SQLite-backed entity-attribute-value store.

Provides a Datomic/RhizomeDB-inspired immutable triple store with 4 covering
indexes (EAVT, AEVT, VAET, AVET) for fast graph traversal and lookup.

Each fact is a (entity_id, attribute, value) triple with a value_type tag.
Triples are asserted within transactions; retraction marks triples as logically
deleted without physically removing them (until GC).

Usage:
    from triplestore import TripleStore
    store = TripleStore("memory/triplestore.db")
    tx = store.begin_tx("signal_analyzer", session_key="abc")
    store.assert_triple(tx, "signal:2026-03-01T10:00:00Z", "description", "OCR backpressure")
    store.assert_triple(tx, "signal:2026-03-01T10:00:00Z", "related_to", "concept:ocr", value_type="ref")
    entity = store.entity("signal:2026-03-01T10:00:00Z")

Self-test:
    python3 triplestore.py --self-test
"""

import json
import math
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS transactions (
    tx_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    source      TEXT    NOT NULL,
    session_key TEXT,
    parent_tx   INTEGER,
    metadata    TEXT,
    created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS triples (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_id         INTEGER NOT NULL REFERENCES transactions(tx_id),
    entity_id     TEXT    NOT NULL,
    attribute     TEXT    NOT NULL,
    value         TEXT    NOT NULL,
    value_type    TEXT    NOT NULL DEFAULT 'string',
    retracted     INTEGER NOT NULL DEFAULT 0,
    retracted_tx  INTEGER,
    valid_to      TEXT,
    created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS entity_types (
    entity_id   TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL
);

-- EAVT: "what does entity X look like?"
CREATE INDEX IF NOT EXISTS idx_eavt
    ON triples(entity_id, attribute, value, tx_id);

-- AEVT: "which entities have attribute Y?"
CREATE INDEX IF NOT EXISTS idx_aevt
    ON triples(attribute, entity_id, value, tx_id);

-- VAET: "what references entity Z?" (ref edges only)
CREATE INDEX IF NOT EXISTS idx_vaet
    ON triples(value, attribute, entity_id, tx_id)
    WHERE value_type = 'ref';

-- AVET: "find entity by unique attribute+value"
CREATE INDEX IF NOT EXISTS idx_avet
    ON triples(attribute, value, entity_id, tx_id);
"""

_FTS_SQL = """
-- Full-text search on fact values (for hybrid retrieval)
CREATE VIRTUAL TABLE IF NOT EXISTS triples_fts
    USING fts5(entity_id, value, content=triples, content_rowid=id);

-- Triggers to keep FTS in sync with triples table
CREATE TRIGGER IF NOT EXISTS triples_ai AFTER INSERT ON triples BEGIN
    INSERT INTO triples_fts(rowid, entity_id, value) VALUES (new.id, new.entity_id, new.value);
END;

CREATE TRIGGER IF NOT EXISTS triples_ad AFTER DELETE ON triples BEGIN
    INSERT INTO triples_fts(triples_fts, rowid, entity_id, value) VALUES ('delete', old.id, old.entity_id, old.value);
END;

CREATE TRIGGER IF NOT EXISTS triples_au AFTER UPDATE ON triples BEGIN
    INSERT INTO triples_fts(triples_fts, rowid, entity_id, value) VALUES ('delete', old.id, old.entity_id, old.value);
    INSERT INTO triples_fts(triples_fts, rowid, entity_id, value) VALUES (new.id, new.entity_id, new.value);
END;
"""


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _entity_type(entity_id: str) -> str:
    """Extract type prefix from entity_id (e.g. 'signal:...' → 'signal')."""
    colon = entity_id.find(":")
    return entity_id[:colon] if colon > 0 else "unknown"


def decayed_confidence(
    confidence: float, created_at: str, half_life_days: int = 60
) -> float:
    """Apply exponential time-decay to a confidence score.

    Facts lose half their confidence every `half_life_days` without reinforcement.
    Inspired by mempalace's temporal validity model.
    """
    try:
        created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        age_days = (datetime.now(timezone.utc) - created).days
        if age_days <= 0:
            return confidence
        return confidence * math.exp(-0.693 * age_days / half_life_days)
    except (ValueError, TypeError):
        return confidence


class TripleStore:
    """SQLite-backed EAV triple store with WAL mode and 4 covering indexes."""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = str(db_path)
        os.makedirs(os.path.dirname(self.db_path) or ".", exist_ok=True)
        self._conn = sqlite3.connect(self.db_path, timeout=10)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout=10000")
        self._conn.executescript(_SCHEMA_SQL)
        try:
            self._conn.executescript(_FTS_SQL)
        except sqlite3.OperationalError:
            pass  # FTS5 not available on this Python build — degrade gracefully
        self._migrate()
        self._conn.commit()

    def _migrate(self) -> None:
        """Run schema migrations for existing databases."""
        # Add valid_to column if missing (added in memory-improvements)
        cols = [r[1] for r in self._conn.execute("PRAGMA table_info(triples)").fetchall()]
        if "valid_to" not in cols:
            self._conn.execute("ALTER TABLE triples ADD COLUMN valid_to TEXT")

    def close(self) -> None:
        self._conn.close()

    # ----- Transactions -----

    def begin_tx(
        self,
        source: str,
        session_key: str | None = None,
        parent_tx: int | None = None,
        metadata: dict | None = None,
    ) -> int:
        """Begin a new transaction, returns tx_id."""
        cur = self._conn.execute(
            "INSERT INTO transactions (source, session_key, parent_tx, metadata, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                source,
                session_key,
                parent_tx,
                json.dumps(metadata) if metadata else None,
                _now_iso(),
            ),
        )
        self._conn.commit()
        return cur.lastrowid

    def latest_tx(self) -> int:
        """Return the latest transaction id, or 0 if none."""
        row = self._conn.execute(
            "SELECT MAX(tx_id) FROM transactions"
        ).fetchone()
        return row[0] or 0

    # ----- Assert / Retract -----

    def assert_triple(
        self,
        tx_id: int,
        entity_id: str,
        attribute: str,
        value: str,
        value_type: str = "string",
    ) -> int:
        """Assert a triple within a transaction. Returns the triple id.

        Auto-populates entity_types from entity_id prefix.
        """
        now = _now_iso()
        cur = self._conn.execute(
            "INSERT INTO triples (tx_id, entity_id, attribute, value, value_type, retracted, created_at) "
            "VALUES (?, ?, ?, ?, ?, 0, ?)",
            (tx_id, entity_id, attribute, value, value_type, now),
        )
        # Upsert entity type
        etype = _entity_type(entity_id)
        self._conn.execute(
            "INSERT OR IGNORE INTO entity_types (entity_id, entity_type) VALUES (?, ?)",
            (entity_id, etype),
        )
        self._conn.commit()
        return cur.lastrowid

    def retract_triple(
        self,
        tx_id: int,
        entity_id: str,
        attribute: str,
        value: str | None = None,
    ) -> int:
        """Retract triples matching entity+attribute (and optionally value).

        Sets retracted=1, retracted_tx, and valid_to (temporal closure).
        The original tx_id is preserved for temporal (as_of_tx) queries.
        Returns the count of triples retracted.
        """
        now = _now_iso()
        if value is not None:
            cur = self._conn.execute(
                "UPDATE triples SET retracted = 1, retracted_tx = ?, valid_to = ? "
                "WHERE entity_id = ? AND attribute = ? AND value = ? AND retracted = 0",
                (tx_id, now, entity_id, attribute, value),
            )
        else:
            cur = self._conn.execute(
                "UPDATE triples SET retracted = 1, retracted_tx = ?, valid_to = ? "
                "WHERE entity_id = ? AND attribute = ? AND retracted = 0",
                (tx_id, now, entity_id, attribute),
            )
        self._conn.commit()
        return cur.rowcount

    # ----- Query: EAVT (entity view) -----

    def entity(self, entity_id: str, as_of_tx: int | None = None) -> dict[str, list[str]]:
        """Return all active attributes for an entity as {attr: [values]}.

        Uses EAVT index. When as_of_tx is set, shows triples that were
        asserted on or before that tx AND not yet retracted at that point.
        """
        if as_of_tx is not None:
            rows = self._conn.execute(
                "SELECT attribute, value FROM triples "
                "WHERE entity_id = ? AND tx_id <= ? "
                "AND (retracted = 0 OR retracted_tx > ?) "
                "ORDER BY attribute, id",
                (entity_id, as_of_tx, as_of_tx),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT attribute, value FROM triples "
                "WHERE entity_id = ? AND retracted = 0 "
                "ORDER BY attribute, id",
                (entity_id,),
            ).fetchall()
        result: dict[str, list[str]] = {}
        for row in rows:
            result.setdefault(row["attribute"], []).append(row["value"])
        return result

    def entity_as_of(self, entity_id: str, date: datetime) -> dict[str, list[str]]:
        """Return entity attributes as they were on a specific date.

        Uses created_at and valid_to for date-based temporal queries
        (vs as_of_tx which uses transaction ordering).
        """
        date_iso = date.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        rows = self._conn.execute(
            "SELECT attribute, value FROM triples "
            "WHERE entity_id = ? AND created_at <= ? "
            "AND (valid_to IS NULL OR valid_to > ?) "
            "AND retracted = 0 "
            "ORDER BY attribute, id",
            (entity_id, date_iso, date_iso),
        ).fetchall()
        result: dict[str, list[str]] = {}
        for row in rows:
            result.setdefault(row["attribute"], []).append(row["value"])
        return result

    # ----- Query: AEVT (attribute scan) -----

    def entities_with_attr(
        self, attribute: str, as_of_tx: int | None = None
    ) -> list[tuple[str, str]]:
        """Return [(entity_id, value)] for all entities having the given attribute.

        Uses AEVT index.
        """
        if as_of_tx is not None:
            rows = self._conn.execute(
                "SELECT entity_id, value FROM triples "
                "WHERE attribute = ? AND tx_id <= ? "
                "AND (retracted = 0 OR retracted_tx > ?) "
                "ORDER BY entity_id",
                (attribute, as_of_tx, as_of_tx),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT entity_id, value FROM triples "
                "WHERE attribute = ? AND retracted = 0 "
                "ORDER BY entity_id",
                (attribute,),
            ).fetchall()
        return [(r["entity_id"], r["value"]) for r in rows]

    # ----- Query: VAET (backrefs) -----

    def backrefs(
        self,
        target: str,
        attribute: str | None = None,
        as_of_tx: int | None = None,
    ) -> list[tuple[str, str]]:
        """Return [(entity_id, attribute)] for ref triples pointing to target.

        Uses VAET index (partial index on value_type='ref').
        """
        conditions = ["value = ?", "value_type = 'ref'"]
        params: list = [target]
        if attribute:
            conditions.append("attribute = ?")
            params.append(attribute)
        if as_of_tx is not None:
            conditions.append("tx_id <= ?")
            conditions.append("(retracted = 0 OR retracted_tx > ?)")
            params.append(as_of_tx)
            params.append(as_of_tx)
        else:
            conditions.append("retracted = 0")
        where = " AND ".join(conditions)
        rows = self._conn.execute(
            f"SELECT entity_id, attribute FROM triples WHERE {where} ORDER BY entity_id",
            params,
        ).fetchall()
        return [(r["entity_id"], r["attribute"]) for r in rows]

    # ----- Query: AVET (lookup by attribute+value) -----

    def lookup(
        self, attribute: str, value: str, as_of_tx: int | None = None
    ) -> list[str]:
        """Return entity_ids that have the exact attribute=value.

        Uses AVET index.
        """
        if as_of_tx is not None:
            rows = self._conn.execute(
                "SELECT DISTINCT entity_id FROM triples "
                "WHERE attribute = ? AND value = ? AND tx_id <= ? "
                "AND (retracted = 0 OR retracted_tx > ?)",
                (attribute, value, as_of_tx, as_of_tx),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT DISTINCT entity_id FROM triples "
                "WHERE attribute = ? AND value = ? AND retracted = 0",
                (attribute, value),
            ).fetchall()
        return [r["entity_id"] for r in rows]

    # ----- Graph traversal: BFS neighbors -----

    def neighbors(
        self, entity_id: str, depth: int = 1, as_of_tx: int | None = None
    ) -> dict[str, dict[str, list[str]]]:
        """BFS traversal via ref edges. Returns {entity_id: {attr: [vals]}} for all
        entities reachable within `depth` hops."""
        visited: set[str] = set()
        frontier = {entity_id}
        result: dict[str, dict[str, list[str]]] = {}

        for _ in range(depth + 1):
            next_frontier: set[str] = set()
            for eid in frontier:
                if eid in visited:
                    continue
                visited.add(eid)
                attrs = self.entity(eid, as_of_tx)
                if attrs:
                    result[eid] = attrs
                # Follow outgoing refs
                for attr, vals in attrs.items():
                    # Check which values are refs
                    for val in vals:
                        ref_rows = self._conn.execute(
                            "SELECT 1 FROM triples "
                            "WHERE entity_id = ? AND attribute = ? AND value = ? "
                            "AND value_type = 'ref' AND retracted = 0 LIMIT 1",
                            (eid, attr, val),
                        ).fetchone()
                        if ref_rows:
                            next_frontier.add(val)
                # Follow incoming refs (backrefs)
                for src_eid, _ in self.backrefs(eid, as_of_tx=as_of_tx):
                    next_frontier.add(src_eid)
            frontier = next_frontier - visited

        return result

    # ----- Novelty (change feed) -----

    def novelty(
        self, since_tx: int, until_tx: int | None = None
    ) -> list[dict]:
        """Return triples asserted or retracted since since_tx (exclusive)."""
        if until_tx is not None:
            rows = self._conn.execute(
                "SELECT id, tx_id, entity_id, attribute, value, value_type, retracted, created_at "
                "FROM triples WHERE tx_id > ? AND tx_id <= ? ORDER BY id",
                (since_tx, until_tx),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT id, tx_id, entity_id, attribute, value, value_type, retracted, created_at "
                "FROM triples WHERE tx_id > ? ORDER BY id",
                (since_tx,),
            ).fetchall()
        return [dict(r) for r in rows]

    # ----- Stats -----

    def stats(self) -> dict:
        """Return store statistics."""
        triple_count = self._conn.execute(
            "SELECT COUNT(*) FROM triples WHERE retracted = 0"
        ).fetchone()[0]
        entity_count = self._conn.execute(
            "SELECT COUNT(*) FROM entity_types"
        ).fetchone()[0]
        tx_count = self._conn.execute(
            "SELECT COUNT(*) FROM transactions"
        ).fetchone()[0]
        try:
            db_size = os.path.getsize(self.db_path)
        except OSError:
            db_size = 0
        return {
            "triples": triple_count,
            "entities": entity_count,
            "transactions": tx_count,
            "db_size_bytes": db_size,
        }

    # ----- Garbage collection -----

    def gc(self, older_than_days: int = 30) -> int:
        """Physically delete retracted triples older than N days. Returns count."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=older_than_days)).isoformat()
        cur = self._conn.execute(
            "DELETE FROM triples WHERE retracted = 1 AND created_at < ?",
            (cutoff,),
        )
        self._conn.commit()
        return cur.rowcount


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

def _self_test() -> None:
    """Run a quick self-test with a temp in-memory database."""
    import tempfile

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test.db")
        store = TripleStore(db_path)

        # Transaction
        tx1 = store.begin_tx("self-test", session_key="test-session")
        assert tx1 > 0, "begin_tx should return positive tx_id"
        assert store.latest_tx() == tx1

        # Assert triples
        store.assert_triple(tx1, "signal:2026-03-01", "description", "OCR stall detected")
        store.assert_triple(tx1, "signal:2026-03-01", "priority", "high")
        store.assert_triple(tx1, "signal:2026-03-01", "related_to", "concept:ocr", value_type="ref")
        store.assert_triple(tx1, "concept:ocr", "name", "OCR")
        store.assert_triple(tx1, "pattern:frame-batching", "text", "Frame batching improves OCR")
        store.assert_triple(tx1, "pattern:frame-batching", "related_to", "concept:ocr", value_type="ref")

        # EAVT: entity view
        ent = store.entity("signal:2026-03-01")
        assert "description" in ent, f"entity missing 'description': {ent}"
        assert ent["description"] == ["OCR stall detected"]
        assert ent["priority"] == ["high"]
        assert ent["related_to"] == ["concept:ocr"]
        print("  [OK] EAVT: entity view")

        # AEVT: attribute scan
        with_desc = store.entities_with_attr("description")
        assert ("signal:2026-03-01", "OCR stall detected") in with_desc
        print("  [OK] AEVT: entities_with_attr")

        # VAET: backrefs
        refs = store.backrefs("concept:ocr")
        entity_ids = [r[0] for r in refs]
        assert "signal:2026-03-01" in entity_ids
        assert "pattern:frame-batching" in entity_ids
        print("  [OK] VAET: backrefs")

        # AVET: lookup
        found = store.lookup("name", "OCR")
        assert "concept:ocr" in found
        print("  [OK] AVET: lookup")

        # BFS neighbors
        nbrs = store.neighbors("concept:ocr", depth=1)
        assert "concept:ocr" in nbrs
        assert "signal:2026-03-01" in nbrs or "pattern:frame-batching" in nbrs
        print("  [OK] BFS neighbors")

        # Novelty
        tx2 = store.begin_tx("self-test-2")
        store.assert_triple(tx2, "concept:test", "name", "Test")
        changes = store.novelty(tx1)
        assert len(changes) >= 1
        assert any(c["entity_id"] == "concept:test" for c in changes)
        print("  [OK] Novelty feed")

        # Retraction
        count = store.retract_triple(tx2, "signal:2026-03-01", "priority")
        assert count == 1
        ent_after = store.entity("signal:2026-03-01")
        assert "priority" not in ent_after
        print("  [OK] Retraction")

        # as_of_tx isolation
        ent_before = store.entity("signal:2026-03-01", as_of_tx=tx1)
        assert "priority" in ent_before, "as_of_tx should see pre-retraction state"
        print("  [OK] as_of_tx isolation")

        # valid_to set on retraction
        retracted_row = store._conn.execute(
            "SELECT valid_to FROM triples WHERE entity_id = 'signal:2026-03-01' AND attribute = 'priority'"
        ).fetchone()
        assert retracted_row and retracted_row["valid_to"] is not None, "valid_to should be set on retraction"
        print("  [OK] valid_to set on retraction")

        # entity_as_of
        future = datetime.now(timezone.utc) + timedelta(days=1)
        ent_future = store.entity_as_of("signal:2026-03-01", future)
        assert "description" in ent_future, "entity_as_of should find active triples"
        assert "priority" not in ent_future, "entity_as_of should exclude retracted triples"
        print("  [OK] entity_as_of temporal query")

        # Confidence decay utility
        fresh_conf = decayed_confidence(0.8, _now_iso())
        assert abs(fresh_conf - 0.8) < 0.01, f"Fresh fact should keep confidence: {fresh_conf}"
        old_date = (datetime.now(timezone.utc) - timedelta(days=60)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        old_conf = decayed_confidence(0.8, old_date)
        assert 0.35 < old_conf < 0.45, f"60-day-old fact should decay to ~0.4: {old_conf}"
        print(f"  [OK] Confidence decay: fresh=0.8→{fresh_conf:.2f}, 60d=0.8→{old_conf:.2f}")

        # GC (retracted triples are fresh, so gc with 0 days should get them)
        gc_count = store.gc(older_than_days=0)
        assert gc_count >= 1
        print("  [OK] Garbage collection")

        # Stats
        s = store.stats()
        assert s["triples"] >= 1
        assert s["entities"] >= 1
        assert s["transactions"] >= 2
        assert s["db_size_bytes"] > 0
        print(f"  [OK] Stats: {s}")

        store.close()
        print("\n  All self-tests passed!")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        print("Running triplestore self-test...")
        _self_test()
    else:
        print("Usage: python3 triplestore.py --self-test")
