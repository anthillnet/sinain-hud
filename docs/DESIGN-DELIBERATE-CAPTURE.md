# Deliberate Capture — UI Spec (as built)

Status: everything in §2–§8 IS IMPLEMENTED and running on
`feat/deliberate-capture`. §9 (voice destination) is specified but not built.
This document is the single source of truth for design; it describes the
current behavior only — no history, no future backlog beyond §9.

## 1. Model in one paragraph

Sinain keeps a rolling **window** of the user's context (screen OCR + window
titles + transcript; time horizon, default 8h; local only). Three user actions
operate on it — **Save** (persist a range to memory), **Call AI** (situation
brief of a range), **Build Context** (explain the clipboard item against the
window) — plus **Select Region**, which grabs a screen area and pre-seeds its
conversation with a range brief. All intelligence is gesture-gated; latency is
sub-second to ~2s (measured, §8).

## 2. Entry points

One native context menu (macOS NSMenu), opened by **right-click on the eye**
or **right-click on the chat panel header**:

    Save Last Minutes…
    Call AI on Last Minutes…
    Build Context from Clipboard        ⌃⌥⌘C
    Select Region…
    ────────────────
    Copy Context Seed
    Attention Board
    ────────────────
    Reset Window Position ⇧⌘P · Settings… · Quit Sinain

- Save / Call AI / Select Region open the **chooser** (§4) first.
- Build Context fires immediately on the current clipboard text; ⌃⌥⌘C is its
  global hotkey. (There is no separate "Enrich Clipboard" — that feature is
  folded into Build Context's "Copy for agent" action.)
- Eye **double-tap** is a plain region grab (no chooser, no range brief) —
  unchanged legacy shortcut.

There are NO dedicated capture buttons on the HUD.

## 3. Card mode

Any capture gesture (or an arriving card) while the HUD is NOT in chat state
opens **card mode**: the window resizes to ~380×500 (top-right anchored, like
all state transitions) and shows only a ✕ plus the active cards, stacked
bottom-up in fixed order: save receipt · enrich card · brief card · chooser.

- ✕ dismisses everything and collapses back to the eye.
- When the last card is individually dismissed, card mode exits automatically
  (window shrinks back to the eye).
- Actions that start a conversation (brief "Ask follow-up"/"Open terminal",
  enrich "Call AI") leave card mode into the full chat surface.
- In chat state there is no card mode — the same card stack renders inside
  the chat panel, bottom-right, above the composer area.

Design gap: the card-mode panel is an unstyled stack + ✕ today (no header, no
drag affordance, no branding). This surface needs design.

## 4. The chooser (shared by Save · Call AI · Select Region)

264px card. Title varies by action: **"Save last…" / "Call AI on last…" /
"Region · brief of last…"**. Four rows: `5m · 15m · 30m · 60m`, each with a
live coverage string computed from window data with no LLM call — distinct
app names (up to 4) plus `mic` when audio is present, e.g.
"Google Chrome, Zed, mic"; an empty range reads "quiet range". If the window
is younger than an option, the row's string is "only N min so far" (the save
will take what exists). Row `30m` is pre-highlighted and tagged `default`.
Click a row to confirm; ✕ closes. (Backend clamps any request to 1–480 min.)

## 5. The three cards

### 5.1 Situation brief (Call AI)

340px. States: working → ready | error.

- Working: header "**Calling AI · last 30 min**", coverage line, shimmer bars
  (never a spinner).
- Ready header: "**Last 30 minutes**" (+ "**· partial**" if the range was
  truncated to fit one call), latency badge ("1.46s"), ✕.
- Metadata line: coverage left · **destination toggle** right (`chat | ⌨ term`,
  segmented pills; visible only when ready; the choice persists for the app
  session). Voice (§9) is planned as a third pill.
- Body sections, in order: **TIMELINE** (3–5 rows: relative time "−18m" +
  one-clause event) · **CURRENT GOAL** (one sentence) · **OPEN PROBLEMS**
  (orange bullets, ≤3) · **ENTITIES** (chips, ≤6).
- Footer: primary button **"Ask follow-up"** (chat) / **"Open terminal"**
  (term) — label follows the toggle — and **"Save this range"**.
- Behaviors: Ask follow-up sends the flattened brief (timeline + goal +
  problems) into the in-HUD agent lane and opens the chat. Open terminal
  stashes the same text as MAIN's handoff context and opens the run.sh PTY,
  whose seed therefore contains it. Save this range dismisses the card and
  triggers the save flow (§5.3) for the same minutes.
- Error state: orange border + message in place of the body. Includes the
  honest cases: idle range ("that range was idle — nothing to brief on") and
  quota partial.

### 5.2 Build context (enrich)

340px. States: working → ready | error.

- Header: "**Build context**", latency badge ("0.64s · last 10 min"), ✕. The
  context range is fixed at 10 minutes (no chooser for this action).
- Focus line under the header: the clipboard item, single line, ellipsized
  (display preview; the full text is retained behind the card).
- Body when ready: **CONTEXT** — one section, 1–2 sentences naming what the
  copied item is AND tying it to current activity; the model must say plainly
  when the item is unrelated (no forced connections) and is forbidden from
  suggesting actions. There is deliberately NO next-step section: a
  prescriptive step would pre-empt the user's intention and misdirect any
  agent the context is handed to.
