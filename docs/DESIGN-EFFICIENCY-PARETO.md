# Design: Pareto-Only Efficiency Architecture

**Status:** brainstorm / analysis (no code committed from this doc yet)
**Date:** 2026-06-24
**Context:** The original pipeline was built ad-hoc, optimizing for unobstructed
escalations. This doc re-examines the whole sense→analyze→enrich→KG→chat path for
efficiency in **both cloud and local mode**.

## The mandate

**Pareto-only: the outputs the user experiences must never regress on any axis —
not latency, not quality, not recall.** We are *not* trading UX for cost. Spending
more is acceptable; missing a chance to help, or showing a slower/weaker result, is
not.

This disqualifies a whole class of "optimizations":

- ❌ **Confidence-gated cascades** (small model decides whether to escalate) — makes
  the least-calibrated component the gatekeeper; structurally guarantees misses.
- ❌ **Cheap-first-then-upgrade** that shows a weaker intermediate answer.
- ❌ **Seed/context trimming** that risks answer quality.
- ❌ **Fuzzy/near-duplicate skipping** that might drop a real change.
- ❌ **Distiller input pre-extraction** that changes its output.

The governing principle the ad-hoc design violated:

> **Separate _what the user experiences_ (immutable) from _how / where / when we
> compute it_ (free to re-architect).** Produce the same-or-better outputs via
> dedup, parallelism, indices, scheduling, and precompute — none of which is
> perceivable except as "faster, never misses."

## The only legitimate (lossless) levers

| Lever | Why it's free |
|-------|---------------|
| **Exact-result cache / dedup** | Identical input ⇒ identical output. Serving from cache is the *same answer*, no recompute. Invisible. |
| **Kill discarded work** | Removing computation whose result is thrown away changes no output. |
| **Single-pass** | Multiple consumers re-deriving the same thing from the same source → compute once, both read it. |
| **Parallelize independent stages** | Same outputs, lower wall-clock. |
| **Better indices/structures** | Find more (quality ↑) and faster — strictly better. |
| **Schedule + pin + pre-warm** | Removes contention and cold-start *latency*; same model, same answer, no stall. |
| **Speculative precompute on spare capacity** | Prefetch likely-next work while idle; result ready when needed. Latency hidden, quality unchanged. |

Cloud vs local asymmetry: **cloud** is latency/$-bound with ∞ parallelism → wants
fan-out + cache. **Local** is GPU-bound and serial → wants work-reduction +
scheduling + warming. Same logical pipeline, different execution strategy.

## The pipeline today (end-to-end)

```
CAPTURE   sck-capture (1 SCStream): audio PCM → stdout ; screen JPEG → IPC file
AUDIO     core AudioPipeline → VAD → whisper(local)/gemini(cloud) → feedBuffer
SCREEN    sense_client: SSIM gate → Apple-Vision OCR (on-device) + bboxes
            → privacy strip → [local] qwen2.5vl scene caption → POST /sense
INGEST    senseBuffer(30)  feedBuffer(100)   ← ring buffers
TIER-0    region-SLM (qwen2.5:3b, 500ms): buildLineList → focused prompt → eyes
TIER-2    AgentLoop (debounce 6s): buildContextWindow → ONE LLM call
            → {hud, digest, regions, record}
ESCALATE  scorer(digest) → gateway WS  /  resident chat sidecar (on-demand 7b)
LEARN     feedBuffer full → session_distiller(LLM) → integrator(code)
            → triplestore (Oxigraph + SQLite EAV, 4 indices, FTS5)
RETRIEVE  KG daemon (warm, ~0.5ms) + MiniLM embeddings → ROI seed / chat context
CHAT      routeSinainChat → sidecar (OpenHands; 7b local on-demand / cloud)
```

## Stage-by-stage map (verified against code)

