"""Tests for Phase 2 of the memory-service-redesign:
- Distiller fact-item unpacking (both legacy string and new object shape)
- Temporal fields propagated through _facts_to_graph_ops to assert_triple
- Entity aliases recorded in entity_aliases
- Entity cooccurrence pairs recorded in entity_cooccurrence
- touch_mention called on reinforce
- _looks_consolidated heuristic
- _consolidate_entity_facts(use_llm=False) is a no-op
"""

from __future__ import annotations

import pytest

from knowledge_integrator import (
    _consolidate_entity_facts,
    _execute_graph_ops,
    _facts_to_graph_ops,
    _looks_consolidated,
    _unpack_fact_item,
)
from triplestore import TripleStore


class TestUnpackFactItem:
    def test_legacy_string(self):
        text, occ_start, occ_end = _unpack_fact_item("Sarah leads platform")
        assert text == "Sarah leads platform"
        assert occ_start is None
        assert occ_end is None

    def test_new_object_no_temporal(self):
        text, occ_start, occ_end = _unpack_fact_item({"text": "Sarah leads platform"})
        assert text == "Sarah leads platform"
        assert occ_start is None
        assert occ_end is None

    def test_new_object_with_start(self):
        text, occ_start, occ_end = _unpack_fact_item({
            "text": "Sarah is CTO",
            "occurredStart": "2024-01-15",
        })
        assert text == "Sarah is CTO"
        assert occ_start == "2024-01-15"
        assert occ_end is None

    def test_new_object_bounded(self):
        text, occ_start, occ_end = _unpack_fact_item({
            "text": "Sarah was CTO 2020-2023",
            "occurredStart": "2020-01-01",
            "occurredEnd": "2023-12-31",
        })
        assert occ_start == "2020-01-01"
        assert occ_end == "2023-12-31"

    def test_object_with_value_key_fallback(self):
        # Tolerate "value" alongside "text" — distiller variants have used both
        text, _, _ = _unpack_fact_item({"value": "fallback shape"})
        assert text == "fallback shape"

    def test_invalid_shapes_return_empty(self):
        assert _unpack_fact_item(None) == ("", None, None)
        assert _unpack_fact_item(123) == ("", None, None)
        assert _unpack_fact_item([]) == ("", None, None)


class TestFactsToGraphOps:
    def test_string_fact_produces_op_without_temporal(self):
        digest = {
            "facts": ["Sarah leads platform"],
            "entities": [{"name": "sarah", "type": "person"}],
            "ts": "2026-05-14T10:00:00",
        }
        ops = _facts_to_graph_ops(digest)
        fact_ops = [o for o in ops if o.get("kind") == "distilled" and o.get("value") == "Sarah leads platform"]
        assert len(fact_ops) == 1
        assert "occurred_start" not in fact_ops[0]
        assert "occurred_end" not in fact_ops[0]

    def test_object_fact_with_temporal_propagates(self):
        digest = {
            "facts": [{
                "text": "Sarah was CTO at Acme from 2020 to 2023",
                "occurredStart": "2020-01-01",
                "occurredEnd": "2023-12-31",
            }],
            "entities": [{"name": "sarah", "type": "person"}],
            "ts": "2026-05-14T10:00:00",
        }
        ops = _facts_to_graph_ops(digest)
        fact_op = next(o for o in ops if "CTO at Acme" in o.get("value", ""))
        assert fact_op["occurred_start"] == "2020-01-01"
        assert fact_op["occurred_end"] == "2023-12-31"

    def test_decisions_also_support_temporal_objects(self):
        digest = {
            "facts": [],
            "decisions": [{
                "text": "Ship feature by end of month",
                "occurredStart": "2026-05-14",
            }],
            "entities": [],
            "ts": "2026-05-14T10:00:00",
        }
        ops = _facts_to_graph_ops(digest)
        dec_op = next(o for o in ops if "Ship feature" in o.get("value", ""))
        assert dec_op["occurred_start"] == "2026-05-14"
        assert dec_op["confidence"] == 0.7  # decisions get lower confidence

    def test_mixed_shapes_in_same_digest(self):
        digest = {
            "facts": [
                "old-style string fact",
                {"text": "new-style object fact", "occurredStart": "2026-01-01"},
            ],
            "entities": [],
            "ts": "2026-05-14T10:00:00",
        }
        ops = _facts_to_graph_ops(digest)
        old_op = next(o for o in ops if "old-style" in o.get("value", ""))
        new_op = next(o for o in ops if "new-style" in o.get("value", ""))
        assert "occurred_start" not in old_op
        assert new_op["occurred_start"] == "2026-01-01"


