# Deliberate Capture — UX Handoff (as built + voice destination)

Status: IMPLEMENTED on `feat/deliberate-capture` (working prototype, all flows
verified live against Cerebras + real window data), except §7 (voice / AR agent
destination), which is DESIGNED, NOT BUILT — it is the next increment.
Audience: design — this documents the shipped interaction model so UI can be
drawn properly, and specs the voice destination to be designed alongside.
Excluded: WSM, automated ROIs.

## 1. Concept

> **Capture is passive, free, and ephemeral. Remembering is a deliberate act.
> Intelligence is summoned, not always-on.**

The feed/sense buffers are a rolling window (time horizon, default 8h; item
caps are memory backstops). Nothing reaches long-term memory except through the
user's save gesture. No cloud LLM runs until a gesture; the burst lane
(Cerebras, `gemma-4-31b`) makes gestures feel instant. Existing per-frame cloud
vision and buffer-full auto-distillation are unchanged on this branch (removal
is a later decision), but all new intelligence is gesture-gated.

## 2. Vocabulary (user-facing label · internal name)

- **Window** — rolling record of screen OCR + transcript, last 8h, local only.
- **Save Last Minutes…** · save — distill a range into the knowledge graph.
  The only path by which anything persists. Undo-able for 30s.
- **Call AI on Last Minutes…** · summon — situation brief of the last N min;
  becomes the agent's working context.
- **Build Context from Clipboard** · enrich — one card: what the copied item
  is + how it ties to current activity, and a next step.
- **Select Region… (+ minutes)** — manual ROI grab whose thread is pre-seeded
  with a brief of the last N minutes.
- **Chooser** — the shared range picker (5/15/30/60 + live coverage strings).
- **Card mode** — slim panel showing capture cards without opening the chat.
- **Destination** — where a follow-up conversation goes: `chat` (in-HUD agent
  lane) · `⌨ term` (run.sh-seeded PTY) · `🎙 voice` (§7, planned: live spoken
  session with the AR Sinain agent that sees the screen).

## 3. Entry points (as built)

One native context menu, two triggers: **right-click the eye** and
**right-click the chat panel header**. Top section:

    Save Last Minutes…
    Call AI on Last Minutes…
    Build Context from Clipboard   ⌃⌥⌘C
    Select Region…            ← now opens the minutes chooser first
    ────────────────
    (existing items: Copy Context Seed, …)

The former "Enrich Clipboard" (silent seed rewrite of the clipboard) is
UNIFIED into Build Context: its ⌃⌥⌘C hotkey opens the card, and its output —
the agent-grade seed — is the card's "Copy for agent" action. No feature ever
mutates the clipboard invisibly anymore.

No dedicated buttons were added to the HUD. Save/Call AI/Region open the
chooser; Build Context fires immediately on the clipboard.

## 4. Card mode (as built)

Gestures triggered outside the chat do NOT open the full HUD. The window grows
to a slim card panel (~380×500, top-right anchored — same anchoring as all
state transitions), showing only: an ✕, then the active cards stacked
bottom-up (receipt · enrich · brief · chooser). When the last card is
dismissed, the window shrinks back to the eye. Actions that start a
conversation (Call AI on an enrich card, Ask follow-up on a brief, term
handoff) leave card mode into the full chat surface. Inside the chat, the same
card stack renders bottom-right of the panel instead.

Design note: the card panel is currently an unstyled container of cards + ✕ —
this is the surface most in need of visual design (header? drag? eye glyph?).

## 5. The cards (as built)