- Footer: **"Call AI"** (primary) · **"Copy for agent"**.
  - Call AI → sends `I copied this: <full item>` + `Context: <CONTEXT>` into
    the agent lane, opens chat.
  - Copy for agent → writes to the clipboard: the FULL original item, then one
    `——— Context from Sinain ———` divider, then two context layers:
    `About this item: <CONTEXT>` (item-specific, gesture-fresh) and the
    server-built agent seed (situation digest + knowledge-graph facts — the
    general scene). If the seed build fails, the first layer alone is written.
- Clipboard contract (all paths): before enriching, input is stripped at the
  first `——— Context from Sinain ———` marker, so Sinain never enriches its own
  output and the clipboard never accumulates more than one context block.
- Empty clipboard → error card: "clipboard is empty — copy something first".

### 5.3 Save receipt

320px. Lifecycle (one card, states replace each other):

1. "**Saving last 30 min · Google Chrome, Zed, mic…**" — pulsing glyph.
   Appears ≤ 500ms after the chooser click; distillation runs async (~10s).
2. "**Saved to memory**" — chips `12 facts` `4 entities` (real counts from the
   distiller), an **Undo** link, and a draining countdown bar (30s). Undo is a
   TRUE cancel: nothing has been written to the knowledge graph yet;
   integration only runs when the countdown expires.
3. "**Committed to memory**" — auto-dismisses after ~4s. Facts carry
   `save_id` provenance (`source: user_save`).
   | "**Save undone — nothing written**" (auto-dismisses ~4s)
   | "**Save failed**" + reason (e.g. "nothing to save in that range — it was
   idle").

### 5.4 Select Region + minutes (no new card)

Menu → chooser ("Region · brief of last…") → native drag-select starts. The
range brief is requested the moment the range is picked (it resolves during
the drag) and renders NO card — it is silently attached to the new region
thread's context, ordered before the first agent turn, so even the opening
reply knows the last N minutes. If the brief errors or is late, the region
grab proceeds unchanged (selection never blocks on the LLM; a late brief still
reaches follow-up turns).

## 6. Destinations

Where "talk to the AI about this context" goes. Selected on the brief card's
toggle; enrich's Call AI always targets chat today.

- **chat** — the in-HUD agent lane (MAIN thread). Context arrives as a user
  message carrying the brief/item+context.
- **⌨ term** — a PTY running the agent runner; context is stashed server-side
  (`set_handoff_context`) before the terminal spawns, so the session's seed
  includes it.
- **🎙 voice** — §9, not built.

## 7. Honesty rules (implemented, keep in any redesign)

Idle range → explicit refusal, never an empty success. Truncated range →
"partial" in the header. Quota hit → partial result + retry framing. Empty
clipboard → told so. Loading is always a skeleton shimmer, never a spinner.
Save's undo window is real (cancel-before-write), not cosmetic.

## 8. Measured budgets (real API, real window data)

enrich ≤ 1s (0.49–1.05s measured) · brief 30 min ≈ 1.5s · brief 60 min ≈ 2.2s
· save ack ≤ 0.5s, distill ~10s async · one call covers ≤ ~60 min; ~2h of
median-density session is the per-gesture quota ceiling.

## 9. Voice destination — "Talk to Sinain" (SPEC, NOT BUILT)

A third destination everywhere AI is invoked on context: a live, spoken,
full-duplex session with the Sinain AR agent that **sees the screen and hears
the user**. Backed by the ARSinain repo, which already ships the loop for a
phone camera:

    WebRTC (video+mic) → aiortc server
      video → scene gate → gemma-4-31b vision → {bbox,label,suggestion} markers
      audio → VAD → faster-whisper STT → Gemma (streamed) → Piper TTS → speech
      barge-in: talk over it and it stops mid-sentence

Integration = swap the camera for the screen (sck-capture already produces
frames) and seed the session with the same flattened brief chat/term get.

Entry points: third pill on the brief toggle (`chat | ⌨ term | 🎙 voice`;
primary button becomes "Start talking") · a voice affordance on the enrich
card · voice as a region destination · a direct "Talk to Sinain…" menu item
(chooser → session, no card in between).

Stories: **V1** session opens in seconds; first utterance is a one-line
situational acknowledgment drawn from the brief, then it listens. **V2** it
sees the live screen (scene-gated vision) and can answer "what am I looking
at"; its markers may render as native region eyes. **V3** full duplex with
barge-in; follow-ups carry the running exchange. **V4** explicit session
boundary — visible mic/screen indicators, one action to end, nothing captured
for the session outside it; redaction rules apply to any transcript. **V5**
the spoken exchange lands in the rolling window as transcript, so it is
save-able like everything else.

Voice design questions: session visual (eye pulsing? slim voice bar with
waveform/mute/end?) · are replies transcribed on screen at all · does a
three-way toggle still fit a 340px card or does voice get its own affordance ·
screen-share consent surface.

## 10. Open design questions (as-built surfaces)

1. Card-mode panel chrome (header, drag, branding) — currently bare.
2. One standard card width? (264 chooser / 320 receipt / 340 brief+enrich.)
3. Chooser default N (30 today); different default for region mode?
4. Destination toggle scaling to three options (see §9).

## 11. Ground truth

Branch `feat/deliberate-capture`, worktree `../sinain-hud-2-capture`.
Core: `src/capture/{burst-client,window-ops,save-manager}.ts`, routes in
`server.ts` (`/capture/save`, `/capture/undo`, `/context/summon`,
`/context/enrich`, `/window/coverage`), wiring in `index.ts`.
Overlay: `lib/ui/capture/capture_ui.dart` (all cards),
`lib/core/models/context_cards.dart` (wire models), card mode + menu + flows
in `lib/ui/overlay_shell.dart`. Voice reference: `../ARSinain`.