class TestExecuteGraphOps:
    def test_temporal_columns_written_to_db(self, tmp_path):
        db_path = str(tmp_path / "graph.db")
        ops = [{
            "op": "assert",
            "entity": "sarah",
            "attribute": "value",
            "value": "Sarah was CTO 2020-2023",
            "confidence": 0.9,
            "kind": "distilled",
            "occurred_start": "2020-01-01",
            "occurred_end": "2023-12-31",
        }]
        _execute_graph_ops(db_path, ops, "2026-05-14T10:00:00Z", digest_entities=[])

        store = TripleStore(db_path)
        # Find the value triple for this fact
        rows = store._conn.execute(
            "SELECT entity_id, occurred_start, occurred_end FROM triples "
            "WHERE attribute = 'value' AND value LIKE 'Sarah was CTO%' AND retracted = 0"
        ).fetchall()
        assert len(rows) == 1
        assert rows[0]["occurred_start"] == "2020-01-01"
        assert rows[0]["occurred_end"] == "2023-12-31"
        store.close()

    def test_facts_without_temporal_get_null_columns(self, tmp_path):
        db_path = str(tmp_path / "graph.db")
        ops = [{
            "op": "assert",
            "entity": "sarah",
            "attribute": "value",
            "value": "Sarah leads platform",
            "confidence": 0.9,
            "kind": "distilled",
        }]
        _execute_graph_ops(db_path, ops, "2026-05-14T10:00:00Z", digest_entities=[])

        store = TripleStore(db_path)
        row = store._conn.execute(
            "SELECT occurred_start, occurred_end FROM triples "
            "WHERE attribute = 'value' AND value = 'Sarah leads platform'"
        ).fetchone()
        assert row["occurred_start"] is None
        assert row["occurred_end"] is None
        store.close()

    def test_aliases_recorded(self, tmp_path):
        db_path = str(tmp_path / "graph.db")
        ops = [{
            "op": "assert",
            "entity": "sarah-chen",
            "attribute": "value",
            "value": "Sarah Chen is the CEO of Acme",
            "confidence": 0.9,
            "kind": "distilled",
        }]
        entities = [{
            "name": "sarah-chen",
            "type": "person",
            "aliases": ["Sarah", "the CEO", "Sarah Chen"],
        }]
        _execute_graph_ops(db_path, ops, "2026-05-14T10:00:00Z", digest_entities=entities)

        store = TripleStore(db_path)
        all_aliases = store.aliases_of("entity:sarah-chen")
        # Aliases are stored lowercased
        assert "sarah" in all_aliases
        assert "the ceo" in all_aliases
        assert "sarah chen" in all_aliases

        # Reverse lookup
        resolved = store.resolve_alias("the CEO")
        assert resolved and resolved[0][0] == "entity:sarah-chen"
        store.close()

    def test_cooccurrence_pairs_recorded(self, tmp_path):
        db_path = str(tmp_path / "graph.db")
        ops = [{
            "op": "assert",
            "entity": "sarah",
            "attribute": "value",
            "value": "Sarah works at Acme on project-x",
            "confidence": 0.9,
            "kind": "distilled",
        }]
        entities = [
            {"name": "sarah-chen", "type": "person"},
            {"name": "acme-corp", "type": "org"},
            {"name": "project-x", "type": "project"},
        ]
        _execute_graph_ops(db_path, ops, "2026-05-14T10:00:00Z", digest_entities=entities)

        store = TripleStore(db_path)
        cooc = store.cooccurring("entity:sarah-chen")
        cooc_dict = dict(cooc)
        assert "entity:acme-corp" in cooc_dict
        assert "entity:project-x" in cooc_dict
        # Other pair too
        cooc_acme = dict(store.cooccurring("entity:acme-corp"))
        assert "entity:project-x" in cooc_acme
        store.close()

    def test_reinforce_touches_mention(self, tmp_path):
        db_path = str(tmp_path / "graph.db")
        # First, assert a fact
        first_ops = [{
            "op": "assert",
            "entity": "sarah",
            "attribute": "value",
            "value": "Sarah leads platform",
            "confidence": 0.7,
            "kind": "distilled",
        }]
        _execute_graph_ops(db_path, first_ops, "2026-05-14T10:00:00Z")

        store = TripleStore(db_path)
        # Find the fact's entity_id
        row = store._conn.execute(
            "SELECT entity_id, mentioned_at FROM triples "
            "WHERE attribute = 'value' AND value = 'Sarah leads platform'"
        ).fetchone()
        fact_eid = row["entity_id"]
        mentioned_before = row["mentioned_at"]
        store.close()

        import time as _time
        _time.sleep(0.01)

        # Now reinforce it
        reinforce_ops = [{"op": "reinforce", "entityId": fact_eid}]
        _execute_graph_ops(db_path, reinforce_ops, "2026-05-14T10:05:00Z")

        store = TripleStore(db_path)
        row_after = store._conn.execute(
            "SELECT mentioned_at FROM triples "
            "WHERE entity_id = ? AND attribute = 'value' AND retracted = 0",
            (fact_eid,),
        ).fetchone()
        assert row_after["mentioned_at"] > mentioned_before, "mentioned_at should advance on reinforce"
        store.close()


