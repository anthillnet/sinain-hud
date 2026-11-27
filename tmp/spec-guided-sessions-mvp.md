# Guided Sessions — live-copilot MVP spec (v2, layered)

_2026-07-22. v2 after review: v1 required pack structure (playbook/cards/moves.yaml)
to start a session — too strictly scripted. Structure is now a ladder: everything
above a one-line intent is optional. Bench-side rigor (frozen enums, schemas) stays
on the bench, where it earns its keep; the runtime never requires it._

## Concept

A **Guided Session** is a deliberate session where sinain coaches a live activity in
real time. The engine ships one universal discipline; context is whatever the user
has, from one sentence to a full tuned pack.

### Universal engine discipline (engine-owned, applies at every level)

- Silence is the default; over-alerting kills glance-trust in any activity.
- Two-zone display: Zone 1 = persistent thesis card ("what is this about NOW",
  set by the 0-2 moments that change the activity's governing state); Zone 2 =
  throttled tactical line (anchor in THEIR verbatim words + one imperative + the
  exact sentence to say).
- One active interrupt; passive rate limits; one rescue re-issue; retire on
  resolution (never coach over working instincts); never fire mid-turn.

### Context ladder (all levels optional except L0)

- **L0 — intent.** One line, typed or spoken, at session start: "salary negotiation
  with my manager". Open-vocabulary suggestions; universal discipline only.
- **L1 — freeform context.** Drag/paste anything: agenda, notes, JD, CV, deal
  history, last session's summary. No format. Used as background + say-line source.
- **L2 — light goals.** Objective + bullets: must-ask / must-avoid / red lines.
  Engine tracks coverage ("budget question not asked yet") and flags red-line drift.
- **L3 — full pack.** Playbook + situation cards + fixed move vocabulary + bench.
  Earned by repetition, not required. FMG sales calls live here.

## Session flow (MVP)

1. Hotkey or notch-island tap → "Start guided session".
2. Start card: intent line (required, one field) + optional attach zone (files/paste)
   + recent-context suggestions (last docs used for this kind of intent, date-sorted
   prep files if a pack exists) + capture selection (audio / screen / both, defaulted).
3. **One confirm tap** = the explicit gesture: loads context, authorizes the cloud
   LLM lane for this session, starts the selected capture streams. No auto-load, ever.
4. Live: per-utterance (or per-screen-change) engine tick; orchestrator in sinain-core
   owns two-zone state; overlay renders. On-demand asks via hotkey: "where are we /
   next line / help with this".
5. End/Save: existing save gesture → distillation; outcomes feed the knowledge graph.

## Packs as crystallized use (L3)

```
~/.sinain/packs/<pack-id>/
  pack.yaml       # manifest: inputs, tick policy, room modes, engine knobs
  playbook.md     # backbone script
  cards/*.md      # situation cards: trigger -> prepared response
  moves.yaml      # optional fixed vocabulary (mainly for benching)
  prep/*.md       # dated per-instance docs (frontmatter: roles/variables)
  bench/          # optional: annotations + eval cases (fmg contract format)
```

- Packs are grown, not demanded: repeated L0-L2 sessions on the same activity +
  distillation → sinain proposes cards ("you've answered 'we already have a vendor'
  4 times — save this response?"). The annotate → adjudicate → convert → run_evals
  loop (fmg repo `engine/`) drafts a bench when the user wants to tune.
- Template variables in playbook/prep resolve at load; the engine never sees raw
  placeholders.
- Room modes (buyer/router/... or interview panel/1:1, pack-defined) modulate
  suggestions when present; one-tap toggle mid-session.
- First full pack: `sales-call-fmg` (playbook/cards/moves from the fmg context pack;
  bench = 493-case corpus). It is the tuning target, not the template every activity
  must copy.

## MVP cut — REUSE the "Call sinain" lane (decision 2026-07-22)

No new session module. The guided session IS a Call-sinain voice session
(`VoiceSessionManager`, `sinain-core/src/capture/voice-session.ts`) with explicit
context/instruction added to the seed:

- **Entry**: re-enable the hidden "Call sinain" button (`capture_ui.dart` — shown when
  `onCallSinain` is non-null); the chooser gains an intent line + attach zone. The
  existing range chooser already covers "seed with last N minutes".
- **Seed extension**: `voiceSeed()` text = summonBrief (existing) + intent + attached
  docs/pack + the teleprompter instruction block (same discipline prompt the eval
  adapter uses — eval/live parity by construction). Delivered over the existing meta
  datachannel.
- **Staying in the loop**: the ar-bridge already streams mic+screen continuously to
  the ARSinain server — the loop is the lane's native property, not new code.
- **Hint display**: hints stream back over the existing caption channel
  (`voiceEngineEvent` caption → live chip captions). Two-zone rendering = evolving the
  live-call chip (thesis line pinned, tactical caption below), not a new surface.
- **Silent mode**: teleprompter sessions instruct the agent captions-only (no spoken
  audio); voice reply stays available as an option for other guided activities.
- Out of scope: calendar suggestions, KG-driven prep enrichment, card-proposal
  ("grow a pack") automation, multi-speaker diarization, partial-hypothesis STT.

## Eval note

Strict schemas/enums live in `bench/` only — they make scoring objective
(move-equivalence, verbatim anchors). L0-L2 sessions are evaluated qualitatively
until an activity earns a bench; the universal-discipline knobs tuned on the FMG
bench (timing, volume, silence) transfer to all levels.
