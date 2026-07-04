"""Convergence tests for memory_v2 (DESIGN-SHARED-MODULES step 2):
- ingest first_index (folded from ARSinain's fork)
- compact LLM routed through the portable sinain-llm shim (no `common` coupling)

Run: python3 -m unittest tests.test_memory_v2_convergence -v
(from sinain-hud-plugin/sinain-memory/). No network — sinain_llm is mocked.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

_MEM = Path(__file__).resolve().parents[1]
if str(_MEM) not in sys.path:
    sys.path.insert(0, str(_MEM))

from memory_v2 import EpisodeStore, ingest_sessions  # noqa: E402
from memory_v2 import llm as mem_llm  # noqa: E402


def _session(n, base_ts=0):
    return [{"source": "audio", "text": f"turn {i}", "ts": base_ts + i} for i in range(n)]


class TestIngestFirstIndex(unittest.TestCase):
    def _session_indices(self, store):
        return sorted({e.meta.get("session_index") for e in store.episodes
                       if e.meta.get("session_index") is not None})

    def test_default_start_zero(self):
        st = ingest_sessions([_session(3), _session(3)], context_id="t")
        self.assertEqual(self._session_indices(st), [0, 1])

    def test_first_index_offsets(self):
        st = ingest_sessions([_session(3)], context_id="t", first_index=5)
        self.assertEqual(self._session_indices(st), [5])

    def test_incremental_indices_stay_unique(self):
        # Live path: append one new session per connection into a long-lived store.
        st = EpisodeStore()
        ingest_sessions([_session(2)], context_id="t", store=st, first_index=0)
        ingest_sessions([_session(2)], context_id="t", store=st, first_index=1)
        ingest_sessions([_session(2)], context_id="t", store=st, first_index=2)
        self.assertEqual(self._session_indices(st), [0, 1, 2])  # no collisions


class TestCompactLLMDelegation(unittest.TestCase):
    def test_shim_delegates_to_sinain_llm(self):
        lib = mem_llm._resolve()  # resolves packages/sinain-llm from the repo root
        with mock.patch.object(lib, "call_llm", return_value="ok") as m:
            out = mem_llm.call_llm("sys", "user", "google/gemini-2.5-flash",
                                   max_tokens=3500, temperature=0.0, seed=42)
        self.assertEqual(out, "ok")
        self.assertEqual(m.call_args.args[2], "google/gemini-2.5-flash")
        self.assertEqual(m.call_args.kwargs, {"temperature": 0.0, "seed": 42})

    def test_compact_uses_the_shim_not_common(self):
        # _extract_session imports `from memory_v2.llm import call_llm`; patching
        # the shim must intercept the compaction LLM call.
        from memory_v2 import compact
        payload = '{"facts": [{"domain": "people", "subject": "Ann", "fact": "likes tea"}]}'
        with mock.patch.object(mem_llm, "call_llm", return_value=payload) as m:
            data = compact._extract_session("Ann likes tea.", "2026-07-04",
                                            "google/gemini-2.5-flash")
        self.assertTrue(m.called)
        self.assertIsInstance(data.get("facts"), list)


if __name__ == "__main__":
    unittest.main()
