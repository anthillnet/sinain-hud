# Work-State Model (WSM) + Athium policy — engineering design

> Engineering companion to the research dossier `.planning/athium-design.md`
> (academic + industry evidence, RELIABLE / PARTIAL / ASPIRATIONAL verdicts).
> This doc maps that evidence onto Sinain's actual architecture and specifies a
> buildable prototype (P0). Where the two disagree, the dossier wins — it carries
> the empirical weight; this doc carries the wiring.

## 0. Naming

`ROI` already means **Region of Interest** in this codebase (`roi-seeds.ts`,
`sinain_roi` MCP tool, `/roi/pending`). The behavioral "return-on-investment"
idea from the brainstorm is renamed to avoid collision:

- **WSM (Work-State Model)** — the *estimation* layer. A persistent, per-user
  belief state over what the user is doing and how it's going.
- **Athium** — the *policy* layer on top of the WSM. Decides whether/when/how to
  assist (a mixed-initiative, value-of-information gate).

## 1. Sensor reality

Sinain is a screen+audio observer, **not** an IDE/editor/keyboard instrument.
The brainstorm's effort signals (`backspace_rate`, `undo_frequency`,
`copy_paste`, `terminal_error_frequency` as counts) are **not observable** and
are represented as *absent*, never `0` (a head trained on a structurally-zero
feature learns garbage). What we actually have:

| Channel | Source | Yields | Cost |
|---|---|---|---|
| Screen cadence | `sck-capture → sense_client` SSIM | change rate, idle gaps, `ssim` | free |
| Screen semantics | OCR (`ocr`, `ocrLines`) + `meta.app`/`windowTitle` | text, app identity, line boxes | LLM (already paid) |
| Screen motion | `motion.py` phase-cross-correlation | scroll velocity, dwell vs churn | free |
| Audio | VAD → transcription → feed | speech presence, conversation density, transcript | LLM (already paid) |
| Memory | triplestore / entity graph | entity/project/topic recurrence, friction | local query |

## 2. Signals: domain-blind, not dev-specific

The cheap local layer carries **no semantics** — it measures the *physics* of
pixels and motion, which mean the same thing for a lawyer, writer, analyst, or
developer. Hardcoded UI semantics (spinners, diff hunks, test ✓/✗, error
banners) encode one app culture and silently scope the product to engineers —
they are banned from the CV layer. Semantics are the VLM's job (language
generalizes); estimation is the WSM's.

Domain-blind primitives (sense_client, free, per-frame):
- **Visual information density** — JPEG compressed size is a free entropy proxy → `cognitive_load`.
- **Change tempo & continuity** — burst vs steady cadence; in-place evolution vs wholesale replacement (scene cut) → `fragmentation`, surface boundaries (the breakpoint oracle for Athium timing).
- **Attention locality** — where change energy concentrates (focused vs scattered vs sweeping) → `exploration_vs_execution`.
- **Motion kinematics** — linear drift (reading), reversing oscillation (re-reading), localized jitter (producing), zero (dwell).
- **Autonomous vs user-driven motion** — content moving on its own (video/playback) vs static artifact → `consumption_vs_production` (the most audience-general cut; impossible from OCR).

Empirical backing (dossier §B/§C): Fogarty & Hudson found *simple* sensors
predict interruptibility as well as rich semantic models — domain-blind physics
beats hardcoded semantics. And `window title + app name` are the most
informative cheap activity signals (~70–90% on coarse types); fine
coding-vs-debugging-vs-reading is *not* recoverable from OS-level signals at all,
so coarse, app-level `activity_type` is the realistic ceiling.

## 3. WSM = a belief state, not a re-derived snapshot

Today the agent loop re-derives "the situation" from scratch every tick and
collapses it into four lossy, stateless projections: `hud` (string), `digest`
(blob, `message-builder.ts`), `SITUATION.md` (`situation-writer.ts`), and region
"threads". Costs: variance (independent re-descriptions disagree), expense (full
context re-stuffed each cycle), and **no temporal continuity** (a snapshot can't
express momentum / dwell / a stuck *trajectory* — exactly what the heads need).

