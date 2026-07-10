# Save Offer — proactive episode capture (design handoff)

Status: DESIGN SPEC for a prototype build — nothing in §3–§7 exists yet.
This doc is self-contained and current-state-only: §8 lists the shipped
surfaces the feature reuses; everything else is new. Companion docs:
`DESIGN-DELIBERATE-CAPTURE.md` (the shipped capture UI this extends). This
is rung 1 of the autosave trust ladder: manual saves and offer responses are
the training set that eventually earns autosave.

## 1. Model in one paragraph

Today the user must *remember* to save: right-click the eye → "Save Last
Minutes…" → chooser → receipt. The Save Offer inverts the trigger while
keeping every ounce of the consent model: when the user **switches away after
a long, engaged work episode**, Sinain quietly offers *"Save these 47 min?
(IntelliJ, Chrome)"*. One click runs the exact same save lifecycle (receipt →
undo window → commit). Adjusting or dismissing is one gesture. Sinain
proposes, the user disposes — and every response (accept / adjust / dismiss /
ignore) is a training label that teaches the system what a save-worthy
episode looks like, which is what eventually earns autosave.

**Zero LLM cost**: the offer is composed entirely from data the work-state
engine already holds (range, apps, duration). The LLM runs only if the user
accepts — the normal save distillation.

## 2. The moment — when and why an offer appears

- **Trigger**: the episode tracker detects a *breakpoint* — the user leaves
  an episode (a run of activity across a small family of apps) either by a
  sustained context shift to an outside app, or by going idle (the breakpoint
  is emitted when they return, so the offer is seen). Detection is
  deterministic and local: `sinain-core/src/capture/episode-tracker.ts`.
- **Only after episodes worth saving**: long (≥ ~10 engaged minutes — final
  threshold is tuned, not designed) AND loud (real activity: edits, errors
  worked through, calls — not idle dwell). Most breakpoints produce NO offer.
- **The user's attention has just moved elsewhere.** This is the design's
  central tension: the offer refers to the *previous* context while the user
  is entering a *new* one. It must be glanceable-and-ignorable, never a modal,
  never focus-stealing, never covering the new work. Arrival is silent (no
  sound, no dock bounce, no notification center).

## 3. User stories

- **U1 — the one-click save.** Igor finishes a 47-minute debugging block in
  IntelliJ and switches to Slack. A small card appears: *"Save these 47 min?
  IntelliJ, Chrome"*. He clicks **Save** — the familiar receipt takes over
  (Saving… → Saved, 12 facts, Undo, countdown). Total effort: one click,
  versus five gestures today.
- **U2 — the correction that teaches.** The offer proposes *IntelliJ, Chrome,
  Slack*. Slack was gossip, not work. Igor hits **Adjust**, the standard
  chooser opens pre-filled (47 min, three sources ticked), he unticks Slack
  and confirms. The system records the exclusion — future offers for this
  thread stop proposing Slack.
- **U3 — ignoring is free.** An offer appears; Igor is mid-thought in the new
  context and never looks at it. It fades away on its own after ~45 s. No
  badge, no "you have 3 pending offers", no guilt. (Silently logged as an
  implicit weak "no".)
- **U4 — the privacy floor holds.** Igor once excluded mic from a save on this
  thread. No offer for this thread ever proposes mic again, even during call-
  heavy episodes. Excluded-ever means never-proposed.
- **U5 — undo still real.** He accepts an offer, then regrets it. The receipt's
  Undo (30 s, true cancel — nothing written yet) works identically to a manual
  save.
- **U6 — no nagging.** After three dismissed offers in a day, offers stop for
  the rest of the day. Frequency is capped (≤ 3/day) with a cooldown (≥ 45 min
  between offers). The manual menu path is always there.

## 4. The offer card

One new card in the existing card system (stacks with receipt/brief/enrich,
same corner, same ✕-to-dismiss-all).

### Anatomy (top to bottom)