class TestConsolidationHeuristic:
    def test_looks_consolidated_legacy_shape(self):
        # Legacy: long string with multiple "; " separators
        val = "claim one; claim two; claim three; claim four with lots of detail to push past 200 chars" * 3
        assert _looks_consolidated(val) is True

    def test_looks_consolidated_state_evolution(self):
        assert _looks_consolidated("Used to lead the data team; now leads platform") is True

    def test_looks_consolidated_time_range(self):
        assert _looks_consolidated("Sarah was CTO at Acme from 2020 to 2023") is True

    def test_normal_fact_not_consolidated(self):
        assert _looks_consolidated("Sarah leads the platform team") is False
        assert _looks_consolidated("Short fact") is False


class TestConsolidationNoOp:
    def test_use_llm_false_is_noop_even_with_many_facts(self, tmp_path):
        db_path = str(tmp_path / "graph.db")
        # Build a DB with 4 facts about the same entity — would normally trigger consolidation
        store = TripleStore(db_path)
        tx = store.begin_tx("test")
        for i in range(4):
            eid = f"fact:sarah-{i:03d}"
            store.assert_triple(tx, eid, "entity", "sarah")
            store.assert_triple(tx, eid, "attribute", "value")
            store.assert_triple(tx, eid, "value", f"Sarah fact number {i}")
        store.close()

        # use_llm=False should be a no-op
        result = _consolidate_entity_facts(db_path, min_facts=3, use_llm=False)
        assert result == 0

        # Originals should be untouched
        store = TripleStore(db_path)
        active_count = store._conn.execute(
            "SELECT COUNT(*) FROM triples WHERE attribute = 'value' AND retracted = 0"
        ).fetchone()[0]
        assert active_count == 4
        store.close()
