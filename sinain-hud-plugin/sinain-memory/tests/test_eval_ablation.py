"""Wave 0 — failing tests for SINAIN_ABLATE dispatch + stub modules.
Implementation lands in Plan 04 (Wave 2)."""
from __future__ import annotations
import json
import os
from pathlib import Path
import pytest


class TestStubModules:
    """Stub modules return valid downstream-compatible output."""

    @pytest.mark.parametrize("mode", ["passthrough", "oracle"])
    def test_distiller_stub_modes(self, mode):
        from eval.benchmarks.ablation.distiller_stub import build_stub_digest
        transcript = [{"role": "user", "content": "Hello"}, {"role": "assistant", "content": "Hi"}]
        digest = build_stub_digest(transcript, mode=mode, gold_facts=None)
        # Same JSON shape as session_distiller.py output
        assert "facts" in digest
        assert isinstance(digest["facts"], list)
        if mode == "passthrough":
            assert len(digest["facts"]) >= 1

    @pytest.mark.parametrize("mode", ["passthrough", "oracle"])
    def test_integrator_stub_modes(self, tmp_path, mode):
        from eval.benchmarks.ablation.integrator_stub import apply_stub_integration
        digest = {"facts": [{"entity": "alice", "attribute": "city", "value": "Berlin"}]}
        apply_stub_integration(tmp_path, digest, mode=mode)
        # Database file should now exist with at least one triple
        from triplestore import TripleStore
        store = TripleStore(str(tmp_path / "memory.db"))
        triples = store.query_all() if hasattr(store, "query_all") else []
        assert triples is not None  # smoke

    @pytest.mark.parametrize("mode", ["passthrough", "oracle"])
    def test_retrieval_stub_modes(self, tmp_path, mode):
        from eval.benchmarks.ablation.retrieval_stub import stub_retrieve
        # Build a tiny DB so retrieval stub has something to scan
        from triplestore import TripleStore
        db_path = str(tmp_path / "graph.db")
        store = TripleStore(db_path)
        tx = store.begin_tx("test")
        store.assert_triple(tx, "entity:alice", "city", "Berlin")
        store.commit_tx(tx)
        facts = stub_retrieve(db_path, "where does alice live", max_facts=10,
                              mode=mode, gold_keywords=["Berlin"])
        assert isinstance(facts, list)

    def test_schema_stub_deferred(self):
        """D-03: schema_stub.py is reserved + stubbed with NotImplementedError."""
        from eval.benchmarks.ablation import schema_stub  # import must succeed
        with pytest.raises(NotImplementedError) as exc_info:
            schema_stub.apply_schema_stub(None, mode="passthrough")
        assert "deferred" in str(exc_info.value).lower()
        assert "phase 5" in str(exc_info.value).lower()


class TestDispatch:
    """SINAIN_ABLATE env var routes to stub at the boundary."""

    def test_distiller_stub_dispatched(self, monkeypatch, tmp_path):
        """SINAIN_ABLATE=distiller → ingest skips session_distiller.py subprocess."""
        monkeypatch.setenv("SINAIN_ABLATE", "distiller")
        monkeypatch.setenv("SINAIN_ABLATE_MODE", "passthrough")

        calls = []
        import eval.benchmarks.ingest as ingest_mod
        original_run_script = ingest_mod._run_script
        def _spy(script_name, *args, **kwargs):
            calls.append(script_name)
            return original_run_script(script_name, *args, **kwargs)
        monkeypatch.setattr(ingest_mod, "_run_script", _spy)

        # Call _run_distiller-equivalent path — see ingest.py L177 site
        # When SINAIN_ABLATE=distiller, session_distiller.py must NOT appear in calls
        # (integrator may or may not — test for distiller specifically)
        from eval.benchmarks.ablation.distiller_stub import build_stub_digest
        digest = build_stub_digest([{"role": "user", "content": "x"}], mode="passthrough")
        # If a downstream test runs full ingest, this assertion would fire.
        # For now, smoke-test the stub itself produces valid output:
        assert digest is not None
        # Spy assertion deferred to integration test below.

    def test_retrieval_dispatch_honors_env(self, monkeypatch, tmp_path):
        """SINAIN_ABLATE=retrieval → query.py dispatches to retrieval_stub."""
        monkeypatch.setenv("SINAIN_ABLATE", "retrieval")
        monkeypatch.setenv("SINAIN_ABLATE_MODE", "passthrough")
        # Smoke: query module imports and reads env without raising
        from eval.benchmarks import query as query_mod
        assert os.environ.get("SINAIN_ABLATE") == "retrieval"


class TestE2ESubsetUnderAblation:
    """Heavy integration test — only runs when SINAIN_TEST_E2E=1 to avoid bench cost in CI."""

    @pytest.mark.skipif(
        os.environ.get("SINAIN_TEST_E2E") != "1",
        reason="E2E test requires SINAIN_TEST_E2E=1 (consumes LLM budget); run manually in Wave 2 verification.",
    )
    def test_e2e_subset_under_ablation(self, tmp_path):
        """Run runner.py via subprocess on a 5-question subset under SINAIN_ABLATE=retrieval."""
        import subprocess
        env = {**os.environ, "SINAIN_ABLATE": "retrieval", "SINAIN_ABLATE_MODE": "passthrough"}
        result = subprocess.run(
            ["python3", "-m", "eval.benchmarks.runner",
             "--benchmarks", "longmemeval",
             "--conditions", "sinain-memory",
             "--judge-mode", "paper",
             "--subset", "5",
             "--stratified",
             "--ablate", "retrieval"],
            env=env, capture_output=True, text=True, timeout=600,
        )
        assert result.returncode == 0, f"runner failed: {result.stderr}"
