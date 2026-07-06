# Deliberate Capture — UX Design Handoff

Status: proposal, validated by API benchmarks (2026-07-06)
Owner: core team → design
Excluded: WSM (not a committed feature) and automated ROI extraction. Nothing in
this design depends on either.

## 1. Concept

Sinain currently decides for the user what gets remembered: buffers fill, an LLM
distills them, facts land in the knowledge graph automatically — and cloud vision
runs on every changed frame. This redesign flips the model:

> **Capture is passive, free, and ephemeral. Remembering is a deliberate human act.
> Intelligence is summoned, not always-on.**

| Move | Principle |
|---|---|
| The buffers become a rolling window (hours, not item counts); content evaporates at the horizon | Nothing persists without consent |
| No cloud LLM call until the user asks (enrich / summon / save) | Spend is deliberate and visible |
| Fast-inference burst (Cerebras) makes "asking" feel instant | Deliberateness must not cost responsiveness |

The save gesture is the consent boundary — a stronger privacy story than "we
process everything but strip `<private>` tags first."

**UX stance: preserve the current product.** Same HUD, same modes (Feed / Alert /
Ticker / Hidden). All new interactions are normal on-screen controls — no
hotkeys. This design adds three actions (save, summon, enrich) that share one
control pattern, plus one new window (the timeline) for range precision. Where
the redesign touches existing behavior, it *removes* complexity (per-frame cloud
vision, buffer-full auto-distillation) rather than adding UI.

## 2. Latency budgets (measured, not estimated)

Benchmarked against the Cerebras API (gemma-4-31b) using 63 hours of real episode
text at measured density (median active session ≈ 2,900 chars/min ≈ 830 tok/min):

| Interaction | Measured | Notes |
|---|---|---|
| Enrich clipboard + last 5 min | 0.59s | single call |
| Enrich clipboard + last 10 min | 0.64s | single call |
| Enrich, repeated in same session | 0.49s | prefix cache (9,472/9,497 tok cached) |
| Enrich + one keyframe (real frame) | 1.05s | multimodal |
| Summon last 15 min | 1.13s | map+reduce |
| Summon last 30 min | 1.46s | |
| Summon last 60 min | 2.22s | |
| Summon last 120 min | 4.01s | brushes 100K tok/min quota |