**Chooser** — 264px card: title ("Save last… / Call AI on last… / Region ·
brief of last…"), rows `5/15/30/60 min` each with a live coverage string
("Google Chrome, Zed, mic") computed free from window data; 30 highlighted as
default; short-history rows say "only N min so far"; click-outside = ✕ close.

**Situation brief** (Call AI) — 340px:
- Header: "Last 30 minutes" (+ "· partial" when the range was truncated),
  latency badge ("1.46s"), ✕.
- Metadata line: coverage left, **destination toggle right** (`chat | ⌨ term`,
  appears once ready; selection persists for the session). Voice (§7) becomes
  the third option here.
- Body: TIMELINE (relative times + one-clause rows) · CURRENT GOAL · OPEN
  PROBLEMS (orange) · ENTITIES (chips).
- Footer: **[Ask follow-up / Open terminal]** (label follows the toggle) ·
  **[Save this range]**.
- Loading: honest shimmer, never a spinner. Errors: orange border + message,
  incl. quota-partial ("covered 74 of 120 min").

**Build context** (enrich) — 340px:
- Header: "Build context", latency badge ("0.64s · last 10 min"), ✕.
- Focus line: the clipboard item (display preview, 120 chars).
- Body: CONTEXT (one section — what the item is AND how it ties to current
  activity; the model is instructed to say plainly when it's unrelated) · NEXT.
- Footer: **[Call AI]** (hands focus + context to the agent lane, opens chat) ·
  **[Copy for agent]** (writes the FULL original + one
  `——— Context from Sinain ———` block containing the agent-grade seed —
  situation digest + KG facts — for pasting into an external agent; falls back
  to the card's burst context if the seed build fails).
- Clipboard contract: every enrichment path strips at the marker first — the
  card always enriches the user's original content, never Sinain's own output;
  Copy for agent produces at most one context block. The synthesized CONTEXT
  itself is deliberately NOT copyable — it is written for the user about their
  current moment and has no life outside it.

**Save receipt** — 320px, lifecycle:
`Saving last 30 min · IntelliJ, Chrome, mic…` (pulse) → `Saved to memory` with
chips (`12 facts · 4 entities`) + **Undo** link + a draining 30s countdown bar
→ `Committed to memory` (auto-dismiss ~4s) | `Save undone — nothing written` |
error with reason ("nothing to save in that range — it was idle").
Undo is a true cancel: integration into the graph only runs after the window.

**Region + minutes** — no new card. Chooser → native drag-select → the brief
is fetched during the drag and silently attached to the region thread's seed
(first agent turn already knows the last N minutes). Brief failure degrades to
a plain region grab; selection never blocks on the LLM.

## 6. User stories (as built) — abbreviated ACs

- **S1 Save**: menu → chooser → ack ≤ 500ms → receipt with real fact/entity
  counts → 30s undo (cancel-before-write) → committed with `save_id`
  provenance (`source: user_save`).
- **S2 Call AI**: menu → chooser → brief ≤ 2s (30 min) with timeline/goal/
  problems/entities → Ask follow-up seeds the chosen destination with the
  flattened brief; Save this range promotes the same range to memory.
- **S3 Build context**: copy → menu → card ≤ 1s; CONTEXT names the item and
  the link to current work (verified live: "…the branch transplant you're
  doing"); Call AI / Copy give the card somewhere to go.
- **S4 Region + minutes**: select a region and its conversation opens already
  situated in the last N minutes.
- **S5 Honesty**: idle range → explicit refusal; truncated range → "partial";
  quota hit → partial + retry framing; empty clipboard → told so.
- **S6 No HUD tax**: none of the above requires opening the chat.

Measured budgets (real API, real window data): enrich 0.5–1.0s · brief-30
≈1.5s · brief-60 ≈2.2s · save ack ≤0.5s (distill async ~10s) · ~2h of median
session per summon before the token quota bites.

## 7. Voice destination — "Talk to Sinain" (DESIGNED, NOT BUILT)

Everywhere the user can call AI on context, a third destination joins chat and
term: **🎙 voice** — a live, spoken, full-duplex conversation with the Sinain
AR agent that **sees the screen and hears the user**. Backed by ARSinain
(sibling repo), which already ships the entire loop for a phone camera:

    WebRTC (video+mic) → aiortc server
      video → scene gate → Cerebras gemma-4-31b → {bbox,label,suggestion} markers
      audio → VAD → faster-whisper STT → Gemma (streamed) → Piper TTS → spoken reply
      barge-in: talk over it and it stops mid-sentence

The integration swaps the phone camera for the **screen** (sck-capture already
produces the frames) and seeds the session with the same flattened brief the
chat/term destinations get.

**Entry points:**
- Destination toggle on the brief card: `chat | ⌨ term | 🎙 voice` — Ask
  follow-up becomes "Start talking".
- Enrich card: [Call AI] gains a voice variant (design's call on affordance).
- Region flow: voice as a destination — "talk about this region".
- Context menu: a direct "Talk to Sinain…" item (chooser → voice session
  seeded with the brief, no card in between).

**User stories:**
- **V1 Seeded voice session.** Call AI → voice → session opens in ≤ a few
  seconds; Sinain's first utterance is one short situational acknowledgment
  drawn from the brief (not a generic greeting), then it listens.
- **V2 It sees what I see.** During the session Sinain receives live screen
  frames (scene-gated, one vision call per meaningful change) and can be asked
  "what am I looking at / what's wrong here"; its proactive markers can render
  as native region eyes on the real screen.
- **V3 Real conversation.** Full duplex with barge-in; follow-ups carry the
  running exchange + the current marker context (ARSinain already does both).
- **V4 Explicit session boundary.** Voice is a visible, user-started, user-
  ended session: mic + screen-share indicators while live, one click/word to
  end, nothing captured for the session outside it. Frames go to the same
  provider class as today's vision; `<private>`/redaction rules apply to any
  transcript that lands back in the window.
- **V5 The session feeds the window.** The spoken exchange lands in the
  rolling window as transcript (it IS context), so it is save-able like
  everything else — "save the last 15 minutes" after a voice session captures
  the conversation too.

**Eng notes (for feasibility, not design):** v1 can run ARSinain locally
(docker) and connect the overlay via a WebRTC session that publishes a screen
track (from sck-capture's existing frame IPC or `getDisplayMedia`) + mic, and
plays the TTS track; the eye should animate with speaking state. Deeper
integration later: markers → RegionEyePool, transcript → `/feed` as a voice-
session source, brief seeding on session open (same flattened-brief text the
other destinations use). Cerebras key/quota is shared with the burst lane (one
more concurrent consumer — fine at current limits).

**Open design questions (voice):**
1. What does the session look like? (Eye pulsing + menu-bar timer? A slim
   voice bar with waveform + mute + end? Nothing but the eye?)
2. Where do Sinain's spoken replies appear visually, if at all? (Transcript
   line in Ticker idiom? Nothing?)
3. Three-way destination toggle on a 340px card — segmented control still, or
   does voice deserve its own affordance (🎙 icon button beside the footer)?
4. Screen-share consent surface: rely on the OS indicator or add our own?

## 8. Deferred backlog (designed earlier, still out)

Timeline window (scrubber: heat strip, segments, strike-to-redact preview,
panic wipe) · save-this nudges (free signals) · forgetting review replacing
auto-distillation at shutdown/horizon · visual keyframes for text-poor frames
· local warm-window mode (Ollama KV-cache; measured 1.33s warm enrich).

## 9. Open design questions (as-built surfaces)

1. Card-mode panel chrome: header, drag affordance, eye glyph, stacking order.
2. Chooser default N (30 today) and whether region mode defaults differently.
3. Card widths are uniform-ish (320–340px) — one standard card width?
4. Destination toggle placement scales to three options? (See §7 Q3.)
5. RESOLVED: "Enrich Clipboard" is unified into Build Context (§3) — one menu
   item, the seed lives behind "Copy for agent", hotkey opens the card.

## 10. Appendix — ground truth

Branch: `feat/deliberate-capture` (worktree `../sinain-hud-2-capture`), 7
commits on origin/main. Key files: core `src/capture/{burst-client,window-ops,
save-manager}.ts`, routes in `server.ts`, wiring in `index.ts`; overlay
`lib/ui/capture/capture_ui.dart`, `lib/core/models/context_cards.dart`, shell
integration + card mode in `lib/ui/overlay_shell.dart`. Benchmarks: Cerebras
`gemma-4-31b`, prefix cache + JSON mode; density from 63h of real episodes
(median 2,900 chars/min active). ARSinain reference: `../ARSinain` (aiortc,
scene gate, faster-whisper, Piper TTS, barge-in — README architecture diagram).
