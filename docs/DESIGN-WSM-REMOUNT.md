# WSM × Deliberate Capture — the remount, and the autosave ladder

> Companion to `DESIGN-WSM-prediction.md` (the five heads, Resume Card),
> `DESIGN-WSM-SIGNAL-INVENTORY.md` (per-thread signal sourcing), and — on main —
> `DESIGN-DELIBERATE-CAPTURE.md` (the capture UI spec as built, PR #244).
>
> Scope: how the WSM/attention-cockpit branch remounts on the updated main
> (which now ships deliberate capture), what new signals/actions/tokens that
> unlocks, and the staged path from manual Save to autosave. Design only;
> landing order is at the end.

## 1. The reframe in one sentence

WSM was built on *ambient inference over thin buffers* — guessing what matters
from a ~30-event sense ring. Updated main gives it two things it never had: an
**8-hour window of raw history** (`assembleWindow` over the widened buffers)
and, more importantly, a stream of **deliberate gestures that are ground-truth
attention labels** — every Save/Call/Region/Clipboard action is the user
pointing at what mattered, over which span, from which sources. WSM should
remount not as a smarter guesser but as the thing that *learns from what the
user explicitly promotes* — and eventually pays it back by making the saves
itself (§6).

The through-line: **manual saves aren't the product, they're the training
set.** Deliberate capture is the labeling instrument WSM was missing.

## 2. New signals, ranked by how much they change the model

**S1 — The source checklist is thread-membership supervision.** The router
attributes observations to threads by app/window/KG similarity with
hysteresis. Every scoped save (`WindowScope.apps` in
`src/capture/window-ops.ts`) is the user drawing the thread boundary by hand:
"this 45-min episode = IntelliJ + Chrome, *not* Slack, *not* mic." That is a
labeled example for the exact problem the router guesses at.

- `ThreadState` (in `src/workstate/engine.ts`) grows `apps: string[]`,
  learned from scope corrections.
- Repeated exclusions (Slack unticked three times) become durable negative
  weights — and arguably a signal to never mint a thread for that app at all.

**S2 — The chosen range is a duration label.** The chooser's N (5–120 min) is
the user's own estimate of the episode's extent — direct supervision for the
`focusBand` head, which today is derived from timing heuristics. Actual
attend-span vs chosen-range is calibration data for free.

**S3 — Save receipts are importance weights.** A thread whose ranges get saved
(`user_save` provenance, real fact/entity counts from the distiller) is a
thread worth being loud about in the cockpit. The prior refresh already rides
distillation — `user_save` digests should weight prior entries above ambient
ones.

**S4 — The burst lane dissolves the signal inventory's central constraint.**
`DESIGN-WSM-SIGNAL-INVENTORY.md §0` found that global signals (digest,
SITUATION) describe *now*, so a Resume Card needs a per-thread snapshot frozen
at switch-away — and prose synthesis was the missing, expensive part. Now:

- At breakpoint, **freeze the raw scoped slice for free** —
  `assembleWindow(...)` with `{apps: thread.apps}` is exactly the primitive,
  already built and merged.
- **Defer the LLM to card-open**: when the user actually looks at the Resume
  Card, one burst call (`src/capture/burst-client.ts`, ~1.5 s, ~$0.001) turns
  the frozen slice into the `resume_brief`.
- This preserves the deliberate-LLM philosophy exactly: zero ambient LLM
  calls, prose on gesture. `LastWork` (already on `ThreadState` as
  `lastWork`/`liveWork`) gains a `slice` field; `brief` becomes lazily
  materialized and cached.

**S5 — Voice sessions are high-grade episodes.** A call is the strongest
attention marker there is: its seed says what the thread was, captions say
what the user cared about, "Save call" is an explicit promotion. Calls land in
the thread trajectory as first-class events; thread state at call-start is a
snapshot moment.

**S6 — Region threads arrive pre-briefed.** The region flow stashes a window
brief into the thread before the first turn (`set_handoff_context`). That is a
birth-certificate snapshot WSM adopts as the thread's initial `LastWork`
instead of starting blind.

## 3. New actions — the cockpit stops being read-only

The Resume Card's buttons were hypothetical; every one now maps to a shipped
verb on main:

| Card verb | Maps to |
|---|---|
| **Continue** | open the thread (exists) |
| **Save this episode** | `POST /capture/save` pre-filled with the thread's span + app scope — the *same consent card*, pre-populated by WSM. User edits to the prefill are more supervision (WSM proposes the scope, corrections retrain the router). |
| **Brief me** | scoped summon (`/context/summon` over the thread's apps since last-attended) — "what changed while away," computed honestly |
| **Call sinain about this** | voice session seeded with the frozen `LastWork` instead of a generic range |

One new proactive-but-consensual move: on a **breakpoint after a long, loud
episode**, the cockpit may *offer* "Save these 47 min? (IntelliJ, Chrome)" —
WSM proposes, the user disposes through the normal receipt/undo lifecycle.
That is the nudge design that stays inside the consent model, and it is rung 1
of the ladder (§6).

## 4. New tokens for the prediction heads

The tokenizer vocabulary (`src/workstate/tokenizer.ts`) extends naturally:

```
GESTURE_SAVE · GESTURE_CALL_TEXT · GESTURE_CALL_VOICE · GESTURE_REGION ·
GESTURE_CLIPBOARD · SCOPE_TRIMMED (user excluded sources) ·
RANGE_{15,30,60}M · SAVED_WHILE_AWAY · CALL_OCCURRED
```

`nextActions`' closed vocabulary grows the four capture verbs — and gets
labeled by which verb the user actually picks after a return, which today has
no label source at all.

## 5. Remount mechanics (the unglamorous part)

The branch predates the capture transplant, so the merge is real work:

- `types.ts` — the `OutboundMessage` union has capture messages on one side
  (`window_card` family, §"Deliberate capture" block) and `workstate` on the
  other; merge both.
- `server.ts` routes (`/capture/save`, `/capture/undo`, `/context/summon`,
  `/context/enrich`, `/window/coverage`) vs the workstate endpoints.
- Overlay `_onMessage` in `websocket_service.dart` + `overlay_shell.dart`:
  card mode and the cockpit need a coexistence rule — **the cockpit is
  arguably just another card in the column now.**
- The engine's self-paced poll was tuned for a 30-event ring; against
  3000-event/8 h buffers it must go **incremental (watermark, not full
  rescan)**.
- `WindowScope` becomes the *shared* slicing vocabulary — WSM must not grow
  its own.

## 6. Autosave — the trust ladder

### 6.1 Consent moves from before the save to around it

The design promise is "nothing persists without consent." Autosave keeps the
promise if consent moves from *before* (the chooser) to *around* (the
receipt): every autosave is **announced with the existing receipt card and
reversible** — same lifecycle, `auto_save` provenance instead of `user_save`,
with a longer undo horizon (visible in the cockpit for a day with a "forget"
affordance, not just 30 s). The chooser is consent-by-configuration; the
receipt is consent-by-veto. All the UI for this already exists
(`SaveManager`, receipt states, undo-as-true-cancel).

### 6.2 What autosave actually replaces

There is already an ambient pipeline — incremental distillation fires on
buffer-full (`feed-buffer.ts onFull` → `local-curation.ts`). But it is
**volume-triggered, thread-blind, and unscoped**. Autosave done right is that
pipeline rebuilt on WSM's spine:

| Dimension | Buffer-full distillation (today) | Autosave (target) |
|---|---|---|
| When | every 100 items | episode boundaries (breakpoints — already detected, already flowing to memoryd episodes) |
| Range | whatever accumulated | the episode's actual span |
| Scope | everything | the thread's learned `apps`, minus learned exclusions |
| Whether | always | an importance gate — not every episode deserves the KG |

Endgame: buffer-full distillation retires; the KG becomes episode-structured
with per-save provenance, and "why do you know this?" always has an answer
("auto-saved from Tuesday's WSM episode — here's the receipt").

### 6.3 The four stages, each gated by measured precision

**Stage 0 — shadow mode (start here; zero user impact).** At every episode
boundary, WSM composes the save it *would* make (range, scope, importance
score) and only logs it. Manual saves are ground truth: shadow decisions that
overlap a user save = true positives; shadowed-but-never-saved = candidate
negatives. Precision is estimated before anyone sees a single autosave.

**Stage 1 — offers.** "Save these 47 min? (IntelliJ, Chrome)" at loud
breakpoints. Every accept/reject is a strong label — this rung exists mostly
to convert stage-0's weak implicit negatives into explicit ones.

**Stage 2 — autosave with receipt; offers for the gray zone.**
High-confidence episodes save themselves and announce it; medium-confidence
still asks. Undone receipts are negative labels; untouched commits are weak
positives. The loop closes in production.

**Stage 3 — silent autosave + forgetting review.** Saves stop announcing
individually; a daily digest (the deferred "forgetting review") lets the user
prune. Manual Save Context survives as the override for "I know this
mattered."

### 6.4 Stage gates (measured, not vibes)

| Promotion | Gate |
|---|---|
| 0 → 1 | shadow precision vs manual saves looks usable (directional; no hard number — stage 1 is itself a labeling instrument) |
| 1 → 2 | offer-acceptance **> 70 %** over ≥ 30 offers |
| 2 → 3 | undo rate **< 5 %** over a comparable window |
| standing guardrail | retrieval quality must not regress as autosave volume grows — autosave cannot silently bloat the KG into worse recall (watch the LongMemEval-style audit numbers) |

Demotion is symmetric: crossing the guardrail or a rising undo rate drops a
stage.

### 6.5 Label schema

One JSONL channel, `capture-labels.jsonl` (sibling of
`workstate-labels.jsonl` / `workstate-returns.jsonl` in the memory dir), one
record per shadow/offer/auto decision:

```jsonc
{
  "id": "cap_...",            // decision id
  "ts": 0,
  "stage": 0,                  // ladder stage that produced it
  "threadId": "proj:...",
  "episode": { "startTs": 0, "endTs": 0, "breakpointTs": 0 },
  "proposal": {
    "rangeMinutes": 47,
    "scope": { "apps": ["IntelliJ IDEA", "Google Chrome"] },
    "importance": 0.0,         // gate score
    "drivers": ["long_episode", "roi_engaged", "user_save_history"]
  },
  "decision": "shadow" | "offered" | "auto_saved" | "skipped",
  "outcome": {                 // filled in as evidence arrives
    "userSaveOverlap": null,   // stage 0: save_id of an overlapping manual save
    "offerResponse": null,     // stage 1: "accepted" | "rejected" | "edited"
    "editedScope": null,       // scope after user edits (supervision for S1)
    "editedRange": null,
    "undone": null,            // stage 2/3: receipt undone?
    "factCount": null, "entityCount": null   // from the distiller, when saved
  }
}
```

`user_save` vs `auto_save` provenance stays distinguishable **forever**, in
the KG and in retrieval explanations — trust in memory is only inspectable if
you can tell who saved what.

### 6.6 Hard edges

- **Asymmetric failure costs.** Missing an episode is recoverable (user saves
  manually). Saving junk degrades retrieval. Auto-including a source the user
  would have excluded is the worst case — a privacy violation by the feature
  whose whole identity is consent. Hence: conservative importance gate, and a
  **privacy floor** — any source the user has *ever* excluded for a thread is
  never auto-included for it; mic is out unless manual saves consistently
  include it.
- **The Athium policy gate is the natural home** for the skip/offer/save
  decision (`src/workstate/policy.ts`) — it already decides attention
  loudness; this is the same decision with a side effect.
- **Provenance discipline** (§6.5) is non-negotiable.

## 7. Landing order

- **P0 — signal capture, no UI.** Rebase the branch onto main (§5). `apps` on
  `ThreadState`; capture gestures flow into the engine as events/tokens
  (S1–S3, §4). Shadow-mode logging (§6.3 stage 0) starts the day this lands —
  it needs nothing visible.
- **P1 — the cockpit pays it back.** Frozen-slice `LastWork` + lazy burst
  brief (S4); Resume Card verbs wired to the shipped endpoints (§3); voice +
  region adoption (S5–S6).
- **P2 — the ladder climbs.** Breakpoint save-offers (stage 1); head
  retraining on the new labels; stage 2+ strictly behind the §6.4 gates.

What is genuinely new to build: the **importance model** and the
**shadow-mode evaluation harness**. Everything else — SaveManager, receipts,
undo, scoping, distillation, memoryd episodes, the policy gate, the feedback
prompt — already shipped on one side of the merge or the other.
