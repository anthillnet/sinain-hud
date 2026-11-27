# Phase A — Local-model evaluation harness

This directory is the Phase A bench harness for the v2 memory redesign
(see [`../../../docs/memory-v2-local-first.md`](../../../docs/memory-v2-local-first.md)
and [`.planning/phases/12-memory-redesign/00-PLAN.md`](../../../.planning/phases/12-memory-redesign/00-PLAN.md)).

Status: **scaffold**. The module structure, model registry, result schemas, and
dispatcher are in place. The model-swap glue and private-surface playback loop
are TODO and land in `12-A-PLAN.md` execution.

## Purpose

Bench candidate **local** models for two architecture layers of the v2 memory
pipeline:

- **L2 (vision)** — OCR + scene description from screen frames
- **L3 (extraction)** — turning perceived events into typed facts

The candidate list is in `bench_harness.DEFAULT_CANDIDATES`. May 2026 defaults
per the design doc:

| Layer | Candidates | Design-doc default |
|---|---|---|
| L2  | Gemma 4 E4B-it, Qwen3-VL-4B | Gemma 4 E4B-it |
| L3  | Qwen3.5-9B-Instruct, (Mistral Small 4 — pending spec verification) | Qwen3.5-9B-Instruct |

Phase A's exit criterion is a `docs/model-choices.md` with verified winners,
hardware-tier mapping, and fallback chains. Phase B (local perception
integration) is **gated** on that file — see plan.

## Eval surfaces — dual methodology

Two surfaces run for every candidate:

### Public — LongMemEval-S (`bench_longmemeval.py`)

The number we report externally. 500 questions, paper-aligned GPT-4o judge,
deterministic QA. Methodology stack pinned and documented in every result
record (per BLOCKING CONSTRAINT 2 in the plan).

Results: `results/<candidate>__longmemeval__<ts>.json` (gitignored along with
the rest of `eval/`; export externally via copy-out, not via commit).

### Private — internal recorded media (`bench_media.py`)

The number we **never** publish. Real recorded session containing CONFIDENTIAL
business context (see BLOCKING CONSTRAINT 1). Tests the actual capture-to-fact
pipeline at sinain's natural granularity (real audio, multi-speaker, real
domain entities) which LongMemEval's synthetic text cannot exercise.

Results: `.planning/eval-internal/<candidate>__media__<ts>.json`
(gitignored — `bench_harness._assert_private_dir_gitignored` refuses to write
unless `.planning/eval-internal/` or `.planning/` is in `.gitignore`).

## Usage (post-implementation)

```bash
# List registered candidates
python3 -m eval.local_models.bench_harness --list-models

# List only L3 candidates
python3 -m eval.local_models.bench_harness --list-models --layer l3

# Bench one L3 candidate on the public surface
python3 -m eval.local_models.bench_harness \
    --layer l3 --surface longmemeval --candidate qwen3.5-9b-instruct

# Bench all L2 candidates on the private surface
python3 -m eval.local_models.bench_harness --layer l2 --surface media

# Dev iteration — first 20 questions only
python3 -m eval.local_models.bench_harness \
    --layer l3 --surface longmemeval --subset 20
```

## Pre-flight (operator setup)

Before running the private (`media`) surface:

1. `.planning/eval-internal/` is gitignored — verified by
   `_assert_private_dir_gitignored()`.
2. Set `MEDIA_VIDEO_PATH` to the local recording path (operator machine only).
3. Set `MEDIA_TRANSCRIPT_PATH` to the local transcript path (operator machine
   only).
4. Author `.planning/eval-internal/media-ground-truth.json` — the ~30 facts a
   correct memory pipeline must extract from the recording.

All four are operator-machine state — none should land in any committed file,
shell snippet, CI config, or README example.

## Methodology stack (pinned)

Every bench result records the full stack so cross-run comparisons stay valid:

- **LongMemEval-S:** judge `gpt-4o`, paper-aligned binary rubric, QA `temperature=0`.
- **Private media:** QA `temperature=0`, fact-comparison via
  predicate+subject+object normalized match against ground-truth set. Latency
  measured per buffer-fill.

Changing any element of the stack (judge model, prompt version, QA temperature,
dataset version) invalidates comparison against prior numbers. See BLOCKING
CONSTRAINT 2 in the plan.

## Exit criteria for Phase A

A `docs/model-choices.md` document containing:

1. Public LongMemEval-S scores for every candidate (table: candidate × accuracy,
   IPR, per-category breakdown, latency p50/p99).
2. Private notes-only reference to the internal-media surface — qualitative
   summary only (e.g. "candidate X recalled N/30 ground-truth facts cleanly").
   No client-identifying strings, no numbers tied to the confidential recording.
3. Hardware-tier mapping (M1/M2 8GB / 16GB / 32GB+) with verified winners +
   fallback chains per tier.
4. Mistral Small 4 spec verification result (whether it joined or stayed out).
5. Recommended L3 model loaded for L4 consolidation (shared-weights decision).

Once `docs/model-choices.md` lands, Phase B (local perception integration)
unblocks.