1. **Header**: accent-ringed dot (save-green, same as chooser's save accent) ·
   title **"Save this session?"** · ✕.
2. **The claim, evidence-first** (one line, the heart of the card):
   **"47 min · IntelliJ, Chrome · ended just now"** — duration, source chips,
   recency. Every token is checkable; nothing is inferred prose. Source chips
   render like the chooser's coverage line.
3. **Optional context line** (only when confidently known): the thread label
   the engine already holds, e.g. *"mostly: sinain-hud — websocket reconnect"*.
   When confidence is low the line is simply absent — never hedged filler.
4. **Footer actions**: **Save 47 min** (primary, verb + value, exactly like
   the chooser's confirm button) · **Adjust…** (secondary) · implicit
   dismiss via ✕ or expiry. No "Not now" button — dismissal must not need a
   decision; the ✕ and the fade both mean it.

### States

- `offered` → the card as above. A quiet entrance (fade/slide, no bounce).
- `accepted` → the card **morphs in place into the save receipt** (Saving… →
  Saved → Committed / Undone), so the user never sees two cards for one save.
- `adjusting` → replaced by the standard chooser, pre-filled with the offered
  range and scope (chooser title: "Save last…", N pre-set to 47).
- `dismissed` (✕) → immediate fade.
- `expired` (~45 s untouched) → slow fade. Expiry must be visually silent —
  no draining countdown bar on the offer itself (that idiom means "undo
  window" on the receipt and must not be diluted).

### Copy rules (binding)

- Always name the evidence (minutes, sources, recency). Never psychological
  framing ("you seemed focused"), never fabricated importance ("this looks
  important"), never urgency ("last chance").
- The verb carries the value: "Save 47 min", not "OK"/"Yes".
- Sentence case, one question mark total, no exclamation points.

## 5. What each response teaches (why this card exists)

| Response | Label recorded | Effect on the system |
|---|---|---|
| Save | strong positive | this episode shape (duration, sources, activity) is save-worthy |
| Adjust → save | positive + correction | edited scope/range is supervision for thread membership and duration |
| ✕ dismiss | explicit negative | this episode shape is not save-worthy |
| Expiry (ignored) | weak negative | counted, but lighter than an explicit ✕ |

Labels append to `capture-labels.jsonl` — one JSONL record per offer and per
response, joined by `id`. Offer-acceptance rate over ≥ 30 offers is the published gate (> 70 %)
for graduating to autosave-with-receipt — the designer should treat the offer
card as **the instrument that decides whether autosave ever ships**.

## 6. Guardrails (binding, not tunable by design)

- **Privacy floor**: a source the user has *ever* excluded for a thread is
  never proposed for it. Mic is never proposed unless the user's manual saves
  on that thread consistently include it.
- **Frequency**: ≤ 3 offers/day · ≥ 45 min between offers · 3 consecutive
  dismissals end offers for the day · an episode is offered at most once.
- **Honesty** (inherits capture's rules): if the range's coverage is partial
  or the tail was idle, the evidence line says so ("47 min · 12 min idle at
  the end"). Loading anywhere is shimmer, never a spinner.
- **Provenance**: an accepted offer saves with `source: "offered_save"` —
  distinguishable from `user_save` forever, in the KG and in any "why do you
  know this?" answer.

## 7. Prototype build scope (for eng, so design knows what's real)

New: an episode tracker over the sense stream, an offer composer on its
breakpoints (range + scope from window data, caps/cooldowns, expiry), one
outbound `save_offer` message, the offer card UI, response POSTs, and the
label writer. Reused untouched: breakpoint detection, `assembleWindow`
scoping, `SaveManager` + receipt lifecycle + undo, the chooser (pre-fill is
the only addition), card mode. Nothing here calls an LLM.

## 8. Shipped surfaces this reuses (ground truth)

- Receipt card + undo lifecycle: `DESIGN-DELIBERATE-CAPTURE.md` §5.3;
  `sinain-core/src/capture/save-manager.ts`.
- Chooser (presets + slider + consent box): §4 of the same doc.
- Card mode / stacking / dismiss: §3; `overlay/lib/ui/capture/capture_ui.dart`.
- Breakpoints: `sinain-core/src/capture/episode-tracker.ts` (context-shift +
  idle-gap episode boundaries over the sense stream).

## 9. Open design questions

1. **The arrival affordance** — DECIDED (2026-07-10, as built): **(a) the card
   just appears** in the card corner — evidence and actions visible at once,
   zero extra gestures. Explored alternatives: (b) chip-first, card on intent
   (the wireframes' recommendation — built, then dropped by product call);
   (c) an eye pulse in save-green (mute — no evidence visible).
2. Where do expired/dismissed offers go? Nowhere (current design), or a
   retrievable "recent episodes" list for the "wait, actually yes" case?
3. Should the offer show the two strongest evidence details (e.g. "3 errors
   resolved · 1 call") when available, or is duration + sources + recency
   already the right amount?
4. Multi-display: the offer follows the card corner (current behavior) or the
   display the episode happened on?
5. Does Adjust warrant a lighter in-card scope editor (untick chips inline)
   instead of jumping to the full chooser?
