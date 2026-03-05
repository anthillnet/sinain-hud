"""Tests for triplestore.py — EAV triple store."""

import os
import pytest
from triplestore import TripleStore


@pytest.fixture
def store(tmp_path):
    """Create a fresh triple store in a temp directory."""
    db_path = tmp_path / "test.db"
    s = TripleStore(str(db_path))
    yield s
    s.close()


@pytest.fixture
def populated_store(store):
    """Store with sample data across two transactions."""
    tx1 = store.begin_tx("test", session_key="sess-1")
    store.assert_triple(tx1, "signal:2026-03-01T10:00", "description", "OCR stall")
    store.assert_triple(tx1, "signal:2026-03-01T10:00", "priority", "high")
    store.assert_triple(tx1, "signal:2026-03-01T10:00", "related_to", "concept:ocr", "ref")
    store.assert_triple(tx1, "concept:ocr", "name", "OCR")
    store.assert_triple(tx1, "pattern:frame-batch", "text", "Frame batching improves OCR")
    store.assert_triple(tx1, "pattern:frame-batch", "related_to", "concept:ocr", "ref")
    store.assert_triple(tx1, "session:2026-03-01T09:00", "summary", "Debugging OCR pipeline")
    store.assert_triple(tx1, "session:2026-03-01T09:00", "related_to", "concept:ocr", "ref")
    store._tx1 = tx1  # stash for tests
    return store


class TestTransactions:
    def test_begin_tx_returns_positive_id(self, store):
        tx = store.begin_tx("test")
        assert tx > 0

    def test_latest_tx_empty_store(self, tmp_path):
        s = TripleStore(str(tmp_path / "empty.db"))
        assert s.latest_tx() == 0
        s.close()

    def test_latest_tx_after_writes(self, store):
        tx1 = store.begin_tx("a")
        tx2 = store.begin_tx("b")
        assert store.latest_tx() == tx2
        assert tx2 > tx1

    def test_tx_metadata(self, store):
        tx = store.begin_tx("test", metadata={"foo": "bar"})
        row = store._conn.execute(
            "SELECT metadata FROM transactions WHERE tx_id = ?", (tx,)
        ).fetchone()
        import json
        assert json.loads(row["metadata"]) == {"foo": "bar"}

    def test_tx_parent(self, store):
        tx1 = store.begin_tx("parent")
        tx2 = store.begin_tx("child", parent_tx=tx1)
        row = store._conn.execute(
            "SELECT parent_tx FROM transactions WHERE tx_id = ?", (tx2,)
        ).fetchone()
        assert row["parent_tx"] == tx1


class TestAssertAndEntity:
    def test_assert_returns_id(self, store):
        tx = store.begin_tx("test")
        tid = store.assert_triple(tx, "e:1", "name", "Test")
        assert tid > 0

    def test_entity_returns_all_attrs(self, populated_store):
        ent = populated_store.entity("signal:2026-03-01T10:00")
        assert ent["description"] == ["OCR stall"]
        assert ent["priority"] == ["high"]
        assert ent["related_to"] == ["concept:ocr"]

    def test_entity_missing_returns_empty(self, store):
        assert store.entity("nonexistent:1") == {}

    def test_multiple_values_per_attr(self, store):
        tx = store.begin_tx("test")
        store.assert_triple(tx, "e:1", "tag", "alpha")
        store.assert_triple(tx, "e:1", "tag", "beta")
        ent = store.entity("e:1")
        assert set(ent["tag"]) == {"alpha", "beta"}

    def test_entity_type_auto_populated(self, store):
        tx = store.begin_tx("test")
        store.assert_triple(tx, "signal:abc", "x", "y")
        row = store._conn.execute(
            "SELECT entity_type FROM entity_types WHERE entity_id = ?",
            ("signal:abc",),
        ).fetchone()
        assert row["entity_type"] == "signal"


class TestRetraction:
    def test_retract_by_attr(self, populated_store):
        tx2 = populated_store.begin_tx("retract")
        count = populated_store.retract_triple(tx2, "signal:2026-03-01T10:00", "priority")
        assert count == 1
        ent = populated_store.entity("signal:2026-03-01T10:00")
        assert "priority" not in ent

    def test_retract_by_attr_and_value(self, store):
        tx = store.begin_tx("test")
        store.assert_triple(tx, "e:1", "tag", "a")
        store.assert_triple(tx, "e:1", "tag", "b")
        tx2 = store.begin_tx("retract")
        count = store.retract_triple(tx2, "e:1", "tag", "a")
        assert count == 1
        ent = store.entity("e:1")
        assert ent["tag"] == ["b"]

    def test_retract_nonexistent_returns_zero(self, store):
        tx = store.begin_tx("test")
        count = store.retract_triple(tx, "e:nope", "attr")
        assert count == 0


