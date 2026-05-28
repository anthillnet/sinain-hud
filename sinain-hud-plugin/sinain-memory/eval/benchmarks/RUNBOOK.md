# LongMemEval Bench Runbook

How sinain runs the LongMemEval-S benchmark against its memory pipeline.
Local-only file (the entire `eval/benchmarks/` tree is gitignored per
`feedback_memory_eval_local_only.md`).

## What this measures

- **Dataset**: `eval/benchmarks/data/longmemeval/longmemeval_s_cleaned.json`
  — 500 instances × 1 question each. Each instance has 30-60 prior
  "sessions" (multi-turn dialogs); ONE of those sessions contains the
  answer to the question.
- **Bench flow**: distill each session into facts via session_distiller
  → integrate into the per-instance RDF graph via knowledge_integrator
  → at question time, query the graph via graph_query.query_facts_hybrid
  → answer via the QA model (gemini-2.5-flash) → judge (gpt-4o-2024-08-06,
  paper-aligned binary).
- **Output**: paper_label (1 = correct, 0 = incorrect), f1, content_recall@k.

## Quick-start invocations

All commands run from `sinain-hud-plugin/sinain-memory/`. Env vars first.

```bash
cd /Users/Igor.Gerasimov/IdeaProjects/sinain-hud
set -a && source .env && set +a    # exports OPENROUTER_API_KEY etc
cd sinain-hud-plugin/sinain-memory
```

### Cloud baseline (default — gemini-2.5-flash distiller)

```bash
python3 eval/benchmarks/runner.py \
    --benchmarks longmemeval \
    --conditions sinain-memory \
    --subset 2 \
    --output-dir eval/benchmarks/results/cloud-baseline
```

### Local distiller (Ollama)

```bash
SINAIN_BENCH_MODEL=ollama/phi4-mini:latest \
python3 eval/benchmarks/runner.py \
    --benchmarks longmemeval \
    --conditions sinain-memory \
    --subset 2 \
    --output-dir eval/benchmarks/results/phi4-baseline
```

`SINAIN_BENCH_MODEL` is also a **cache-isolation salt** — different
models get different cached graphs. Format: `ollama/<model-name>`.

### Under a non-default profile

```bash
python3 eval/benchmarks/runner.py \
    --benchmarks longmemeval \
    --conditions sinain-memory \
    --subset 2 \
    --profile eval \
    --output-dir eval/benchmarks/results/cloud-eval-profile
```

Profiles defined in `query_params.py`:
- `agent-tick` — fast, hop_depth=0, confidence_floor=0.5
- `mcp-default` — balanced, hop_depth=1
- `escalation` — precise, hop_depth=2, confidence_floor=0.3, structured
- `browse` — balanced, narrative format, latency_budget=1500ms
- `eval` — precise + hop_depth=2 + structured + cross-encoder rerank

### Full n=500 run (expensive — ~$10 + ~3 hours)

```bash
python3 eval/benchmarks/runner.py \
    --benchmarks longmemeval \
    --conditions sinain-memory,full-context,knowledge-doc \
    --stratified \
    --resume \
    --output-dir eval/benchmarks/results/full-500
```

`--resume` re-reads `<output-dir>/longmemeval_progress.jsonl` and skips
already-scored questions. Safe to interrupt and restart.

## Conditions (what's being compared)

| Condition | What QA model sees |
|---|---|
| `sinain-memory` | format_facts_compact output from query_facts_hybrid against the distilled graph |
| `full-context` | the raw concatenated transcript of all sessions (truncated to 100K chars) — upper bound |
| `knowledge-doc` | a one-time top-30-facts-by-confidence rendering |

`full-context` is the **reference upper bound**: if sinain-memory scores
4.2/5 and full-context scores 4.5/5, sinain has ~90% of the achievable
quality from the raw content.

## Cache behavior — critical to understand

`ingest.py:_content_hash()` computes the cache key as:

```
sha256(sorted_sessions_json + "|" + SINAIN_BENCH_MODEL +
       "|" + _distillation_pipeline_version() +
       "|" + SINAIN_ABLATE:SINAIN_ABLATE_MODE)
```

`_distillation_pipeline_version()` hashes:
- `session_distiller.py`
- `knowledge_integrator.py`
- `ingest.py` (this file itself)

**Touching any of these invalidates the cache for ALL bench runs.**
`graph_query.py`, `rdf_store.py`, `triplestore.py`, `link_extraction.py`,
`common.py` are NOT in the pipeline-version hash — so changes to retrieval
or extraction reuse the cached graphs (re-runs are fast).

Cache stores live at `eval/benchmarks/data/longmemeval/stores/<hash>.db/`
(Oxigraph RocksDB directory, not a single file).

## Important environment variables