Design budgets: **enrich ≤ 1s · summon-30 ≤ 2s · summon-60 ≤ 3s · save ack ≤ 0.5s**
(the save's distillation is async; latency-irrelevant).
Hard edge: ~2h of median-density session per summon (quota, not speed).

Local mode (Ollama, M4 Max, qwen2.5:3b): enrich 7.6s cold / **1.33s warm** via
KV-cache. Local mode keeps the window warm by appending continuously in the
background — eager where cloud is deliberate, because locally there is no
per-token cost and data never leaves the machine.

## 3. Vocabulary

- **Window** — the rolling, ephemeral record of the last N hours: OCR text, app +
  window titles, transcript, sparse visual keyframes. This IS the buffer layer —
  the feed/sense ring buffers are redesigned into it (time-horizon-bounded, not
  item-count-bounded). In-memory / encrypted temp, never synced, horizon default 8h.
- **Segment** — a slice of the window bounded by app/window-title changes and idle
  gaps (signals already captured today — no WSM). Auto-labeled from titles:
  "IntelliJ — memoryd.py · 42 min". The unit of selection in the timeline.
- **Enrich** — one-shot context lookup for the clipboard: "what is this, how does
  it relate to what I've been doing, what next."
- **Summon** — "act on my last N minutes": burst analysis → situation brief →
  the agent/HUD works from it.
- **Save** — "remember this range": memory-grade distillation (existing
  `session_distiller` → `knowledge_integrator`) into the knowledge graph. The only
  path by which anything persists.
- **Keyframe** — a stored frame where pixels matter (major visual change + little
  OCR text: diagrams, designs, dashboards). Bookmarked in the window, described by
  a vision model only when a gesture covers its range.
- **Nudge** — system-suggested save, computed from free signals only.

## 4. User stories

### Epic A — the window (passive, free, ephemeral)

**A1. Ambient capture without spend or persistence.**
As a user, while I work, sinain keeps a rolling record of my screen and audio
context locally, without calling any cloud API and without writing memory.
- AC: zero cloud calls in steady state — capture → SSIM → local OCR → gate stays
  as-is; the per-frame cloud vision path is REMOVED.
- AC: window content older than the horizon (default 8h, config) is unrecoverable;
  a panic-wipe action clears the window instantly (memory stays intact).
- AC: the ring buffers' item caps (feed 100 / sense 30) are replaced by the
  window's time horizon; downstream consumers (agent loop, context assembly) read
  recent slices of the window instead.

**A2. Diagrams and designs are kept as pixels.**
As a user, when I look at something OCR can't read, sinain bookmarks that frame
in the window instead of discarding it, so saves and summons can still "see" it.
- AC: heuristic = major visual change (SSIM < 0.85) + OCR < 20 chars → keyframe
  stored in the window, evicted on the same horizon.
- AC: keyframes are sent to a vision model only during enrich/summon/save on a
  range containing them (measured: ~1s per frame, parallel with the text burst).
- AC: volume stays sparse (cooldown-bounded; est. 20–100 keyframes/h ≈ 5–25MB).

### Epic B — enrich (the 1-second lookup)

**B1. Clipboard enrichment.**
As a user, when I copy something cryptic (an error, an ID, a quote), I can click
Enrich and get "what this is in the context of what I'm doing" in ~1s.
- AC: response ≤ 1s (p90) with last-10-min context.
- AC: the answer names the connection to recent activity, not a generic
  definition. (Benchmark bar: copied a rate-limit header → "relates to the
  Cerebras burst benchmarking you're doing.")
- AC: rendered as a HUD card in the current mode's idiom; no new surface.
- Deferred: region-of-screen enrichment (manual or automated ROI) — out for now.

### Epic C — summon ("act on my last N minutes")

**C1. Instant situation brief.**
As a user, I can summon sinain onto the last 15/30/60 minutes and it is up to
speed — timeline, current goal, open problems, key entities — within seconds.
- AC: 30 min ≤ 2s, 60 min ≤ 3s, gesture to rendered brief.
- AC: the brief becomes the agent's working context for follow-up asks.
- AC: nothing from a summon persists unless followed by a save.
- AC: quota hit mid-summon → partial brief + honest note, never a spinner.

**C2. Promote a summon to memory.**
As a user, one click on the summon brief ("Save this range") saves the same range
(the burst summaries scaffold the distillation).

### Epic D — save (the deliberate act of remembering)

**D1. Save last N via quick control (primary flow).**
As a user, I click Save on the HUD (or the menu-bar item) and pick 5/15/30/60
minutes from a compact chooser.
- AC: acknowledgment ≤ 500ms; distillation async.
- AC: the chooser shows, per option, what it covers from free window data
  ("30 min · IntelliJ, Chrome, mic") — no LLM call to render it.
- AC: completion feedback with undo: "Saved: 12 facts, 4 entities · $0.02 ·
  [Undo]." Every save carries a `save_id`; undo deletes exactly that batch.
- AC: available in any HUD mode; in Hidden mode via the menu bar.
- AC: requested N > available history → save what exists and say so.

**D2. Timeline (secondary flow, the one new window).**
As a user, I can open a timeline of my recent hours — segments with title-based
labels, an activity heat strip, keyframe thumbnails — select a range, preview, and
save it.
- AC: selection units = segments and drag-ranges; presets mirror the hotkey Ns.
- AC: preview-before-save shows the distilled facts with strike-to-redact; struck
  lines never reach the graph; estimated cost shown pre-save.
- AC: it is a normal focusable window (opened from the HUD action row or menu
  bar), NOT part of the capture-invisible overlay; visual language matches the HUD.
- AC: the quick-save flow (D1) never requires the timeline — the timeline is for
  reach-back, precision, and redaction.

**D3. Retroactive capture.**
As a user, I can save a range that ended before I realized it mattered — up to the
window horizon, at full fidelity, including keyframes.

### Epic E — nudges & deliberate forgetting

**E1. Save-this nudges (free signals only).**
As a user, when a significant stretch just ended — sustained window-title churn
that stops, dense speech activity, unusual event density — sinain offers a one-tap
"keep the last 15 min?"
- AC: nudge generation uses NO cloud LLM.
- AC: dismissing costs nothing; frequency capped and tunable; queues to menu-bar
  when the user is typing.

**E2. Deliberate forgetting replaces auto-distillation.**
As a user, nothing is distilled behind my back. Before window content expires and
at shutdown, I get one quiet digest: "these stretches are about to be forgotten —
keep any?"
- AC: buffer-full incremental distillation and pending-session.json shutdown
  distillation are REMOVED (the window has no "full"; shutdown shows the review).
- AC: default outcome is forgetting; keeping requires an action.
- AC: overlapping saves don't duplicate facts (existing embedding-service dedup).

### Epic F — local mode

**F1. Same gestures, no cloud.**
As a privacy-maximal user, I run everything against local models (existing
`ANALYSIS_PROVIDER` switch) with identical UX.
- AC: local mode pre-warms the window in the model's KV cache in the background,
  keeping enrich ≈ 1.3s; cloud mode never processes without a gesture.
- AC: keyframes described locally (qwen2.5vl-class model) eagerly in background.
- AC: only visible difference: latency/quality, labeled honestly.

## 5. Surfaces & flows

**Surfaces (one new, rest preserved):**
1. **HUD overlay** (existing, capture-invisible) — renders enrich cards, summon
   briefs, save acknowledgments, nudge toasts in the current modes' idiom. Gains
   an **action row**: three buttons — Save · Summon · Enrich — visible or
   revealed on hover, styled per mode (design's call on placement per mode).
2. **Timeline** (new, normal window) — segments, heat strip, keyframes, range
   selection, preview/redact/save, window health (horizon, size, panic wipe).
3. **The chooser** — one control pattern reused by Save and Summon: clicking the
   button opens a compact card of options (`5 / 15 / 30 / 60 min`), each showing
   what it covers ("30 min · IntelliJ, Chrome, mic"); click to confirm, click
   outside to cancel, "More…" opens the timeline. Enrich has no chooser (fixed
   10-min context).
4. **Menu bar** — capture on/off, horizon indicator, spend today, "Save last…"
   (same chooser), open timeline, panic wipe. The fallback surface when the HUD
   is Hidden.

**Flow: save.** Click Save → chooser → "Saving last 30 min · IntelliJ, Chrome,
mic…" → async → "Saved: 12 facts, 4 entities · $0.02 · [Undo]" (undo ~30s).

**Flow: summon.** Click Summon → chooser → shimmer ≤ 2s → brief card (timeline ·
goal · open problems · entities) → [Ask follow-up] [Save this range] [Dismiss].

**Flow: enrich.** Copy something → click Enrich → card ≤ 1s: what it is · how it
connects · next step.

**Flow: forgetting review.** At shutdown / horizon: one card listing labeled
stretches with [keep] per row; default action = close = forget.

**Edge states to design:** fresh session shorter than N; empty/idle range; save
during save (coalesce); quota hit mid-summon (partial + retry ETA); offline in
cloud mode (fall back to local if present, else queue the save — saves are async
anyway); Hidden-mode acknowledgments; timeline showing 8h of a single app.

## 6. What exists today vs. what changes

| Piece | Today | This design |
|---|---|---|
| Capture → SSIM → local OCR → gate | shipped, free, local | unchanged (the always-on tier) |
| Cloud vision per changed frame | OpenRouter call per event | **removed** — vision only on gesture, over stored keyframes |
| Feed/sense ring buffers (100/30 items) | minutes of retention | **redesigned into the window** — time-horizon retention (hours), same event shapes, same producers |
| Buffer-full + shutdown auto-distillation | automatic | **removed** — replaced by save + forgetting review (E2) |
| Agent loop / context assembly | reads ring buffers | reads recent window slices (mechanical change) |
| session_distiller → knowledge_integrator → graph | shipped | unchanged; invoked by save with `save_id` provenance |
| Embedding dedup, CostTracker, privacy stripping | shipped | unchanged; save path adds API-key (`csk-`-style) redaction patterns |
| HUD, modes | shipped | unchanged; + action row (Save · Summon · Enrich) |
| Timeline window | — | new |
| Cerebras burst path | — | new (`BURST_MODEL`/`BURST_PROVIDER`; OpenRouter fallback route) |

## 7. Privacy & data model (constraints for design)

- The window lives locally (in-memory / encrypted temp), horizon-bounded, never
  synced; panic wipe destroys it instantly.
- `<private>` stripping and auto-redaction happen at capture, as today — the
  window stores post-stripped text. Keyframes: local OCR enables on-device secret
  detection; detected regions are masked before any frame leaves the machine.
- Save is the only write path to memory; every fact carries `save_id` provenance.
- Cost is visible per gesture and per day (existing CostTracker → menu bar).
- Known gap to close in the same release: `csk-`-style API-key patterns in
  redaction (a real key was found OCR'd into memory during benchmarking).

## 8. Open questions for design

1. Action row placement per HUD mode: always visible, revealed on hover, or a
   single expandable button? (The overlay must stay glanceable.)
2. Default/most-prominent N in the chooser: 15 or 30?
3. Where do enrich cards and summon briefs anchor in each HUD mode (Feed vs.
   Ticker vs. Hidden)?
4. Does clicking the HUD steal focus from the user's app? Eng note: the NSPanel
   is non-activating, so buttons can accept clicks without focus theft — design
   should still decide whether hover states imply "this is clickable" everywhere.
5. Timeline density: heat strip + labels + keyframe thumbnails, or also a
   screenshot filmstrip per segment (clutter / privacy-noise tradeoff)?
6. Nudge budget: how many per hour before it reads as nagging?
7. Forgetting review cadence: shutdown-only, or also a rolling "about to expire"
   card during the day?
8. Panic wipe: bare menu-bar action or hold-to-confirm?

## 9. Appendix: benchmark method

Corpus: 2.2M chars of real episode text (63h, smoke tests excluded). Density:
median 2,900 / p90 9,250 chars per active minute. Cloud: Cerebras `gemma-4-31b`,
chunked map (≤24K chars/call, 300-tok JSON summaries) + reduce, `prompt_cache_key`
+ JSON mode; observed quota 100K tok/min, 100 req/min, 6M tok/h. Concurrent calls
serialize per key — fewer, bigger chunks beat wide fan-out (prefill ≈ 25K tok/s;
34K tok in one call = 1.38s; ≤ 60 min fits in ONE call, map-reduce only pays off
above ~90 min). Multimodal: base64 JPEG `image_url`, no `detail` field; OpenRouter
fallback route order WandB → Novita → SiliconFlow, ignore ModelRun (fp4 quant
hallucinates on images). Local: Ollama 0.31, M4 Max 48GB; qwen2.5:3b prefill
1.4–2K tok/s cold, KV-cache repeats ~free; `num_ctx` must be raised from the 4K
default or windows silently truncate. Scripts: `cerebras_burst_bench.py`,
`cerebras_enrich_bench.py`, `ollama_enrich_bench.py` (session scratchpad).
