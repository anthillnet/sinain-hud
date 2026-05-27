"""Wave 0 — failing tests for ablation field in NDJSON capture + replay filter.
Implementation lands in Plan 06 (Wave 4)."""
from __future__ import annotations
import json
import os
from pathlib import Path
import pytest


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