| Env var | Effect | Default |
|---|---|---|
| `OPENROUTER_API_KEY` | Required unless all models are local | (none) |
| `SINAIN_BENCH_MODEL` | Distiller model override (`ollama/<name>` or `google/gemini-...`). Salts cache key. | `google/gemini-2.5-flash` |
| `SINAIN_STRUCTURED_DISTILLER` | `0` to disable JSON-Schema strict mode in distiller | `1` (on) |
| `SINAIN_ABLATE` | `none` / `distiller` / `integrator` / `retrieval` — replace one stage with a stub for ablation. Salts cache. | `none` |
| `SINAIN_ABLATE_MODE` | `passthrough` / `oracle` / `random` — ablation behavior | `passthrough` |

## Output files (in `--output-dir`)

| File | What |
|---|---|
| `longmemeval_results.json` | Aggregate summary + per-question details |
| `longmemeval_results.md` | Human-readable markdown report |
| `longmemeval_progress.jsonl` | Incremental per-question results (used by `--resume`) |

## Diagnostic output (added 2026-05-28)

Each bench run prints:

After ingestion of each instance:
```
-> ingested: 540 fact entities
   sample:
    [the-bitcoin] The Bitcoin miner's job is to solve...
    [general] "Ideal cooking temperature range for smoked meats..."
    ...
```

After retrieval for each question:
```
[retrieval] e47becba: content_recall@1=1.0 @10=1.0, top facts:
    1. [user] degree in Business Administration
    2. [user] this information
    ...top 5
```

When the gold answer isn't at rank 1 (`content_recall@1 < 1.0`):
```
[diagnostic] AMBIGUOUS — no contiguous gold-phrase match, but N
  fact(s) contain individual gold keywords [...]
```
Or:
```
[diagnostic] RETRIEVAL GAP — graph contains N fact(s) with gold-phrase match
```
Or:
```
[diagnostic] DISTILLATION GAP — no facts contain gold keywords
```

These classifications point to which pipeline stage to investigate.

## Deeper post-hoc investigation

When a bench result needs more than the inline diagnostic, use:

```bash
python3 eval/benchmarks/diagnose_bench_run.py
```

Dumps every fact in the cache for a specific instance + every fact
returned by retrieval for the question. Useful for tracing "this fact
should be there — is it? where?" without re-running the bench.

## Reference questions (the canonical 4)

| qID | Category | Gold | Notes |
|---|---|---|---|
| `e47becba` | single-session-user | Business Administration | q1, BA degree |
| `118b2229` | single-session-user | 45 minutes each way | q2, daily commute |
| `51a45a95` | single-session-user | Target | q3, Cartwheel app (handoff retrieval-miss) |
| `58bf7951` | single-session-user | The Glass Menagerie | q4, theater play (handoff retrieval-miss) |

`--subset 2` selects q1+q2 (the first two). For just q3+q4, use a
custom invocation or hand-edit a slice.

## Cost estimates

| Run | Cost | Time |
|---|---|---|
| Cloud `--subset 2` fresh ingest | ~$0.05 | ~3-5 min |
| Cloud `--subset 2` cache hit | ~$0.01 | ~1 min |
| Cloud `--subset 2` under `--profile eval` cache hit | ~$0.02 | ~2 min |
| Local phi4 `--subset 2` fresh | $0 | ~15-20 min |
| Local qwen2.5:7b `--subset 2` fresh | $0 | ~30-35 min |
| Full n=500 cloud | ~$10 | ~3 hours |

## Common pitfalls

- **Don't forget `set -a && source .env && set +a`**. Without it,
  cloud calls fail at the first OpenRouter request.
- **Cache invalidation surprise**: editing the distiller's SYSTEM_PROMPT
  invalidates 500 cached graphs. Plan for a full re-ingest or use
  `--subset N` for iterative work.
- **`-uall` on git**: per CLAUDE.md, never use it — it can OOM on large
  repos. Just use `git status` or `git status --short`.
- **Result dir collisions**: if `<output-dir>/longmemeval_progress.jsonl`
  exists, `--resume` will skip already-scored questions silently. Delete
  the progress file (or use a fresh `--output-dir`) for a clean run.
- **Local Ollama timeouts**: `ingest._resolve_distiller_timeout()` returns
  90s for local models, 60s for cloud. If you're hitting timeouts on a
  big model, the distiller subprocess kills the process — no graceful
  fallback. Bump the constant or use a smaller model.

## Live recording bench (separate runner)

For the meeting-recall bench (Path C — real audio capture, not
synthetic transcripts), use `meeting_runner.py` orchestrated via
`bench_media_capture.py`. See `eval/local_models/README.md` for that
workflow. Different mental model: live capture → real distillation →
score against hand-authored QA pairs.
