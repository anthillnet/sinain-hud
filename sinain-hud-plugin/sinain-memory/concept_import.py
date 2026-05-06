#!/usr/bin/env python3
"""Concept Import — replay a sinain-concept/v1 bundle into the local triplestore.

Designed for idempotency: re-importing the same bundle in `merge` mode is a
no-op (existing triples skip-as-duplicate). The receiver re-issues tx_ids
locally but preserves the source-tx grouping, so the digest atomicity that
knowledge_integrator.py relies on survives the round-trip.

Usage:
    python3 concept_import.py --db <kg.db> --bundle <bundle.json> \\
        [--web-db <web.db>] [--conflict skip|merge|overwrite]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
import time
from pathlib import Path


def verify_envelope(envelope: dict) -> tuple[bool, str]:
    """Validate format and checksum. Returns (ok, error_msg)."""
    fmt = envelope.get("format")
    if fmt != "sinain-concept/v1":
        return False, f"unsupported format: {fmt!r} (need sinain-concept/v1)"
    if "root_entity" not in envelope or "entities" not in envelope:
        return False, "envelope missing root_entity or entities"
    expected = envelope.get("checksum")
    if expected:
        canonical = json.dumps(
            {"root_entity": envelope["root_entity"], "entities": envelope["entities"]},
            sort_keys=True, ensure_ascii=False, separators=(",", ":"),
        )
        actual = "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        if actual != expected:
            return False, f"checksum mismatch (expected {expected[:23]}..., got {actual[:23]}...)"
    return True, ""


def bundle_sha(envelope: dict) -> str:
    """Compute envelope-level sha for idempotency tracking (web.db.concept_imports)."""
    body = json.dumps(envelope, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def import_bundle(db_path: str, envelope: dict, conflict: str = "merge",
                  web_db_path: str | None = None) -> dict:
    """Replay envelope into the local knowledge graph.

    conflict modes:
      - skip:      existing (entity, attribute, value) wins; imported dropped.
      - merge:     duplicate triples skipped; new (attribute, value) inserted as new.
      - overwrite: retract conflicting active local triples, then assert imported.
    """
    from triplestore import TripleStore

    store = TripleStore(db_path)

    # Group imported triples by their source_tx so we preserve atomicity.
    # source_tx_id → list of (entity_id, attribute, value, value_type, retracted, valid_to, original_created_at)
    by_source_tx: dict[int, list[tuple]] = {}
    for ent in envelope.get("entities", []):
        eid = ent.get("id")
        for t in ent.get("triples", []):
            stx = int(t.get("tx_id") or 0)
            by_source_tx.setdefault(stx, []).append((
                eid,
                t["attribute"],
                t["value"],
                t.get("value_type", "string"),
                int(t.get("retracted", 0)),
                t.get("valid_to"),
                t.get("created_at"),
            ))

    inserted = 0
    skipped_dup = 0
    overwritten = 0
    tx_mapping: dict[int, int] = {}  # source_tx → new_tx

    for source_tx in sorted(by_source_tx.keys()):
        triples = by_source_tx[source_tx]

        # Begin one local tx per source tx (preserves grouping)
        new_tx = store.begin_tx(
            source="concept-import",
            metadata={"source_tx": source_tx, "bundle_root": envelope.get("root_entity")},
        )
        tx_mapping[source_tx] = new_tx

        for (eid, attr, value, value_type, retracted, valid_to, created_at) in triples:
            # Imported retracted triples → preserve retracted state. (They're
            # part of the bundle's audit trail.)
            if retracted:
                # Insert as retracted; valid_to stays as-is.
                # We use a direct INSERT to preserve the retracted flag — assert_triple
                # always sets retracted=0.
                store._conn.execute(
                    """INSERT INTO triples
                       (tx_id, entity_id, attribute, value, value_type, retracted, retracted_tx, valid_to, created_at)
                       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)""",
                    (new_tx, eid, attr, value, value_type, new_tx, valid_to, created_at or _iso_now()),
                )
                store._conn.execute(
                    "INSERT OR IGNORE INTO entity_types (entity_id, entity_type) VALUES (?, ?)",
                    (eid, eid.split(":", 1)[0] if ":" in eid else "unknown"),
                )
                inserted += 1
                continue

            # Active triple — apply conflict mode for (entity, attribute, value)
            existing = store._conn.execute(
                """SELECT id FROM triples WHERE entity_id = ? AND attribute = ?
                       AND value = ? AND retracted = 0 LIMIT 1""",
                (eid, attr, value),
            ).fetchone()

            if existing:
                # Exact triple already present
                if conflict == "skip" or conflict == "merge":
                    skipped_dup += 1
                    continue
                if conflict == "overwrite":
                    # Retract conflicting then insert imported
                    store.retract_triple(new_tx, eid, attr, value)
                    overwritten += 1

            # Insert
            store.assert_triple(new_tx, eid, attr, value, value_type=value_type)
            # Patch created_at to preserve source timeline (assert_triple uses now()).
            if created_at:
                store._conn.execute(
                    """UPDATE triples SET created_at = ?
                       WHERE tx_id = ? AND entity_id = ? AND attribute = ? AND value = ?
                       AND id = (SELECT MAX(id) FROM triples WHERE tx_id = ? AND entity_id = ? AND attribute = ? AND value = ?)""",
                    (created_at, new_tx, eid, attr, value, new_tx, eid, attr, value),
                )
            inserted += 1

        store._conn.commit()

    store.close()

    # Page cache reuse
    page_cached = False
    if web_db_path and envelope.get("rendered_page"):
        page = envelope["rendered_page"]
        # Map source tx_watermark to local — find max new_tx for facts in the bundle
        local_watermark = max(tx_mapping.values()) if tx_mapping else 0
        page["tx_watermark"] = local_watermark
        try:
            conn = sqlite3.connect(web_db_path)
            conn.execute(
                """INSERT OR REPLACE INTO page_cache
                   (entity_id, tx_watermark, page_json, generated_at, tokens_in, tokens_out, cost_usd)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    envelope["root_entity"],
                    local_watermark,
                    json.dumps(page, ensure_ascii=False),
                    int(time.time() * 1000),
                    (page.get("rendered_with") or {}).get("tokens_in"),
                    (page.get("rendered_with") or {}).get("tokens_out"),
                    (page.get("rendered_with") or {}).get("cost_usd"),
                ),
            )
            conn.commit()
            conn.close()
            page_cached = True
        except Exception as e:
            sys.stderr.write(f"page cache reuse failed: {e}\n")

    # Audit row in concept_imports
    if web_db_path:
        try:
            sha = bundle_sha(envelope)
            conn = sqlite3.connect(web_db_path)
            conn.execute(
                """INSERT INTO concept_imports
                   (imported_at, root_entity, source_tool, source_version, envelope_format,
                    bundle_sha256, conflict_mode, triples_count, redactions_seen, notes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    int(time.time() * 1000),
                    envelope["root_entity"],
                    (envelope.get("exporter") or {}).get("tool"),
                    (envelope.get("exporter") or {}).get("tool_version"),
                    envelope.get("format"),
                    sha,
                    conflict,
                    inserted,
                    json.dumps((envelope.get("redactions") or {}).get("applied", [])),
                    None,
                ),
            )
            conn.commit()
            conn.close()
        except Exception as e:
            sys.stderr.write(f"concept_imports log failed: {e}\n")

    return {
        "ok": True,
        "imported": True,
        "root_entity": envelope.get("root_entity"),
        "stats": {
            "entities_seen": len(envelope.get("entities", [])),
            "triples_inserted": inserted,
            "triples_skipped_duplicate": skipped_dup,
            "triples_overwritten": overwritten,
            "tx_mapping_count": len(tx_mapping),
        },
        "rendered_page_cached": page_cached,
        "view_url": f"/knowledge/ui/entity/{envelope.get('root_entity', '').replace(':', '%3A')}",
    }


def _iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def main() -> None:
    parser = argparse.ArgumentParser(description="Concept Import")
    parser.add_argument("--db", required=True)
    parser.add_argument("--bundle", required=True, help="Path to .sinain-concept.json (or - for stdin)")
    parser.add_argument("--web-db", default=None)
    parser.add_argument("--conflict", choices=["skip", "merge", "overwrite"], default="merge")
    args = parser.parse_args()

    if not Path(args.db).exists():
        # Auto-create empty knowledge DB on first import — receiver may have nothing yet.
        Path(args.db).parent.mkdir(parents=True, exist_ok=True)
        from triplestore import TripleStore
        TripleStore(args.db).close()

    if args.bundle == "-":
        envelope = json.load(sys.stdin)
    else:
        envelope = json.loads(Path(args.bundle).read_text(encoding="utf-8"))

    ok, err = verify_envelope(envelope)
    if not ok:
        print(json.dumps({"ok": False, "error": err}))
        sys.exit(1)

    result = import_bundle(args.db, envelope, conflict=args.conflict,
                          web_db_path=args.web_db)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
