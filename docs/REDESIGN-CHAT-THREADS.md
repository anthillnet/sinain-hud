# Redesign: Chat + Terminal Threads

Status: design — approved direction, not yet implemented.
Owner: Igor. Drafted 2026-06-11.

## The model

Two interaction surfaces, one mental model:

- **Everything is a thread.** A thread is one agent conversation with a
  persistent session. Every thread can be driven as **chat** or as a
  **terminal** — two faces of the *same* agent session — and the user can
  switch between them at any time, per thread.
- **MAIN** is the always-existing thread. While the user is idle, the ambient
  escalation pipeline (toggleable) posts into MAIN. Escalation is an
  *idle-time mechanic*: any user interaction with any chat or terminal pauses
  it (quiet window); idleness resumes it.
- **Threads are created two ways:**
  1. **ROI tap** → banner offers **[💬 Chat] [⌨ Term]** — same thread, same
     seeded region context, the buttons only pick the initial surface.
  2. **Fork MAIN** → new thread inheriting MAIN's conversation history.
- **No autonomous spawn tasks.** The system never starts agent work on its
  own. The spawn mechanic (queue, LLM-suggested spawns, Shift+Enter spawn
  input, spawn status chips) is removed. The roster's two lanes map to the
  two mechanics that remain: **ambient** (escalations into MAIN) and
  **threads** (user-initiated conversations).

## Chat widget (OSS) — research result

Verified on pub.dev, 2026-06-11:

| package | version | license | adoption | fit |
|---|---|---|---|---|
| **flutter_chat_ui** (flyer.chat) | 2.11.1 | Apache-2.0 | 1.6k likes, 76k downloads, verified publisher | Modular v2 (`flutter_chat_core` + ui), explicitly built "for real-time apps and generative AI agents", full macOS/Windows/Linux, deep theming + custom message builders |
| chatview (Simform) | 3.0.0 | MIT | 649 likes | Messenger-style: reactions, voice notes, read receipts — mobile-first semantics we don't need |
| flutter_gen_ai_chat_ui | 2.14.0 | MIT | 93 likes, published 10 days ago | Purpose-built LLM chat: word-streaming animation, markdown + code highlighting, dark theming; young/small community |

**Recommendation: flyer `flutter_chat_ui` v2** — the maturity + modularity +
genAI orientation match exactly; we keep our own message transport (WS) and
feed it a `ChatController`. **Fallback:** `flutter_gen_ai_chat_ui` if flyer's
theming fights the translucent HUD (P1 validates this in a day — same playbook
as the xterm.dart spike). chatview rejected: messenger semantics ≠ agent chat.

Mirrors the terminal decision: pure Flutter → renders inside the private
NSPanel, capture-invisibility inherited, no platform views.

## Session continuity (the crux)

A thread's chat and terminal must share one agent session.

- **Thread registry** (core): `threadId → { agentSessionId, mode: chat|term,
  title, origin: roi|fork, regionId? }`. MAIN is `threadId: "main"`.
- **claude / openclaude**: chat message = headless `claude -p --resume <sid>
  "<msg>"`; terminal = interactive `claude --resume <sid>`; fork =
  `--fork-session`. Same on-disk session store → switching surfaces preserves
  the full conversation.
- **hermes**: `--resume SESSION` exists (verified in `--help`); chat via
  `-q --resume`. **codex**: resume support unverified — fallback below.
- **Fallback for agents without resume**: seed the new surface with the
  thread transcript tail (core keeps per-thread message history anyway for
  the chat UI).
- **Mode exclusivity**: a thread is in one mode at a time. Two processes must
  never write one session concurrently. Switching term→chat closes the PTY
  (session persists on disk); chat→term spawns the interactive resume.

## Lane mapping & run.sh

- escalation lane → **ambient agent** (unchanged mechanics, MAIN-only
  routing, idle-gated by the existing `user_busy` quiet window).
- spawn lane → **thread agent**: run.sh's spawn polling becomes thread-message
  polling (`GET /thread/pending` → `claude -p --resume <sid> "<msg>"` →
  `POST /thread/respond`). One message queue, per-thread sessions.
- run.sh interactive modes (`--interactive-region/--interactive-main`) gain
  `--resume <sid>` so terminals continue the thread instead of starting cold.
  The typed-seed mechanism stays for *new* threads only.

## What gets removed

- LLM-suggested/autonomous spawns, `MAX_CONCURRENT_SPAWNS`, spawn TTL queue.
- Shift+Enter spawn input mode; spawn task status chips in the overlay.
- Wire types `SpawnCommandMessage`/`SpawnReplyMessage`/`SpawnTaskMessage`
  (replaced by `thread_message`/`thread_state`), `sinain_spawn` MCP tool.
- Kept: PreToolUse permission flow (now guards thread executions), the
  agent-selector (relabeled lanes: *Ambient* / *Threads*), region eyes,
  knowledge pipeline, escalation scorer.

## Overlay changes

- Replace FeedView's message rendering + CommandInput with the flyer chat
  widget, one instance per thread tab. MAIN is just a thread whose agent
  messages happen to arrive from ambient escalations.
- Tab row stays (MAIN + threads). The 💬/⌨ toggle per tab now switches the
  *surface of the same session* instead of chat-UI vs unrelated terminal.
- ROI banner: **[💬 Chat] [⌨ Term]** replaces ⚡Run/⌨ Term.
- **Fork** button on MAIN.
- Open question (Igor to decide): where does the *stream* channel (transcripts,
  OCR events, system lines) live once chat tabs are conversation-only?
  Proposal: a collapsible "activity" panel/tab, off by default.

## Phasing

- **P1 — widget spike**: flyer chat renders MAIN over the existing WS feed
  (no backend change). Validates theming/focus/IME in the non-activating
  panel. Go/no-go on flyer vs fallback.
- **P2 — thread registry + resume**: core thread registry, run.sh thread
  polling with `--resume`, ROI buttons create chat/term threads.
- **P3 — surface switching**: 💬⇄⌨ on one session, exclusivity rules,
  terminal close/reopen semantics.
- **P4 — spawn removal**: delete queue/types/UI/MCP tool; relabel lanes.
- **P5 — fork + ambient polish**: fork button (`--fork-session`), escalation
  routing into MAIN's chat, ambient toggle surfaced in UI.
- **P6 — cleanup, docs, release.**

## Risks

- Flyer widget focus/IME inside the non-activating NSPanel — same risk class
  the terminal spike retired; P1 settles it early.
- Concurrent session writes on fast surface-switching — exclusivity rule +
  core-side mode lock.
- Resume parity for openclaude/hermes/codex — P2 builds the matrix; transcript
  seeding is the universal fallback.
- Session id capture: headless claude prints session ids with
  `--output-format json`; core must store them from the first thread message.