class TestEAVTAsOfTx:
    def test_as_of_tx_sees_old_state(self, populated_store):
        tx1 = populated_store._tx1
        tx2 = populated_store.begin_tx("change")
        populated_store.retract_triple(tx2, "signal:2026-03-01T10:00", "priority")

        # Current state: no priority
        assert "priority" not in populated_store.entity("signal:2026-03-01T10:00")
        # as_of tx1: has priority
        assert "priority" in populated_store.entity("signal:2026-03-01T10:00", as_of_tx=tx1)


class TestAEVT:
    def test_entities_with_attr(self, populated_store):
        results = populated_store.entities_with_attr("name")
        assert ("concept:ocr", "OCR") in results

    def test_entities_with_attr_multiple(self, populated_store):
        results = populated_store.entities_with_attr("related_to")
        eids = [r[0] for r in results]
        assert "signal:2026-03-01T10:00" in eids
        assert "pattern:frame-batch" in eids


class TestVAET:
    def test_backrefs(self, populated_store):
        refs = populated_store.backrefs("concept:ocr")
        eids = [r[0] for r in refs]
        assert "signal:2026-03-01T10:00" in eids
        assert "pattern:frame-batch" in eids
        assert "session:2026-03-01T09:00" in eids

    def test_backrefs_with_attribute_filter(self, populated_store):
        refs = populated_store.backrefs("concept:ocr", attribute="related_to")
        eids = [r[0] for r in refs]
        assert "signal:2026-03-01T10:00" in eids

    def test_backrefs_no_results(self, store):
        assert store.backrefs("nonexistent:1") == []


class TestAVET:
    def test_lookup(self, populated_store):
        found = populated_store.lookup("name", "OCR")
        assert "concept:ocr" in found

    def test_lookup_no_match(self, populated_store):
        found = populated_store.lookup("name", "nonexistent")
        assert found == []


class TestNeighbors:
    def test_neighbors_depth_1(self, populated_store):
        nbrs = populated_store.neighbors("concept:ocr", depth=1)
        assert "concept:ocr" in nbrs
        # Should find signal, pattern, and session via backrefs
        found_eids = set(nbrs.keys())
        assert "signal:2026-03-01T10:00" in found_eids or "pattern:frame-batch" in found_eids

    def test_neighbors_depth_0(self, populated_store):
        nbrs = populated_store.neighbors("concept:ocr", depth=0)
        assert "concept:ocr" in nbrs
        assert len(nbrs) == 1  # only the entity itself


class TestNovelty:
    def test_novelty_after_tx(self, populated_store):
        tx1 = populated_store._tx1
        tx2 = populated_store.begin_tx("new")
        populated_store.assert_triple(tx2, "concept:new", "name", "New Concept")
        changes = populated_store.novelty(tx1)
        assert len(changes) >= 1
        assert any(c["entity_id"] == "concept:new" for c in changes)

    def test_novelty_bounded(self, populated_store):
        tx1 = populated_store._tx1
        tx2 = populated_store.begin_tx("a")
        populated_store.assert_triple(tx2, "concept:a", "name", "A")
        tx3 = populated_store.begin_tx("b")
        populated_store.assert_triple(tx3, "concept:b", "name", "B")
        # Only changes between tx1 and tx2
        changes = populated_store.novelty(tx1, until_tx=tx2)
        eids = [c["entity_id"] for c in changes]
        assert "concept:a" in eids
        assert "concept:b" not in eids

    def test_novelty_empty(self, store):
        tx = store.begin_tx("test")
        assert store.novelty(tx) == []


class TestGC:
    def test_gc_deletes_old_retracted(self, store):
        tx = store.begin_tx("test")
        store.assert_triple(tx, "e:1", "x", "y")
        tx2 = store.begin_tx("retract")
        store.retract_triple(tx2, "e:1", "x")
        # GC with 0 days should delete it
        count = store.gc(older_than_days=0)
        assert count >= 1

    def test_gc_preserves_active(self, store):
        tx = store.begin_tx("test")
        store.assert_triple(tx, "e:1", "x", "y")
        count = store.gc(older_than_days=0)
        assert count == 0  # not retracted, shouldn't be deleted


class TestStats:
    def test_stats_populated(self, populated_store):
        s = populated_store.stats()
        assert s["triples"] >= 8
        assert s["entities"] >= 4
        assert s["transactions"] >= 1
        assert s["db_size_bytes"] > 0

    def test_stats_empty(self, store):
        s = store.stats()
        assert s["triples"] == 0
        assert s["entities"] == 0
        assert s["transactions"] == 0


class TestWALMode:
    def test_wal_mode_enabled(self, store):
        mode = store._conn.execute("PRAGMA journal_mode").fetchone()[0]
        assert mode == "wal"
