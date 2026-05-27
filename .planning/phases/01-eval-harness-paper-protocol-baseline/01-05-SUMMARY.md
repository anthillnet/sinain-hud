---
phase: 01-eval-harness-paper-protocol-baseline
plan: 05
wave: 3
type: execute
status: complete
completed_at: 2026-05-27
requirements_satisfied: [EVAL-01, EVAL-02, EVAL-04]
---

# Plan 01-05 Summary — Variance-Attribution Orchestrator + Runner CLI + Bench Forwarding

## What was built

Three artifacts wire Plan 04's ablation stubs into a CLI surface, an N+1 variance-attribution loop, and a baseline-document writer.

**Tracked, committed:**

- `eval/benchmarks/runner.py` (450 lines, full rewrite) — argparse extended with `--judge-mode {paper, legacy}`, `--ablate {none,distiller,integrator,retrieval,schema}`, `--ablate-mode {passthrough,oracle}`, `--write-baseline`. `SINAIN_ABLATE`/`SINAIN_ABLATE_MODE` set/restored try/finally around `run_benchmark`. Paper-judge dispatch in the per-question scoring loop (`runner.py:199-213`): `judge_paper` populates `paper_label ∈ {0,1}`, sets `score=None` so the legacy aggregator skips cleanly. `aggregate_paper_results` builds the summary when `judge_mode == "paper"` (`runner.py:241-243`). D-03 guard at `runner.py:319-326`: `--ablate=schema` raises SystemExit with a clear deferral message BEFORE any LLM cost is spent. Pitfall-2 warning at `runner.py:329-335`: `--subset` without `--stratified` emits a stderr WARNING citing RESEARCH.md.
- `eval/benchmarks/ablation/variance_attribution.py` (339 lines, new) — three exports:
  - `run_variance_attribution(subset, stratified, output_dir)`: runs baseline + 3 subsystems × 2 modes = 7 conditions (schema deferred per D-03). For each ablation condition, computes paired-bootstrap delta CIs against baseline using shared `paired_bootstrap_delta_ci` from Plan 03. Emits markdown + JSON sidecar to `.planning/eval-internal/variance-attribution-<date>.{md,json}` per D-02.
  - `write_variance_report(summary, md_path, json_path)`: Pattern S4 atomic writes (tmp + replace). Markdown table cites the non-additive caveat (single-ablation marginal effects only, per D-04 — not Shapley).
  - `write_baseline(result, md_path, json_path)`: YAML front-matter (commit, branch, judge_model, qa_model, scoring_protocol, ablation=none, etc.) + body, with the D-07 DeepSeek-V4-Flash vs GPT-4o comparability footer.

**Local-only (gitignored eval/ tree, per project policy):**

- `eval/local_models/bench_longmemeval.py` (201 lines) — `run(...)` accepts `ablate`, `ablate_mode`, `judge_mode` kwargs. `_apply_candidate_env` sets `SINAIN_ABLATE`/`SINAIN_ABLATE_MODE` in the per-candidate env (`bench_longmemeval.py:83-84`); `_restore_env` restores prior values. Values recorded in `methodology` dict at `bench_longmemeval.py:190-192` so each baseline doc is self-describing.

## Deviations / scope expansions

None. Wave-0 RED tests for Plan 05 (`test_eval_variance.py` + `test_eval_baseline.py`, 8 cases) flipped to GREEN exactly as the plan declared. No constants needed restoring, no helper aliases inserted. The only "extra" inspection during execution was tracing why `bench_longmemeval.py` shows uncommitted — confirmed it lives under the gitignored `eval/` tree intentionally (eval artifacts stay local per the project gitignore comment at `.gitignore:96-101`).

## Key files

| Path | Type | Notes |
|------|------|-------|
| `sinain-hud-plugin/sinain-memory/eval/benchmarks/runner.py` | rewritten | CLI flags + paper-judge dispatch + D-03 schema guard + Pitfall-2 warning |
| `sinain-hud-plugin/sinain-memory/eval/benchmarks/ablation/variance_attribution.py` | created | N+1 orchestrator + report writer + baseline writer (atomic) |
| `sinain-hud-plugin/sinain-memory/eval/local_models/bench_longmemeval.py` | modified (local) | Forwards ablate/ablate_mode/judge_mode kwargs into `run_benchmark`; methodology dict captures the values |

## Tests

- `tests/test_eval_variance.py::TestVarianceReportFormat` — 4/4 GREEN (`test_report_format`, `test_full_table_rows_excluding_schema`, `test_json_sidecar_matches_md`, `test_report_documents_non_additive_caveat`)
- `tests/test_eval_baseline.py::TestBaselineDocSchema` — 4/4 GREEN (`test_baseline_doc_schema`, `test_baseline_json_sidecar_present`, `test_baseline_documents_judge_tradeoff_footer`, `test_baseline_atomic_write`)
- Wider regression sweep (`pytest tests/`): 396 passed, 2 skipped. 11 RED, classified:
  - 2 in `test_replay_capture.py::TestCaptureAblationField` — **intentional Plan-06 Wave-0 RED** (tests for the ablation field that `@_record_candidate` will write in Plan 06). Not a regression.
  - 9 in `test_feedback_computation.py`, `test_miner_helpers.py`, `test_tick_evaluator.py` — **pre-existing**. Last touched by commit `d91c0c5` (escalation slot work), which predates Plan 05. Neither Plan 05 commit (`b9d6b55`, `f0d366e`) touches those files. Not in scope to fix here; flag for separate triage.

## What this enables

Plan 01-06 (Wave 4) wires the NDJSON ablation field through `@_record_candidate` in `graph_query.py` (flipping the 2 RED `test_replay_capture` cases to GREEN), filters ablated rows out of `replay.py` so the existing replay-drift CI gate isn't polluted, hardens `memory-replay-check.sh` against accidentally capturing under ablation, then spends ~$1-2 of OpenRouter (DeepSeek-V4-Flash) budget running the full LongMemEval-S paper-judge baseline. That run produces `.planning/eval-internal/BASELINE-2026-05-26.md` (the EVAL-04 milestone-reference artifact and the gating deliverable for the whole v2.0 milestone).

## Commits

- `b9d6b55` — feat(01-05): variance_attribution.py — orchestrator + report + baseline writers (339 insertions)
- `f0d366e` — feat(01-05): extend runner.py with judge-mode / ablate / write-baseline flags (450 insertions)
- (pending) — docs(01-05): SUMMARY — variance-attribution + runner CLI + baseline writers
- `bench_longmemeval.py` changes carried as local-only file per `.gitignore:101` policy (eval artifacts stay local)

## Self-Check: PASSED

- ☑ Wave-0 tests for Plan 05 GREEN (8/8)
- ☑ All 10 `must_haves.truths` from PLAN.md verified in code
- ☑ Three artifacts in tree (2 committed, 1 intentionally local per gitignore policy)
- ☑ No production regressions introduced — the 11 RED tests in the wider sweep are either pre-existing or intentional Plan-06 RED
- ☑ Locked decisions encoded: D-01 (DeepSeek-V4-Flash judge default), D-02 (output to `.planning/eval-internal/`), D-03 (schema deferred with loud SystemExit), D-04 (marginal effects, not Shapley — non-additive caveat in report), D-07 (judge comparability footer)
