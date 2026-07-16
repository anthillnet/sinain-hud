# Session Sense — live workflow detection (design)

Status: DESIGN SPEC — nothing in §4–§9 exists yet. Companion docs:
`DESIGN-SAVE-OFFER.md` (rung 1 of the autosave trust ladder — the
retrospective offer this extends), `DESIGN-DELIBERATE-CAPTURE.md` (the
shipped capture UI), `DESIGN-WORK-STATE-MODEL.md` on
`feat/wsm-attention-cockpit` (the estimation layer this borrows from).
Builds on a fresh branch; §10 lists exactly which WSM parts are taken.

## 1. Model in one paragraph

The Apple Watch's *"It looks like you're working out"* is beloved because the
sensors were already recording locally, so accepting the prompt gives
**retroactive credit** from the moment the workout actually started — one tap,
nothing lost, nothing committed without consent. Session Sense is that moment
for knowledge work: Sinain notices a sustained, recognizable workflow —
*"Looks like you're applying for a job — track this session?"* — **while it is
happening**, and one tap turns the whole episode (including the minutes before
the tap) into a tracked, saveable session. The Save Offer (rung 1) speaks
*after* the episode ends; Session Sense (rung 2) speaks *during* it, names it,
and tracks it live. Both feed the same label stream that eventually earns
autosave (rung 3).

**Zero LLM cost until consent**: detection is local embeddings + deterministic
features only. The LLM runs solely after the tap — the tap *is* the gesture
that satisfies the gesture-gated contract.

## 2. Position in the trust ladder

