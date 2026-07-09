# Burst-lane spend baseline

Measured baseline of Cerebras "burst" token spend for the deliberate-capture
gestures, so we can evaluate reduction work against a fixed reference. Produced
by `sinain-core/scripts/burst-baseline.mjs` on the `perf/burst-instrumentation`
branch (instrumentation is measure-only — no prompt/output/window changes).

## Method

- Real feed + sense buffers pulled from a running core (`GET /sense`, `/feed`),
  **frozen** and re-anchored to now, then replayed through the actual
  `assembleWindow` + `summonBrief`/`enrichFocus` against the **real Cerebras
  endpoint**. Frozen input → reproducible: re-run after each optimization and
  diff the snapshot.
- Cross-checked against the **live** stack (`POST /context/summon`, `/cost`
  token deltas) to confirm the replay matches production.

### Session characteristics (this baseline)

- Sense buffer: **209 events over 58 min**, 172 with OCR text. Real apps:
  Chrome (117), Zed (31), IntelliJ (30), Claude (21), Telegram (7), Discord (3).
- Feed buffer: **2 audio items** — a screen-heavy, near-silent session
  (transcript contributes ~2% of chars; OCR is ~98%).
- `semantic` layer: **absent on every event** — the live sense_client is not
  emitting `semantic.visible.summary`/`changes`. This gates lever L1 (below).

## Baseline numbers (real Cerebras, gemma-4-31b)

| Gesture | Window | tokensIn | tokensOut | latency | OCR % of chars | truncated chars | measured L2 headroom |
|---|---|---:|---:|---:|---:|---:|---:|
| enrich (clipboard) | 10 min | **19,677** | 53 | 928 ms | 98% | 0 | 0 |
| summon | 30 min | **19,663** | 239 | 1,100 ms | 98% | 0 | 0 |
| summon | 60 min | **29,402** | 221 | 1,452 ms | 98% | 57,635 (39% of range) | 475 ch ≈ 95 tok |
| voice-seed | 30 min | **19,663** | 239 | 738 ms | 98% | 0 | 0 |

Live cross-check: `POST /context/summon {minutes:30}` moved `/cost` tokensIn by
**20,832** vs the replay's 19,663 (6%, buffer drift) — replay validated.

`save last 60 min → memory` (`POST /capture/save {minutes:60}`) left `/cost`
**unchanged**: it is **not** a Cerebras/burst call. It distills feed items via
the memoryd session distiller (OpenRouter/local, tracked separately). With only
2 audio items in range, its spend here is negligible; it is a different lane
from the burst optimization and is out of scope for this baseline.

## What the numbers change about the plan

The instrumentation redirected the strategy from the pre-measurement brainstorm:

1. **OCR is ~98% of every prefill, and it is raw.** Each gesture ships full OCR
   for every distinct frame — including repeated UI chrome
   (`Zed File Edit Selection View Go Run Window Help …` on every frame). This is
   the dominant cost and the biggest untapped lever: strip cross-frame boilerplate
   / menu chrome and dedup repeated lines *within* the window.

2. **L1 (semantic substitution) is BLOCKED, not free.** Headroom measured 0
   because the live sense_client emits no `semantic` layer. L1 only pays off
   once sense_client populates `semantic.visible.summary`/`changes`; until then
   there is nothing denser than OCR to send. Reframed from "free win" to
   "gated on a sense_client change."

3. **L2 (near-dup dedup at assembly) is nearly exhausted.** Only 475 chars of
   near-duplicate OCR survived to the window on the 60-min slice — because the
   sense buffer's own SSIM/OCR dedup (`SENSE_SSIM_DEDUP_THRESHOLD`) already ran
   upstream. Little left to reclaim at assembly time.

4. **L3 (tiered fidelity) is the real headroom.** The 60-min window is
   147.6K chars but the hard `MAX_WINDOW_CHARS = 90K` cap **silently drops the
   oldest 39%** of the range. The token budget is the binding constraint, and
   truncation is lossy. Compressing older OCR (instead of dropping it) both
   lowers tokens and *improves* coverage — the one lever that helps UX and cost
   together.

5. **enrich's "10-min window" is not cheap** (~19.7K, ≈ summon-30) on OCR-dense
   sessions. The assumption that enrich is a light gesture is false; it deserves
   the same OCR-reduction treatment.

### Revised lever priority (from measured data)

1. **OCR volume reduction** — strip repeated UI chrome / boilerplate lines
   across frames; dedup lines within the window. Attacks the 98%. Latency-positive.
2. **L3 tiered fidelity** — compress older OCR instead of truncating; helps the
   60-min case's 39% loss and cuts tokens.
3. **L4 deterministic preview** — still valid (recurring call), independent of
   the above.
4. **L1 semantic** — worthwhile but requires sense_client to emit the semantic
   layer first; revisit once it does.
5. **L2 assembly dedup** — deprioritized; buffer-level dedup already covers it.

## Reproduce

```bash
cd sinain-core
npm run build
CEREBRAS_API_KEY=... node scripts/burst-baseline.mjs --core http://127.0.0.1:9500
```

Requires a running core with a populated buffer (`GET /health` shows
`senseEvents`). Re-run after each optimization on the same frozen buffer window
and diff the `tokensIn_avg` / `ocrShareOfChars` / `projected` fields.

## Result: compact assembly (shipped, default ON)

Cross-frame line dedup: reconstruct real text lines from the per-word OCR boxes
(`ocrLines`), then send each distinct line once per window — UI chrome and
re-read content collapse; every unique line survives in time order.
`SINAIN_BURST_COMPACT=0` restores the raw path. A/B on one frozen 60-min buffer
(real Cerebras, identical input):

| Gesture | baseline tokIn | compact tokIn | saved | latency | truncation b→c | quality |
|---|---:|---:|---:|---:|---:|---|
| enrich (10m) | 18,127 | 13,883 | **23%** | 924→951 ms | 0→0 | card semantically identical |
| summon (30m) | 30,271 | 22,974 | **24%** | 1,307→1,354 ms | 6,380→0 ch | baseline returned EMPTY brief (4 out tok); compact returned a full brief |
| summon (60m) | ~28,620 | ~28,620 | 0% at cap | — | 72,348→17,917 ch | compact delivers 83% of range vs baseline 55% (same tokens) |

Deterministic char reduction (no API): enrich −30%, summon-30 −25%, summon-60
window 162K→108K (−33%) but both still exceed the 90K cap so tokens are equal.

Takeaways:
- **enrich + summon-30: 23–24% fewer tokens, latency-neutral, quality equal or
  better.** The summon-30 baseline drowned in raw OCR and produced nothing;
  compact produced a correct brief — dilution law on the burst read side.
- **summon-60 is cap-bound**: compaction converts to *coverage* (55%→83% of the
  range at the same token budget), not token savings. Turning that into token
  savings needs L3 (lower the char cap in compact mode, or extractively
  compress the oldest frames) — a coverage/token tradeoff that wants its own
  quality eval, deferred.
- L1 (semantic) still blocked on sense_client; L2 (assembly dedup) subsumed by
  this line-dedup.