| # | Stage | Finding | Lever | Mode | Status |
|---|-------|---------|-------|------|--------|
| 1 | Capture (sck-capture) | already single SCStream | — | — | optimal ✅ |
| 2 | SSIM change-gate | already frame-level dedup | — | — | optimal ✅ |
| 3 | OCR (Apple Vision) | already on-device, cheapest tier | — | — | optimal ✅ |
| 4 | Scene caption (qwen2.5vl) | **was computed then discarded** | kill-dead-work / single-pass | local | **done** (wired via `ocr`) |
| 5 | Audio VAD+transcribe | already VAD-gated | — | — | optimal ✅ |
| 6 | Context-window assembly | already guarded by 2 idle pre-checks; only builds on changed content | (image-extract-when-unused trivial) | both | **dropped** — not worth it |
| 7 | Region-SLM (Tier-0) | re-runs on scroll-jitter/re-anchor when line list identical | exact-cache on line list | local | proposed |
| 8A | Tier-2 analysis | **no input cache**; dedup is post-hoc (`consecutiveIdenticalHud`) — pays for the call to discover "same HUD" | **exact-result cache** | both | proposed, **measuring** |
| 8B | Tier-2 parallelism | **already lane-parallel** (region-SLM, KG-prefetch, distill, transcribe are separate lanes); the tick makes ONE LLM call | — | — | **dropped** — no free win |
| 9 | Escalation scorer | cheap/pattern-based | cache score per digest (rides 8A) | both | minor |
| 10 | KG distillation (LLM) | blocks / `ETIMEDOUT` locally | background-priority schedule + dedup distilled | both | proposed |
| 11 | KG retrieval (daemon) | warm + content-cached; **0 facts on sparse/abstract queries** | **vector/HNSW index on existing MiniLM** (quality ↑) | both | proposed |
| 12 | ROI enrichment | already prefetched-at-detect + cached | extend prefetch to next-likely ROI | both | minor |
| 13 | Chat sidecar | **14–20s cold-load** (model not resident) | **pre-warm + pin** | local | proposed |
| 14 | Embeddings (MiniLM) | resident, fast | embedding cache by text-hash | both | minor |
| ✚ | **Local execution (cross-cutting)** | uncoordinated Ollama consumers → **25–67s contention spikes** | **shared scheduler (priority lanes) + model pinning + pre-warm** | local | proposed |

### Verified corrections (why two rows were dropped)
- **#6**: `loop.ts run()` returns at two idle pre-checks (buffer version cursors ~L275,
  audio+screen count ~L288) *before* `buildContextWindow` (~L296). So context is only
  rebuilt when content changed. Not worth an incremental rewrite.
- **#8B**: region detection is its own `RegionDetector` lane; KG prefetch is
  fire-and-forget off the region broadcast; distillation and transcription are
  separate lanes. The agent tick issues exactly one LLM call and derives regions from
  it via `resolveLineRegions` post-processing. No intra-tick parallelism to reclaim
  without decomposing the call (quality risk → excluded).

## Priorities (zero-risk, highest measured impact)

1. **Local Ollama scheduler + pre-warm/pin** — kills the worst *measured* latency
   (25–67s contention, 14–20s chat cold-load). No quality risk.
2. **#8A exact-result cache** — lossless; magnitude pending an idle-inclusive
   salience window. Wins land during idle/reading (active use churns content).
3. **#11 KG vector index** — strictly better retrieval; reuses resident MiniLM.

## Measurement: the salience probe

`loop.ts` logs (measurement-only, no skipping) per Tier-2 tick:
`[salience] dupExact=… dupNorm=… | would-skip exact X/N norm X/N`.

- **Exact** dup = the lossless-cache ceiling (identical app+OCR+audio ⇒ identical
  output ⇒ safe to reuse).
- **Norm** (digits/non-letters stripped) = intelligence on how much a *provably
  lossless* change-detector could add beyond exact — never something we skip on a
  guess.

Early signal during *active* dev: exact-dups rare (~3/46) — expected; the cache wins
during idle/reading, which needs a clean uninterrupted window (counters reset on each
hot-reload) to size.