The inversion: the **`WorkStateVector` is the durable source of truth**,
continuously updated by each observation (recursive Bayesian estimation / a
POMDP belief state — the textbook-correct framing, dossier §9 lineage). The four
projections become cheap *renderers* of it: `renderHud(wsm)`,
`renderSituationMd(wsm)` (OpenClaw consumer unchanged), `escalationScore(wsm)`,
`perRegionState(wsm)` (threads become per-region sub-states). Momentum, dwell,
and stuck become belief *trajectories*, not reconstructed snapshots.

Migration is non-breaking: stand WSM up as an observer first; flip one renderer
at a time (SITUATION.md first — file-only consumer; LLM digest last).

## 4. Honest latent tiers (dossier §A/§F — non-negotiable)

Every `WorkStateVector` dimension carries a **verdict tag**. Athium may only
*act on* RELIABLE + PARTIAL dimensions until a dimension's head is
Brier-calibrated against captured labels.

- **RELIABLE (measured descriptors):** `focus_stability`, `attention_fragmentation`, `availability`, `topic_affinity`/`project_recurrence` (memory-grounded — Sinain's strongest axis).
- **PARTIAL (coarse personalized indicators):** `cognitive_load`, `difficulty`, `historical_friction`. Surface as ranges/soft signals.
- **ASPIRATIONAL (hypotheses — internal only, never surfaced, never gate an interrupt until labeled):** `stuckness`, `uncertainty`, `engagement_momentum`, `frustration`. The same effort signals fire for "stuck" and "hard but going fine"; the only specific one is `repeated-same-error` (OCR-recoverable).

## 5. Per-user calibration is the precondition — and the KG is the substrate

The dossier's load-bearing finding: idiographic (per-user) models reach R²~80%
where population models sit <5%; per-user baselining + activity-conditioning is
**the precondition, not a refinement**. Everyone else has to cold-start it.
**Sinain already maintains the personal knowledge graph** — so we *pretrain* the
per-user priors from the triplestore before any live label exists. This is both
the dossier's requirement and the empty-quadrant moat (§G: local +
individual-owned + memory-grounded).

## 6. Athium policy (the decision layer — firmest ground)

Decision rule = **value of information − cost of interruption > τ** (Horvitz
mixed-initiative / VOI). Three field-tested corrections from the dossier (§C):

1. "Don't interrupt flow" → **queue to the next breakpoint** (scene cut), not suppress. Keep an explicit **silent-stuck exception** (momentum-gating misses a quietly-stuck user — and Sinain is screen-only, so especially blind to it).
2. **Back off hard after a rejection** (post-decline offers hit ~62% dismissal).
3. **Productive-struggle cutoff is hard** (assistance dilemma → dependency). Need a need-for-help discriminator before offering; never trigger on mere hesitation.

Action selector = least-intrusive sufficient rung (`silent-log → ambient →
nudge → proactive answer → escalation`) — the overlay's existing
Hidden→Ticker→Feed→Alert→escalation spectrum, chosen principledly.

Score form (dossier §D): **additive-with-threshold + per-factor clip/calibrate**,
*not* the multiplicative `interest×difficulty×goal×capability` (a soft-AND that
zeros on any noisy factor and compounds four noisy estimates).

## 7. Calibration loop (manufactures its own labels)

No ground-truth labels at start → ship the interpretable heuristic, then close
the loop with implicit outcomes Sinain already observes:
- **help-accept** — chat opened via `roi-seeds` / escalation accepted.
- **abandonment** — sense events cease for the surface.
- **1-tap ESM confirm** — overlay micro-prompt fired *at a breakpoint*.

Log `{vector, action, outcome}` (JSONL, like `eval/`); score probability heads
with **Brier**; promote an ASPIRATIONAL dimension to gating-eligible only once its
head is calibrated. This is the bridge to the v2 engine.

## 8. v2 north-star: prediction-as-planning (dossier §I, ConsistencyPlanner)

