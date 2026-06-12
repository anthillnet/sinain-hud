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

---

# Benching methodology & handoff (2026-05-29)

**The canonical priority/status/baseline index is `.planning/eval-log.md § ROADMAP`.** This section
documents HOW we bench so the next session can reproduce and continue. All runs from
`sinain-hud-plugin/sinain-memory/` with `set -a && source ../../.env && set +a` first.

## Two benchmark surfaces — bench BOTH, and bench LOCAL (it's the priority)

| Surface | Measures | Driver | Short variant for iteration |
|---|---|---|---|
| **LongMemEval-S** | text memory QA across 30-60 prior sessions; 6 categories | `eval.benchmarks.runner` | `--subset 6 --stratified` (1/category) |
| **acme meeting** | REAL production capture (ASR errors + distillation) of a 27-min meeting; 25 Qs | `eval.benchmarks.meeting_runner` (needs a pre-built `--db`) | offline re-distill of the log-rebuilt transcript |

**Cloud vs local (both, always):** local is the default product mode (privacy), so the **local number is
the one that matters most**. Toggle the distiller via `SINAIN_BENCH_MODEL=ollama/qwen2.5:7b` (threads to
`SINAIN_FAST_MODEL`; salts the store cache so cloud/local stores don't collide). QA + judge stay cloud
(gemini-2.5-flash / gpt-4o) so the only variable is distillation quality.

## Pipeline under test (production-faithful — keep it that way)
`distill (session_distiller, per-session ≈ production FeedBuffer(100)) → integrate
(knowledge_integrator, deterministic) → retrieve (graph_query.query_facts_hybrid, DEFAULT profile =
balanced + hop_depth=2, the UNIFIED prod==eval config) → QA (fair prompt: synthesize, don't refuse) →
judge (paper binary)`.

**Invariants that keep the bench honest (each was a bug we fixed — do not regress):**
- **No bench-only retrieval profile** — defaults == what production runs. `--profile eval` ≡ no-profile.
- **No test-answer leakage** in the distiller prompt (few-shot examples are neutral/generic).
- **Symmetric QA prompt** — sinain-memory may synthesize, not just refuse (matches full-context).
- **Production-scale batching** — distill per-session (≈ FeedBuffer 100 items), same cloud/local.
- **Features live in the retrieval API**, not QA-harness hacks (e.g. raw chunks come from
  `graph_query`, so MCP/agent/bench all get them identically).

## Caching (what triggers a re-ingest)
Per-instance Oxigraph stores are cached at `data/<bench>/stores/<hash>.db`. The hash salts on:
source sessions + `SINAIN_BENCH_MODEL` + **pipeline version** (sha of `session_distiller.py` +
`knowledge_integrator.py` + `coreference.py` + `ingest.py`) + ablate flags + `SINAIN_COREF`.
→ Editing any distiller/integrator/coref/ingest file **invalidates the cache → full re-ingest** (slow,
esp. local). Query-side changes (`graph_query`, `query.py`, `rdf_store.fts_search`) do NOT — they
cache-hit (fast: QA+judge only). Use this: iterate retrieval cheaply; budget time for distiller changes.

## The iteration loop (cheap → decisive)
1. **Retrieval/QA change** → re-run cloud 6-q (cache-hit, ~3 min) → compare to baseline.
2. **Distiller change** → re-ingest 6-q (cloud ~10 min; local ~1 hr — qwen is slow) → compare.
3. **acme, distiller change** → re-distill the **log-rebuilt** production transcript offline
   (`tools/distill-offline.py` on `/tmp/acme-prod-formatted.txt`) → `meeting_runner --db <graph>`.
   The transcript is rebuilt from the capture's `core.log` `[transcribe]` lines — **NOT** the GT `.txt`
   (that's QA-reference only; the bench must use production-ASR text, errors and all).
4. **Keep/drop rule:** keep a feature only if it lifts (or holds) BOTH benchmarks; **drop on any
   regression**. When one variant is noisy (acme offline-batched), weight the cleaner signal (LME).

## Commands
```bash
# LongMemEval cloud 6-q (honest baseline = 3/6)
python3 -m eval.benchmarks.runner --benchmarks longmemeval --conditions sinain-memory \
    --subset 6 --stratified --judge-mode paper --output-dir eval/benchmarks/results/lme-cloud-6q
# LongMemEval LOCAL 6-q (honest baseline = 1/6) — SLOW (cache-hit distill if stores exist)
SINAIN_BENCH_MODEL=ollama/qwen2.5:7b python3 -m eval.benchmarks.runner --benchmarks longmemeval \
    --conditions sinain-memory --subset 6 --stratified --judge-mode paper --output-dir .../lme-local-6q
# acme 30-min full PRODUCTION CAPTURE (~28 min real-time, needs BlackHole + QuickTime, port 9500 free)
python3 -m eval.local_models.bench_media_capture --video acme-prep --meeting acme-prep --duration 1620
# acme offline re-distill iteration (fast, no re-capture)
python3 ../../tools/distill-offline.py --transcript /tmp/acme-prod-formatted.txt \
    --out-dir /tmp/af-test --label-mode none
python3 -m eval.benchmarks.meeting_runner --db /tmp/af-test/memory/knowledge-graph.db \
    --conditions sinain-memory --meeting acme-prep --output-dir .../af-test
```

## Diagnosis method (how we find WHY a question fails — use it, don't guess)
1. Per-question: is it `paper_label`=0 with `recall@10`=0 (fact not retrieved/distilled) or `recall@10`=1
   but wrong (QA/synthesis or distillation-quality)? Read the actual retrieved facts via
   `query_facts_hybrid(db, question, max_facts=10)`.
2. Is the content even in the graph? Probe `graph_query.py --db <store> --entities '["term"]'`.
3. Is it in the production transcript? Align the QA `evidence_timestamps` against the log-rebuilt
   transcript (and GT `.txt`) — distinguishes ASR-destroyed (re-capture needed) from distillation-dropped
   (offline-fixable). This split is the acme root-cause taxonomy in the discourse-reconstruction plan.

## Honest baselines (de-leaked distiller + fair-QA, 2026-05-29)
- LongMemEval 6-q: **cloud 3/6** (single-session 3/3, cross-segment 0/3), **local qwen 1/6**.
- acme 25-q: **batched(offline) 1.60/5**, live-capture 2.56 (pre-de-leak), vs **full-context 4.00** ceiling.

## Gotchas (each cost real debugging time)
- **Long runs keep their start-time prompt** (Python module cache): editing code mid-run silently
  invalidates the result (caused a phantom local 0%). Keep runs short; don't edit code while a run is live.
- **`| tail -N` on a launch buffers ALL output** until exit → the task file looks empty mid-run. Check
  liveness via `pgrep` + `~/.ollama/logs/server.log` (local) instead.
- **Distillation empty-batch**: ~1/5 batches return valid JSON with empty `facts[]` (no retry) → random
  segment dropped → adds ±0.3 noise to single-run acme offline comparisons.
- **`--meeting acme-prep` matches BOTH** `acme-prep_qa.json` (25) and `acme-prep-5min_qa.json`
  (12) → split by `mtg-af-*` vs `5m-*` id prefix, or move the 5-min QA aside.
- **Bench-DB bloat**: each store is a ~126 MB Oxigraph dir but only ~1.1 MB is real data (RocksDB
  overhead); 127 stores ≈ 16 GB. Production is one shared store — not affected.

---

## Running iteratively + live logs (fail-fast — don't wait for 6 questions)

Two rules that save time and make mid-run diagnosis possible:

### 1. Unbuffered output to a logfile — NEVER pipe the launch through `tail`/`grep`
Python buffers stdout to a pipe (block-buffered), so `... | tail -2` shows **nothing until the process
exits** (this hid a whole run's progress this session). Instead force unbuffered + redirect to a file
you can `Read`/`tail -f` live:
```bash
PYTHONUNBUFFERED=1 python3 -u -m eval.benchmarks.runner \
    --benchmarks longmemeval --conditions sinain-memory --subset 1 --stratified --judge-mode paper \
    --output-dir eval/benchmarks/results/<run> \
    > eval/benchmarks/results/<run>/run.log 2>&1 &
# then watch it live:
tail -f eval/benchmarks/results/<run>/run.log
```
The runner prints per question: `[retrieval] <id>: content_recall@1=.. @10=.. top facts: …`, the
generated answer, and `paper_label=`. So you see q1's retrieval + answer + label **before** q2 starts.

### 2. Start with `--subset 1`, verify, THEN scale with `--resume`
Run ONE question first to catch breakage immediately (bad ingest, empty distill, import error, wrong
profile) instead of after 6 × (ingest + QA + judge):
```bash
# 1) one question — inspect run.log: did it ingest? retrieve real facts? answer sanely?
... --subset 1 --stratified ... > run.log 2>&1
# 2) if good, scale up reusing the completed question (--resume keeps partial results)
... --subset 6 --stratified --resume ... >> run.log 2>&1
```
`--resume` reads existing partial results in `--output-dir` so q1 isn't re-run.

### Mid-run health checks (when something looks stuck)
- Process alive + working: `pgrep -fl eval.benchmarks.runner` ; local distill activity:
  `tail ~/.ollama/logs/server.log` (each `/v1/chat/completions` line = one distill/QA call + its latency).
- Local qwen is SLOW (~12–37s/call, BATCH_SIZE=1 session → many calls). A 6-q local run is ~1 hr; a
  1-q run is the fast sanity check. Cloud is minutes.
- Per-question diagnosis once a question lands: see the "Diagnosis method" section above
  (recall@10=0 → not retrieved/distilled; recall@10=1 + wrong → QA/synthesis or distill quality).

---

## Trick: rebuild the production transcript from capture logs (avoid a 28-min re-capture)

To iterate **distillation/retrieval** on a real production capture, you do NOT need to re-play the video.
The live capture logs every ASR result to `~/.sinain-bench/<timestamp>/logs/core.log` as:
`[<iso-ts>] [transcribe] transcript (<ms>ms): "<text>"`. Rebuild the transcript from those lines and
re-distill offline — the production-ASR text (errors baked in) is preserved, so it's the correct input
for distiller-change A/Bs. (This is NOT the GT `.txt`, which is QA-reference only. Note: the rebuilt
text is the AUDIO path only; screen-OCR/sense meta came separately and is mostly noise.)

```bash
CAP=~/.sinain-bench/<timestamp>/logs/core.log
# (a) plain transcript (one line per ASR segment):
grep -oE 'transcript \([0-9]+ms\): ".*"' "$CAP" | sed -E 's/^[^"]*"//; s/"$//' > /tmp/prod-transcript.txt
# (b) formatted for distill-offline.py — [HH:MM:SS] SPEAKER_00 blocks w/ real relative timestamps:
python3 - "$CAP" <<'PY'
import re, sys
from pathlib import Path
from datetime import datetime
raw = Path(sys.argv[1]).read_text(errors="ignore")
pat = re.compile(r'\[([\d:.T-]+Z)\] \[transcribe\] transcript \(\d+ms\): "(.*)"')
rows = [(datetime.fromisoformat(m.group(1).replace("Z", "+00:00")), m.group(2)) for m in pat.finditer(raw)]
t0 = rows[0][0]; out = []
for ts, txt in rows:
    s = int((ts - t0).total_seconds()); h, r = divmod(s, 3600); m, sec = divmod(r, 60)
    out.append(f"[{h:02d}:{m:02d}:{sec:02d}] SPEAKER_00\n{txt}\n")
Path("/tmp/prod-formatted.txt").write_text("\n".join(out))
print(f"wrote {len(rows)} segments")
PY
# (c) re-distill OFFLINE (no re-capture); cloud distiller by default, or SINAIN_BENCH_MODEL for local:
python3 ../../tools/distill-offline.py --transcript /tmp/prod-formatted.txt --out-dir /tmp/redistill --label-mode none
python3 -m eval.benchmarks.meeting_runner --db /tmp/redistill/memory/knowledge-graph.db \
    --conditions sinain-memory --meeting <stem> --output-dir eval/benchmarks/results/<run>
```
Caveat: the offline-batched path is noisier than live (random empty-batch ~1/5) — for keep/drop on
distiller changes, weight the LongMemEval signal; re-capture only to validate the final end-to-end number.
