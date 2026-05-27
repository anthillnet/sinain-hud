---
phase: 01-eval-harness-paper-protocol-baseline
plan: 04
wave: 2
type: execute
status: complete
completed_at: 2026-05-27
requirements_satisfied: [EVAL-01]
---

# Plan 01-04 Summary — Ablation Stubs + Env-Var Dispatch

## What was built

5 new files in `sinain-hud-plugin/sinain-memory/eval/benchmarks/ablation/`:

- `__init__.py` — package init, documents `SINAIN_ABLATE` + `SINAIN_ABLATE_MODE` dispatch contract and D-03 schema deferral.
- `distiller_stub.py` — `build_stub_digest(transcript, mode, gold_facts)`. Passthrough emits one fact per transcript chunk verbatim; oracle adds gold_facts on top. Zero LLM cost.
- `integrator_stub.py` — `apply_stub_integration(memory_dir, digest, mode)`. Mechanically loops `digest["facts"]` and calls `triplestore.assert_triple` (confidence 0.8 passthrough / 1.0 oracle). Bypasses the LLM integrator subprocess entirely.
- `retrieval_stub.py` — `stub_retrieve(db_path, question, max_facts, mode, gold_keywords)`. Passthrough = first-N rows (insertion order, question-oblivious); oracle = case-insensitive LIKE filter on `value` column with bound parameters (no SQL injection surface).
- `schema_stub.py` — `apply_schema_stub` raises `NotImplementedError` with the D-03 Phase 5 deferral message. Reserved so the env-var route exists but loud-fails if called.

Dispatch wiring (single env-var read per site, Pattern S1):

- `eval/benchmarks/ingest.py:74-82` — `_content_hash` extended with `ablate_salt = SINAIN_ABLATE + ":" + SINAIN_ABLATE_MODE`. Ablated DBs cache-isolate from production cache keys.
- `eval/benchmarks/ingest.py:110-117` — `_run_script` env-forward extended to propagate `SINAIN_ABLATE`/`SINAIN_ABLATE_MODE` to child scripts.
- `eval/benchmarks/ingest.py:177-189` — distiller dispatch: `SINAIN_ABLATE=distiller` routes through `build_stub_digest`; else production `session_distiller.py` subprocess.
- `eval/benchmarks/ingest.py:200-205` — integrator dispatch: `SINAIN_ABLATE=integrator` routes through `apply_stub_integration` (and `continue`s past the production subprocess); else production `knowledge_integrator.py` subprocess.
- `eval/benchmarks/query.py:63-103` — `_query_knowledge` adds `gold_keywords` kwarg (default None; Plan 05 wires the caller). `SINAIN_ABLATE=retrieval` routes through `stub_retrieve`; else production `query_facts_hybrid`.

## Deviations / scope expansions

| File | Change | Rationale |
|------|--------|-----------|
| `sinain-hud-plugin/sinain-memory/triplestore.py` | Added no-op `commit_tx(tx_id)` alias method | The Wave 0 RED tests in `test_eval_ablation.py` and the plan's `integrator_stub.py` both call `store.commit_tx(tx)`, which did not exist. `assert_triple` already auto-commits per-statement, so the alias has zero production behavior change. Minimum-blast-radius fix. |
| `sinain-hud-plugin/sinain-memory/eval/benchmarks/config.py` | Restored 4 constants: `DISTILLER_TIMEOUT_S=30`, `INTEGRATOR_TIMEOUT_S=60`, `LONGMEMEVAL_HF`, `LOCOMO_GITHUB` | Wave 1's 01-03 agent recreated `config.py` from scratch with only what `evaluate.py` needed, omitting these. `ingest.py` imports broke as soon as Plan 04 imported it. Caught here, fixed in the same commit. |

Neither expansion was in the plan's `files_modified` declaration, but both are necessary correctness fixes — the plan was implementable only with these in place.

## Key files

| Path | Type | Notes |
|------|------|-------|
| `sinain-hud-plugin/sinain-memory/eval/benchmarks/ablation/__init__.py` | created | package init + dispatch docs |
| `sinain-hud-plugin/sinain-memory/eval/benchmarks/ablation/distiller_stub.py` | created | `build_stub_digest` |
| `sinain-hud-plugin/sinain-memory/eval/benchmarks/ablation/integrator_stub.py` | created | `apply_stub_integration` |
| `sinain-hud-plugin/sinain-memory/eval/benchmarks/ablation/retrieval_stub.py` | created | `stub_retrieve` |
| `sinain-hud-plugin/sinain-memory/eval/benchmarks/ablation/schema_stub.py` | created | `apply_schema_stub` (raises) |
| `sinain-hud-plugin/sinain-memory/eval/benchmarks/ingest.py` | modified | cache salt + 2 dispatch sites + env-forward |
| `sinain-hud-plugin/sinain-memory/eval/benchmarks/query.py` | modified | retrieval dispatch + gold_keywords kwarg |
| `sinain-hud-plugin/sinain-memory/eval/benchmarks/config.py` | modified | 4 constants restored |
| `sinain-hud-plugin/sinain-memory/triplestore.py` | modified | no-op `commit_tx` alias |

## Tests

- `tests/test_eval_ablation.py::TestStubModules` — 7/7 GREEN
- `tests/test_eval_ablation.py::TestDispatch` — 2/2 GREEN
- `tests/test_eval_ablation.py::TestE2ESubsetUnderAblation::test_e2e_subset_under_ablation` — deselected (requires `SINAIN_TEST_E2E=1`; manual gate runs in Plan 06)
- Wider regression: 109 passed, 1 skipped, 1 deselected across triplestore / judges / CI / report / extract_json / graph_query_params

## What this enables

Plan 01-05 (Wave 3) wires this dispatch into a `runner.py` CLI flag (`--ablate`) and builds the variance attribution orchestrator that loops over `{baseline, distiller-passthrough, distiller-oracle, integrator-passthrough, integrator-oracle, retrieval-passthrough, retrieval-oracle}` to produce the EVAL-02 variance report.

## Commits

- `e5cb519` — feat(01-04): ablation stub modules (5 files + triplestore.commit_tx alias)
- `c25d635` — feat(01-04): wire SINAIN_ABLATE env-var dispatch in ingest.py + query.py

## Self-Check: PASSED