Once outcomes are logged: replace point-estimate heads with an on-device
multimodal generator that samples plausible *futures* under each candidate action
`{assist, silent, defer}`, computes `time_saved_if_assisted` as the
**counterfactual** between assist/no-assist samples (not a multiplied score), and
represents PARTIAL/ASPIRATIONAL heads honestly as distributions (incl. a
satisfied-exit mode distinct from stuck-abandon). Fast-sampling fits the local
footprint. v2 only — the P0 heuristic ships first.

## 9. Parallel work-states — the thread bank

A single global work-state is wrong the moment the user juggles 3–4 projects.
§3 already frames the WSM as a belief-state *filter*; parallelism is the same
idea as a **bank of filters — one per project-thread**, each persisting and
evolving across attention gaps. Attention routes the current observation to
exactly one thread; the others keep their state and **age**.

**P0 already pretrained the thread keys.** Each topic centroid in
`workstate-prior.json` *is* a thread identity; `bestMatch(surface)` is already
the router; and the per-topic `recurrence` / `distinctDays` / `lastSeen` /
`frictionPrior` are already the per-thread re-engagement and friction priors.

### Thread identity = project, not app
A project spans an IDE + browser + terminal + a doc. **Thread by KG topic, not
by window** — window-threading shatters one project into four. Routing =
`argmax` topic match **with hysteresis** (sticky assignment, the same anti-flap
damping the region-eyes use) so a noisy frame can't flip threads. A surface
matching no topic above threshold spawns an **ephemeral thread** (running-mean
centroid), later anchored to an `entity:*` when the distiller mints it.

