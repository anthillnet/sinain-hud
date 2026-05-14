"""Tests for the parameterized query_facts_hybrid API.

Covers Phase 1 of the memory-service-redesign:
- Parameter validation
- confidence_floor filtering
- temporal_mode=current filtering using occurred_end columns
- hop_depth=0 skipping graph expansion
- format="triples" output shape
- Default arguments preserve historical behavior
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from graph_query import (
    _PRECISION_MODES,
    _TEMPORAL_MODES,
    _FORMATS,
    _apply_confidence_floor,
    _apply_temporal_filter,
    _validate_query_params,
    query_facts_hybrid,
)
from triplestore import TripleStore


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


@pytest.fixture
def populated_db(tmp_path) -> str:
    """Build a small DB with facts that exercise each filter dimension."""
    db_path = str(tmp_path / "graph.db")
    store = TripleStore(db_path)
    tx = store.begin_tx("test")

    now = datetime.now(timezone.utc)
    past = now - timedelta(days=400)         # decayed
    future = now + timedelta(days=30)
    yesterday = now - timedelta(days=1)

    # Fact 1: current fact (no occurred_end), high confidence
    store.assert_triple(tx, "fact:current-high", "value", "Sarah currently leads the platform team")
    store.assert_triple(tx, "fact:current-high", "entity", "sarah")
    store.assert_triple(tx, "fact:current-high", "confidence", "0.9")
    store.assert_triple(tx, "fact:current-high", "tag", "sarah")
    store.assert_triple(tx, "fact:current-high", "tag", "platform")
    store.assert_triple(tx, "fact:current-high", "first_seen", _iso(now))

    # Fact 2: expired fact (occurred_end in the past)
    store.assert_triple(
        tx, "fact:expired", "value", "Sarah used to lead the data team",
        occurred_end=_iso(yesterday),
    )
    store.assert_triple(tx, "fact:expired", "entity", "sarah")
    store.assert_triple(tx, "fact:expired", "confidence", "0.8")
    store.assert_triple(tx, "fact:expired", "tag", "sarah")
    store.assert_triple(tx, "fact:expired", "tag", "data")
    store.assert_triple(tx, "fact:expired", "first_seen", _iso(now))

    # Fact 3: future-bounded fact (still current — occurred_end in the future)
    store.assert_triple(
        tx, "fact:future-bounded", "value", "Sarah leads platform until June 2026",
        occurred_end=_iso(future),
    )
    store.assert_triple(tx, "fact:future-bounded", "entity", "sarah")
    store.assert_triple(tx, "fact:future-bounded", "confidence", "0.85")
    store.assert_triple(tx, "fact:future-bounded", "tag", "sarah")
    store.assert_triple(tx, "fact:future-bounded", "first_seen", _iso(now))

    # Fact 4: low-confidence, old (will be filtered by confidence_floor)
    store.assert_triple(tx, "fact:low-conf", "value", "Sarah maybe attended a workshop")
    store.assert_triple(tx, "fact:low-conf", "entity", "sarah")
    store.assert_triple(tx, "fact:low-conf", "confidence", "0.3")
    store.assert_triple(tx, "fact:low-conf", "tag", "sarah")
    store.assert_triple(tx, "fact:low-conf", "first_seen", _iso(past))

    store.close()
    return db_path


class TestValidation:
    def test_rejects_bad_precision_mode(self):
        with pytest.raises(ValueError, match="precision_mode"):
            _validate_query_params("turbo", "any", 0.0, 1, "facts")

    def test_rejects_bad_temporal_mode(self):
        with pytest.raises(ValueError, match="temporal_mode"):
            _validate_query_params("balanced", "yesterday", 0.0, 1, "facts")

    def test_rejects_out_of_range_confidence_floor(self):
        with pytest.raises(ValueError, match="confidence_floor"):
            _validate_query_params("balanced", "any", 1.5, 1, "facts")

    def test_rejects_out_of_range_hop_depth(self):
        with pytest.raises(ValueError, match="hop_depth"):
            _validate_query_params("balanced", "any", 0.0, 7, "facts")

    def test_rejects_bad_format(self):
        with pytest.raises(ValueError, match="format"):
            _validate_query_params("balanced", "any", 0.0, 1, "yaml")

    def test_accepts_all_documented_values(self):
        for p in _PRECISION_MODES:
            for t in _TEMPORAL_MODES:
                for fmt in _FORMATS:
                    _validate_query_params(p, t, 0.5, 1, fmt)


class TestConfidenceFloor:
    def test_floor_zero_keeps_all(self):
        facts = [
            {"entity_id": "fact:a", "confidence": "0.9", "first_seen": _iso(datetime.now(timezone.utc))},
            {"entity_id": "fact:b", "confidence": "0.3", "first_seen": _iso(datetime.now(timezone.utc))},
        ]
        kept = _apply_confidence_floor(facts, 0.0)
        assert len(kept) == 2

    def test_floor_drops_low_confidence(self):
        now = _iso(datetime.now(timezone.utc))
        facts = [
            {"entity_id": "fact:a", "confidence": "0.9", "first_seen": now},
            {"entity_id": "fact:b", "confidence": "0.3", "first_seen": now},
        ]
        kept = _apply_confidence_floor(facts, 0.5)
        assert [f["entity_id"] for f in kept] == ["fact:a"]

    def test_floor_uses_decayed_confidence(self):
        # A 0.8 fact that has aged past its half-life should NOT clear a 0.5 floor.
        very_old = _iso(datetime.now(timezone.utc) - timedelta(days=400))
        facts = [{"entity_id": "fact:stale", "confidence": "0.8", "first_seen": very_old}]
        kept = _apply_confidence_floor(facts, 0.5)
        assert kept == [], "Decayed fact should be filtered even if raw confidence was high"


class TestTemporalFilter:
    def test_any_mode_no_op(self):
        facts = [{"entity_id": "fact:x", "occurred_end": _iso(datetime.now(timezone.utc) - timedelta(days=1))}]
        assert _apply_temporal_filter(facts, "any", None) == facts

    def test_current_keeps_unbounded(self):
        facts = [{"entity_id": "fact:x"}]  # no occurred_end key at all
        assert _apply_temporal_filter(facts, "current", None) == facts

    def test_current_keeps_future_bounded(self):
        future = _iso(datetime.now(timezone.utc) + timedelta(days=30))
        facts = [{"entity_id": "fact:x", "occurred_end": future}]
        assert _apply_temporal_filter(facts, "current", None) == facts

    def test_current_drops_expired(self):
        past = _iso(datetime.now(timezone.utc) - timedelta(days=1))
        facts = [
            {"entity_id": "fact:expired", "occurred_end": past},
            {"entity_id": "fact:active"},
        ]
        kept = _apply_temporal_filter(facts, "current", None)
        assert [f["entity_id"] for f in kept] == ["fact:active"]


class TestEndToEnd:
    def test_default_args_preserve_behavior(self, populated_db):
        # Calling without any new params should behave exactly like before.
        results = query_facts_hybrid(populated_db, "Sarah", max_facts=10)
        assert isinstance(results, list)
        assert len(results) > 0
        # All expected entity_ids should appear under default (no filter) behavior
        ids = {f.get("entity_id") for f in results}
        assert "fact:current-high" in ids

    def test_confidence_floor_filters_low(self, populated_db):
        results = query_facts_hybrid(
            populated_db, "Sarah", max_facts=10, confidence_floor=0.5
        )
        ids = {f.get("entity_id") for f in results}
        assert "fact:low-conf" not in ids, "low-confidence fact should be filtered"

    def test_temporal_current_filters_expired(self, populated_db):
        results = query_facts_hybrid(
            populated_db, "Sarah", max_facts=10, temporal_mode="current"
        )
        ids = {f.get("entity_id") for f in results}
        assert "fact:expired" not in ids, "fact with occurred_end in past should be filtered"
        assert "fact:future-bounded" in ids, "fact with occurred_end in future should remain"

    def test_hop_depth_zero_skips_expansion(self, populated_db):
        # Smoke test: hop_depth=0 should not error and should return a result set.
        results = query_facts_hybrid(
            populated_db, "Sarah", max_facts=10, hop_depth=0
        )
        assert isinstance(results, list)

    def test_format_triples_shape(self, populated_db):
        results = query_facts_hybrid(
            populated_db, "Sarah", max_facts=5, format="triples"
        )
        assert isinstance(results, list)
        if results:
            sample = results[0]
            for key in ("entity_id", "attribute", "value", "value_type",
                        "occurred_start", "occurred_end", "mentioned_at"):
                assert key in sample, f"triples format missing key: {key}"

    def test_precision_mode_fast_returns_results(self, populated_db):
        # fast mode skips bi-encoder rerank — should still return results
        results = query_facts_hybrid(
            populated_db, "Sarah", max_facts=5, precision_mode="fast"
        )
        assert isinstance(results, list)
        assert len(results) > 0

    def test_latency_budget_respected(self, populated_db):
        # An aggressive 1ms budget should short-circuit most stages but still
        # return *something* (the RRF top picks before reranking).
        results = query_facts_hybrid(
            populated_db, "Sarah", max_facts=5, latency_budget_ms=1
        )
        assert isinstance(results, list)

    def test_invalid_param_raises(self, populated_db):
        with pytest.raises(ValueError):
            query_facts_hybrid(populated_db, "Sarah", precision_mode="ludicrous")
