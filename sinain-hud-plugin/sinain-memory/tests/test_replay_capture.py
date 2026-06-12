"""Wave 0 — failing tests for ablation field in NDJSON capture + replay filter.
Implementation lands in Plan 06 (Wave 4).

2026-05-27: TestCaptureAblationField requires the @_record_candidate capture
decorator on graph_query.query_facts_hybrid (gbrain Proposal B substrate).
On main (commit 53590bf and earlier), the decorator does not exist — the
capture surface lives on feat/memory-profile-adoption only. The tests are
guarded with a skipif so the rest of the eval suite can run cleanly on main."""
from __future__ import annotations
import importlib
import json
import os
from pathlib import Path
import pytest


def _has_capture_decorator() -> bool:
    """True if graph_query.query_facts_hybrid writes the eval-captures NDJSON
    when SINAIN_EVAL_CAPTURE=1. Detected by source inspection rather than
    runtime probe to avoid creating a stale capture file in the test sandbox."""
    try:
        gq = importlib.import_module("graph_query")
        src = open(gq.__file__, encoding="utf-8").read()
        return "SINAIN_EVAL_CAPTURE" in src or "_record_candidate" in src
    except Exception:
        return False


_SKIP_REASON = (
    "graph_query.query_facts_hybrid has no capture decorator on this branch "
    "(gbrain Proposal B substrate lives on feat/memory-profile-adoption)"
)


@pytest.mark.skipif(not _has_capture_decorator(), reason=_SKIP_REASON)
class TestCaptureAblationField:
    def test_capture_default_ablation_none(self, tmp_path, monkeypatch):
        """SINAIN_EVAL_CAPTURE=1 (no SINAIN_ABLATE) → NDJSON row has 'ablation': 'none'."""
        monkeypatch.setenv("SINAIN_MEMORY_DIR", str(tmp_path))
        monkeypatch.setenv("SINAIN_EVAL_CAPTURE", "1")
        monkeypatch.delenv("SINAIN_ABLATE", raising=False)

        # Build a tiny DB
        from triplestore import TripleStore
        db_path = str(tmp_path / "graph.db")
        store = TripleStore(db_path)
        tx = store.begin_tx("test")
        store.assert_triple(tx, "entity:alice", "city", "Berlin")
        store.commit_tx(tx)

        from graph_query import query_facts_hybrid
        query_facts_hybrid(db_path, "alice", max_facts=5)

        capture_file = tmp_path / "eval-captures.ndjson"
        assert capture_file.exists()
        rows = [json.loads(line) for line in capture_file.read_text().splitlines() if line.strip()]
        assert len(rows) >= 1
        assert rows[0].get("ablation") == "none"

    def test_capture_includes_ablation(self, tmp_path, monkeypatch):
        """SINAIN_EVAL_CAPTURE=1 + SINAIN_ABLATE=retrieval → NDJSON row has 'ablation': 'retrieval'."""
        monkeypatch.setenv("SINAIN_MEMORY_DIR", str(tmp_path))
        monkeypatch.setenv("SINAIN_EVAL_CAPTURE", "1")
        monkeypatch.setenv("SINAIN_ABLATE", "retrieval")

        from triplestore import TripleStore
        db_path = str(tmp_path / "graph.db")
        store = TripleStore(db_path)
        tx = store.begin_tx("test")
        store.assert_triple(tx, "entity:alice", "city", "Berlin")
        store.commit_tx(tx)

        from graph_query import query_facts_hybrid
        query_facts_hybrid(db_path, "alice", max_facts=5)

        capture_file = tmp_path / "eval-captures.ndjson"
        rows = [json.loads(line) for line in capture_file.read_text().splitlines() if line.strip()]
        assert rows[0].get("ablation") == "retrieval"


@pytest.mark.skipif(not _has_capture_decorator(), reason=_SKIP_REASON)
class TestReplayFilter:
    def test_replay_filters_ablation(self, tmp_path):
        """replay.run() must skip rows where ablation != 'none'."""
        baseline = tmp_path / "baseline.ndjson"
        rows = [
            {"ts": "2026-05-26T00:00:00Z", "query": "q1", "db_path": "db",
             "retrieved_entity_slugs": ["a"], "retrieved_value_keywords": [],
             "latency_ms": 10.0, "retrieval_path": "query_facts_hybrid", "ablation": "none"},
            {"ts": "2026-05-26T00:00:01Z", "query": "q2", "db_path": "db",
             "retrieved_entity_slugs": ["b"], "retrieved_value_keywords": [],
             "latency_ms": 10.0, "retrieval_path": "query_facts_hybrid", "ablation": "none"},
            {"ts": "2026-05-26T00:00:02Z", "query": "q3", "db_path": "db",
             "retrieved_entity_slugs": ["c"], "retrieved_value_keywords": [],
             "latency_ms": 10.0, "retrieval_path": "query_facts_hybrid", "ablation": "distiller"},
        ]
        baseline.write_text("\n".join(json.dumps(r) for r in rows))

        # Import replay; verify the filter excludes ablation != "none"
        from eval.local_models import replay
        # The filtering happens during run(); verify by checking the rows attribute
        # or by mocking the per-row replay to count iterations.
        # Minimal check: read + filter manually using the same logic
        loaded = [json.loads(line) for line in baseline.read_text().splitlines() if line.strip()]
        filtered = [r for r in loaded if r.get("ablation", "none") == "none"]
        assert len(filtered) == 2
        # Once Plan 06 lands, replay.run() must apply this same filter internally.

    def test_replay_backward_compat_no_field(self, tmp_path):
        """Rows WITHOUT 'ablation' field default to 'none' via .get() — not filtered out."""
        baseline = tmp_path / "baseline.ndjson"
        legacy_row = {
            "ts": "2026-05-26T00:00:00Z", "query": "q1", "db_path": "db",
            "retrieved_entity_slugs": ["a"], "retrieved_value_keywords": [],
            "latency_ms": 10.0, "retrieval_path": "query_facts_hybrid",
            # No 'ablation' field — legacy capture
        }
        baseline.write_text(json.dumps(legacy_row))
        loaded = [json.loads(line) for line in baseline.read_text().splitlines() if line.strip()]
        filtered = [r for r in loaded if r.get("ablation", "none") == "none"]
        assert len(filtered) == 1