### Persistence, decay, switch-as-breakpoint
Each thread carries `{ vector, trajectory[], lastAttendedTs, temperature,
breakpoints[], decision }`. Switching away **is a breakpoint** for the outgoing
thread (finalize + timestamp) — multi-thread makes breakpoint detection trivial,
which Athium's timing needs anyway. The outgoing thread then **cools** on a
working-memory timescale (hours/days) — distinct from the KG's 60-day fact
decay. A thread cold past its own return-cadence is "at risk of being dropped"
(but honor abandonment ≠ failure: a cold thread may be a *satisfied completion*
— carry both modes, don't nag on every cold one).

### Per-thread prognosis (the "anticipate how they go")
The dossier's heads apply **per thread**:
- **next-attention** ← return-cadence prior (`distinctDays`/recurrence) — RELIABLE.
- **at-risk-of-drop** ← cold past cadence (vs satisfied-completion mode).
- **resumption friction** ← left in a high-`difficulty`/error state → pre-stage help.
- **stuck/complete** ← per-thread trajectory — still ASPIRATIONAL; gates nothing until calibrated.

### Switching cost → the highest-value assist
Fragmentation/resumption-lag (Mark et al., dossier §C): every switch costs
resumption time. So the prime multi-thread assist isn't an answer — it's
**killing resumption lag**: on return-to-thread (a breakpoint), surface *"where
you left off"* = the thread's last state + open question + relevant KG facts.
The single-vector design couldn't even express this.

### The product surface: attention-ROI triage, not a binary interrupt
With N threads, Athium stops asking *"interrupt or not?"* and starts **ranking
threads by which most warrants attention** — the dossier's identified whitespace
(§G: "nobody ranks which one most needs you right now"):

```
needScore(thread) = w1·staleness-vs-cadence + w2·assistValue + w3·difficulty
                    (ranked on RELIABLE+PARTIAL; stuckness shown, not scored,
                     until calibrated; the *act* still respects availability)
```

The "ROI tab" becomes a **ranked thread board** — each card: state, trajectory
sparkline, breakpoint markers, attention rank — composed *over* the existing
fine-grained region-threads (within-surface).

### The one genuinely hard problem
**Routing stability** — clean thread segmentation from noisy, app-spanning
surfaces. Hysteresis + topic-centroid matching is the answer; if it flaps,
harden that first.

---

# P0 — the runnable prototype

Goal: *see it in action* on the real KG, backend-only, no Flutter, no WIP-file
edits (`loop.ts`/`types.ts`/`analyzer.ts`/`package.json` are WIP; `index.ts` and
`server.ts` are clean).

### Components

```
sinain-hud-plugin/sinain-memory/
  prior_builder.py     PRETRAIN: triplestore + /embed → workstate-prior.json   (the centerpiece)

sinain-core/src/workstate/        (greenfield — no collisions)
  types.ts     WorkStateVector (verdict-tagged dims), PriorModel, RawFeatures
  prior.ts     load + cache workstate-prior.json
  extractor.ts senseBuffer/feedBuffer → RawFeatures (cheap, no LLM)
  estimator.ts RawFeatures × PriorModel × embedding → WorkStateVector
  policy.ts    Athium v1 additive EU gate → { action, why[] }
  engine.ts    WorkStateEngine: holds prior, own debounced poll, getCurrent(), formatLine()

sinain-core/src/index.ts   construct + start WorkStateEngine (clean file)
sinain-core/src/server.ts  GET /workstate route (clean file)
```

### Pretrain (`prior_builder.py`)
Reads the Oxigraph store (`knowledge-graph.db`) via `triplestore.TripleStore`:
`top_facts_by_confidence` + `entity()` for `value`/`tag`/timestamps, and
`entities_with_attr('name')` for entity nodes. Groups facts under entity topics
by distinctive-tag match, embeds fact `value`s via `embed_client.embed` (core
`/embed`, local fallback), and writes:

```jsonc
PriorModel {
  version, builtAt, factCount, globalReturnRate,
  topics: [{ id, label, centroid: float[384], recurrence,
             frictionPrior, lastSeen, sampleFacts: [...] }],
  activityBaseRates: { "<app/coarse-activity>": rate }
}
```

### Live estimate (debounced poll, no loop.ts coupling)
`WorkStateEngine` runs its own ~2s debounced recompute: `extractor` reads
`senseBuffer.latest()/query()` + `feedBuffer` → `RawFeatures` (current
app/title, switch-rate, dwell, VAD-ish density, recent OCR/transcript text);
`estimator` embeds the current surface and scores it against the prior:
- `cosine(surface, topic.centroid)` → `topic_affinity`/`goal_alignment` (RELIABLE, memory-grounded)
- app switch-rate + dwell → `focus_stability`/`fragmentation` (RELIABLE descriptor)
- matched topic `frictionPrior` + `repeated-same-error` → `difficulty` (PARTIAL)
- effort/dwell proxies → `stuckness` (ASPIRATIONAL — internal only)

`policy` runs the additive EU gate (breakpoint timing, post-reject backoff,
silent-stuck exception) → `{ action, why[] }`.

### Surfaces (P0)
- `GET /workstate` → `{ vector, decision, ts }`
- console line each tick (`formatLine()`), and a `workstate/demo` runner that
  loads the prior, scores a few example surfaces against the **real** KG, and
  prints the vector + decision deterministically (no live capture needed).

WS broadcast to the overlay + the Flutter card are **Phase 1** (they touch the
`OutboundMessage` union in `types.ts`, which is WIP).

### Phasing
- **P0 (this):** pretrain + estimator + policy + `/workstate` + console/demo. See it on the real KG.
- **P1.5 (thread bank, §9):** single-vector → `Map<topicId, ThreadState>`; route-with-hysteresis, per-thread decay, cross-thread `needScore` triage; `/workstate` returns `{ activeThread, board }`. Mostly an `engine.ts` refactor (estimator/policy run per-thread unchanged).
- **P1:** overlay Flutter card; WS broadcast (after `types.ts` lands).
- **P2:** policy times a real offer at a breakpoint; label-capture loop closes.
- **P3:** Brier calibration → promote validated latents; ConsistencyPlanner v2.

---

# P1 — overlay UI: the attention cockpit

The board (§9) becomes a surface in the Flutter overlay. The overlay is an
NSPanel with `sharingType = .none` — **invisible to screen capture**, so it is a
*private cockpit for the user's own glance*, never something seen in a
screenshare. That cuts both ways (design §7): the moment "is this important?"
matters most (mid-meeting) is exactly when the user is the only audience — so the
UI must be **ambient and glance-able, not a dashboard**.

### Principles (binding)
- **Ambient by default, expand on intent.** Calm/quiet unless one thread's need
  is high; the full board is opt-in (hotkey), never always-on.
- **Honesty rendering (dossier §A/§E).** Surface only RELIABLE + PARTIAL state.
  Show **qualitative tiers, never raw scores or uncalibrated confidence numbers**
  (no "0.74"). `stuckness` stays internal until calibrated — it may *color* a
  card but carries no number and no "you're stuck" text. **Checkable evidence,
  not affect**: "left with errors · 1d ago" / "seen 83×", never "you seem
  frustrated." Work-state language, not judgment.
- **Accept/dismiss is first-class** — it is the P2 label channel. Dismiss opens
  the Athium backoff window (§6) and logs a label.
- **Compose with the existing modes**, don't replace them: the board maps onto
  Hidden → Ticker → Feed → Alert, and nests *above* the current region-threads
  (those stay the within-surface Grammarly layer; the project-thread board is the
  coarser layer over them).

### Surfaces (mapped to existing display modes)

**1. Ambient pill (Ticker mode) — the resting state.** One line, top-of-board
thread *only*, shown when its need crosses a threshold; otherwise a calm dot.
```
 ⚠ whisper build · stuck · left 1d ago            (else:  ·  )
```

**2. Thread board (Feed-like, hotkey-summoned).** Ranked cards; the active
thread pinned at the bottom (you're already on it → lowest attention-need).
```
 ATTENTION                                    ▸ on: sinain-anchoring
 ──────────────────────────────────────────────────────────────────
 ⚠ whisper build        cold · 1d    ▄▄▄    left with errors
     ↳ resume: "undefined symbol in whisper-server build"
     [ pick it up ]   [ not now ]
 ◷ teamcity migration   8h           ▃▃
 ◷ gemma hackathon      3h           ▅▅
 ● sinain-anchoring     now          ▄▄·    (active)
```
Card anatomy: project label + coarse-activity glyph · **warmth/age** cue
(color-cooled, not a number) · **trajectory sparkline** (assist-value history)
· **breakpoint ticks** · the **resumption hook** ("where you left off") · the
Athium affordance. Need is conveyed by **order + a 3-tier glyph** (`⚠ now` /
`◷ soon` / `· later`), not a decimal.

**3. Resumption card (the highest-value element, §9).** On a return-to-thread
breakpoint, expand the hook: last state + the open question + relevant KG facts —
this is what kills resumption lag.

**4. The offer (Alert mode) — fired by Athium only at a breakpoint.** A gentle,
dismissible ambient nudge, **never a modal**. Accept opens the assist (chat /
`roi-seed`); dismiss → backoff + label.
```
 ┌ whisper build looks stuck where you left it ─────┐
 │ "undefined symbol in whisper-server build" · 1d  │
 │            [ pick it up ]     [ not now ]         │
 └──────────────────────────────────────────────────┘
```

### Plumbing (the `types.ts` dependency)
- **Push:** core broadcasts `WorkStateView` over the overlay WS as a new
  `OutboundMessage` variant `{ type: "workstate", view }`. Adding that variant to
  the `OutboundMessage` union in `types.ts` is the one reason P1 waits on the
  current `types.ts` WIP to land. `wsHandler.broadcastRaw` already carries it.
- **Feedback (label channel):** overlay → core `POST /workstate/feedback
  { threadId, action: "accept" | "dismiss" }` → `engine.noteRejection()` on
  dismiss + append `{ vector, action, outcome }` to the P2 JSONL. This is what
  lets `stuckness` eventually earn a place in `needScore`.

### Open question to resolve in P1
Project-threads (this board) vs region-threads (existing `regionId` tabs):
confirm the nesting — region-threads render *inside* the active project-thread,
or as a flat peer list. Recommendation: nest, so the cockpit has one coherent
hierarchy (project → regions) rather than two competing thread notions.