| Rung | Feature | When it speaks | What it knows | LLM |
|---|---|---|---|---|
| 1 | Save Offer (spec'd) | after the episode, at the breakpoint | duration, apps, recency | on accept |
| 2 | **Session Sense (this doc)** | during the episode, at a micro-breakpoint | the above + a semantic label ("job application", "Oxigraph migration") | on accept |
| 3 | Autosave (earned, not built) | never asks | everything rungs 1–2 learned | gated |

Rung 2 is strictly harder than rung 1 on one axis only: it **names the
activity**. A wrong duration is a shrug; a wrong label ("looks like you're
applying for a job" while writing a performance review) is an embarrassment.
The whole design bends around that asymmetry (§6 copy rules, §7 thresholds).

## 3. What the Watch experience decomposes into

1. **Always-on local recording** → shipped: feed/sense ring buffers +
   deterministic T1 episodes to memoryd (`learning/local-curation.ts` — local
   socket write, redacted before it leaves the process, no LLM).
2. **Cheap, conservative on-device classification** → mostly built on the WSM
   branch: 384-dim local embeddings (`embedding/service.ts`, in-process)
   matched against topic centroids; `projectKey` thread identity; dwell /
   switch-rate / warmth physics.
3. **Prompt at a natural moment, once** → the Athium policy
   (`workstate/policy.ts`) already emits `offer-at-breakpoint` with a
   value-of-information gate, rejection backoff, and focus-cost model.
4. **Tap = consent gate, retroactive credit** → shipped: the Save lifecycle
   (`capture/save-manager.ts`, receipt → undo → commit) over a chosen window.

Session Sense is the wiring between these four, plus one new card.

## 4. Detection lifecycle

```
idle ──sustained match──▶ candidate ──breakpoint+gate──▶ prompted ──tap──▶ tracking
                              │                             │                  │
                              └──decay──▶ idle              └──✕/expire──▶ idle │
                                                                               ▼
                                              summary ◀──confirm── ending ◀──decay/scene-cut
```

- **candidate** — a thread's topic similarity stays above threshold for N
  consecutive ticks (dwell hysteresis, ~2–3 min; never prompt off one frame).
  Entering `candidate` immediately records `candidateStartTs` and pins the
  retroactive window (§8) — the Watch's backfill starts here.
- **prompted** — only when Athium says `offer-at-breakpoint`: the nudge rides
  the existing interruption-cost model (focus + speech raise cost; rejection
  cooldown applies). One prompt per thread per cooldown window. Most
  candidates are never prompted — they decay silently or end and fall through
  to the rung-1 Save Offer instead.
- **tracking** — accepted. The thread becomes a first-class *session*: T1
  episodes are tagged with the session id, and warmth decay gives auto-pause /
  auto-resume for free (switch to Slack → session pauses; return → resumes).
  A quiet cockpit chip shows the running session (label · elapsed · pause dot);
  tapping it ends the session early.
- **ending** — sustained warmth decay or a hard scene-cut away →
  *"Wrap up the job-application session? 38 min"* — the symmetric "End
  workout?" prompt. Ignorable; expiry auto-wraps after a grace period (a
  session must never run forever because the user walked away).
- **summary** — the normal Save distillation over the full session span
  (candidateStart → end, possibly spanning multiple buffer generations),
  rendered as the standard receipt → the "workout summary": facts, entities,
  decisions, undo. This quietly fixes the long-session failure where early
  context expires before the user ever saves.

## 5. Detection: the autosave detector, surfaced mid-episode

REWRITTEN 2026-07-16 (product call): no classifier, no prototype taxonomy, no
priors. Guessing which workflows a user has is unanswerable — users have
unbounded, idiosyncratic workflows, and a curated centroid library is WSM's
idea re-derived. The shipped autosave detection already knows the only thing
the nudge needs: *"the user has been engaged on this thread family for N
minutes"*.

- **Trigger**: `episode-tracker.ts` (shipped, deterministic — thread identity
  + engaged dwell) gains a mid-episode `qualified` hook: fired once when a
  live episode crosses `SESSION_SENSE_QUALIFY_MINUTES` (default 8). The same
  "long, engaged" signal the save offer waits for at the breakpoint, asked
  while the user is still in it.
- **Label**: the thread's own label — the exact source of the save offer's
  "mostly: …" line. The card never claims more than the window title shows.
- **Fingerprints (the learning loop)**: accepting a nudge (or correcting its
  label) records `thread → confirmed label`. The next qualification on that
  thread greets with the user's own answer — *"Back on: websocket
  reconnect"* — not the raw title. The future guess is the user's past
  answer; a lookup table their accepts build, not a model.

Cold start is honest: day one, the card says "Looks like you're working on:
<window title>" — true by construction. It personalizes only through consent
moments.

## 6. The nudge card

One new card in the existing card system (stacks with receipt/brief/offer,
same corner, same ✕). Anatomy, top to bottom:

1. **Header**: accent-ringed dot (track-accent) · title **"Track this
   session?"** · ✕.
2. **The claim, evidence-first**: **"Looks like: job application · 4 min in ·
   Chrome, Pages"** — label, elapsed-so-far, source chips. Every token
   checkable.
3. **Footer**: **Track session** (primary — the verb carries the value) ·
   **Wrong?** (quiet text affordance → inline label picker: the top-3 other
   candidates + "just work") · implicit dismiss via ✕ or expiry (~45 s slow
   fade, visually silent).

### Confidence-graded copy (binding)

| Confidence | Label line | Example |
|---|---|---|
| high, personal prior | topic's own label, familiar phrasing | "Back on: sinain-hud — websocket reconnect" |
| high, stock prototype | "Looks like: <workflow>" | "Looks like: applying for a job" |
| medium | **no label** — degrade to rung-1 phrasing | "Track this session? · 5 min in · Chrome, Pages" |
| low | no card. Silence. | — |

- Never psychological framing ("you seemed stressed"), never inferred stakes
  ("this looks important"), never urgency. Sentence case, one question mark,
  no exclamation points.
- A wrong label must cost the user one glance, not one correction: the
  medium-confidence fallback drops the label rather than hedging it
  ("possibly applying for a job?" is banned — hedged filler).

## 7. Guardrails (binding)

- **Frequency** (simplified 2026-07-16 — product call: Watch-simple, no
  budget machinery): a thread is nudged **at most once per day**, one card on
  screen at a time, and the 2–3 min dwell hysteresis is the whole prompting
  etiquette. No shared day caps, no cooldowns, no dismissal streaks — those
  suppressors made the nudge undebuggably quiet in practice. Rung 1 keeps its
  own budget for its own offers.
- **Category floor**: detected medical, dating, personal-finance, and
  job-search-adjacent-HR (e.g. filing a grievance) workflows are **never
  nudged with a label**, regardless of confidence — at most the unlabeled
  medium-confidence card, and for medical/dating: nothing. "Looks like you're
  researching a diagnosis" is the prompt that destroys trust permanently.
  The denylist is category-level on stock prototypes (a static flag in the
  asset), not a runtime content filter.
- **Privacy floor** (inherited from rung 1): ever-excluded sources for a
  thread are never proposed; mic is never proposed unless the user's manual
  saves on that thread consistently include it. Detection reads only the
  already-redacted local streams.
- **Contract**: detection and prompting are LLM-free by construction. The
  distillation LLM runs only after the tap. Ships behind
  `SESSION_SENSE_ENABLED` (default `false`) — it is an autonomous lane and
  follows the opt-in convention.
- **Provenance**: sessions save with `source: "session_sense"` —
  distinguishable from `user_save` and `offered_save` forever.

## 8. Retroactive credit mechanics

The magic moment is the backfill; it must be real, not approximate.

- On `candidate`, record `candidateStartTs` and snapshot the current buffer
  cursor. The feed buffer holds 100 items — a long pre-prompt candidate can
  outlive it, so the **memoryd T1 episode stream is the durable source**:
  episodes are already deterministic, redacted-then-persisted, and survive
  buffer wraps. Backfill = live buffers ∪ session-tagged + time-overlapping T1
  episodes over `[candidateStartTs, endTs]`.
- The summary receipt states the credited span honestly ("41 min · from
  11:02"), including idle gaps the warmth model paused ("8 min paused").
- Undo remains a true cancel — nothing written until the receipt commits.

## 9. What each response teaches

| Response | Label | Effect |
|---|---|---|
| Track | strong positive + label confirm | episode shape AND label are right — the highest-value label in the ladder |
| Wrong? → pick | positive + label correction | direct supervision for the classifier; corrected label trains the personal prototype |
| ✕ dismiss | explicit negative | this shape/label is not track-worthy |
| Expiry | weak negative | counted lighter than ✕ |
| End-prompt confirm | boundary label | teaches session-boundary detection |
| Cockpit chip early-end | boundary correction | the decay model ended too late |

All append to `capture-labels.jsonl` (rung-1 format, `kind: "session_sense"`),
joined by `id`. Graduation gate to any autosave conversation: label-confirmed
precision > 80 % over ≥ 30 nudges — measured, not vibes.

## 10. Build scope

**Taken from `feat/wsm-attention-cockpit` (cherry-picked, trimmed to what §4
needs):**

- `workstate/types.ts` — `WorkStateVector`, `MatchedTopic`, `PriorModel`,
  `RawFeatures` (`projectKey`, `sceneCut`), verdict tags.
- `workstate/prior.ts` + `sinain-memory/prior_builder.py` — personal topic
  centroids.
- `workstate/policy.ts` — Athium gate (`offer-at-breakpoint`, rejection
  backoff). Used as-is; Session Sense is just a new consumer of its decision.
- `workstate/extractor.ts` / `semantic-id.ts` — feature extraction and thread
  identity, as needed by the above.
- NOT taken: cockpit UI, `engine.ts` in full, memory_v2 compaction changes —
  the fresh branch stays minimal.

**Reused untouched (shipped on main):**

- `capture/episode-tracker.ts` — breakpoints (context-shift + idle-gap).
- `capture/save-manager.ts` + receipt/undo lifecycle, chooser pre-fill.
- `capture/thread-identity.ts`, card mode/stacking
  (`overlay/lib/ui/capture/capture_ui.dart`).
- `embedding/service.ts` — local MiniLM embeddings.
- `learning/local-curation.ts` T1 episode path (gains a session-id tag).

**New:**

- `capture/session-sense.ts` — the §4 state machine (candidate hysteresis,
  Athium consumption, session state, warmth pause/resume, end detection).
- Stock workflow prototype asset + offline builder script.
- One outbound `session_nudge` WS message + response POSTs; one nudge card and
  one running-session chip in the overlay; end-prompt card.
- Label writer entries (`kind: "session_sense"`).

## 11. Open design questions

1. **Nudge vs Save Offer collision** — a candidate that is never prompted ends
   as a rung-1 Save Offer. But if a nudge was shown and expired, does the
   end-of-episode Save Offer still fire (second ask about the same episode),
   or does nudge-expiry consume the episode's one offer? Leaning: expiry
   consumes it — one ask per episode, ever.
2. **Stock prototype curation** — who writes the canonical descriptions, how
   many per workflow, and how is the library versioned/refreshed without an
   app release?
3. **Cross-day sessions** — a job application spanning three evenings: three
   sessions linked by thread id, or one resumable session? Leaning: three
   sessions, one thread — matches the Watch (three workouts, one habit).
4. **The running-session chip** — persistent while tracking (Watch-style
   in-progress ring) or only visible in the cockpit? Persistent glanceable
   state is half the Watch's charm, but the overlay's idiom is quietness.
5. **Return-cadence resumption** (*"you usually work on X mornings —
   resume?"*) — `distinctDays` supports it today. Phase 3 at the earliest;
   noise risk if sooner.

## 12. Phasing

1. **P0** — lifecycle + nudge + retroactive save, personal priors only,
   unlabeled medium-confidence copy allowed. Proves the loop end-to-end.
2. **P1** — stock workflow prototypes + confidence-graded labels + "Wrong?"
   picker + calibration wiring. This is where "looks like you're applying for
   a job" ships.
3. **P2** — return-cadence resumption, session streaks/history in the wiki,
   per-workflow deterministic assists (contract-safe checklists) — each gated
   on the P1 precision numbers.
