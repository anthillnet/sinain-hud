# SinainHUD

Ambient AI overlay for macOS — invisible to screen capture, surfacing real-time insights from
audio and screen context via an LLM agent loop. A ghost window (`NSWindow.sharingType = .none`)
whispers advice only you can see, while a reflection pipeline running every 30 minutes curates
your accumulated context into a living playbook.

## Architecture Overview

```
Audio (BlackHole) ──┐
                    ├─► sinain-core :9500 ──► OpenClaw Gateway ──► AI Agent
Screen (SCKit) ─────┘         │                      │
                              │ WebSocket feed        │ [HUD:feed] responses
                              ▼                       ▼
                         Overlay (Flutter)       Telegram alerts
                              │
                         SITUATION.md ──► sinain-koog (30-min reflection)
                                                  │
                                         triplestore.db (Graph RAG)
```

| Component | Language | Purpose |
|---|---|---|
| **overlay/** | Dart / Swift | Ghost window HUD, 4 display modes, global hotkeys |
| **sinain-core/** | Node.js (TypeScript) | Audio transcription, agent loop, escalation, WS feed |
| **sense_client/** | Python | ScreenCaptureKit capture, SSIM diff, OCR, privacy filter |
| **sinain-koog/** | Python | Reflection pipeline: signal analysis, memory mining, playbook curation, evaluation, triplestore |
| **sinain-hud-plugin/** | TypeScript | OpenClaw plugin: lifecycle hooks, auto-deploy, heartbeat compliance, overflow watchdog |
| **modules/** | JSON + Markdown | Hot-swappable knowledge modules with priority-based stacking |

---

## Components

### overlay/

Flutter macOS ghost window. Uses `NSWindow.sharingType = .none` — invisible to all screen
sharing, recording, and screenshots. Connects to sinain-core over a local WebSocket.

**Display modes:**
- **Feed** — scrolling text feed (default)
- **Alert** — single urgent card
- **Minimal** — one-line ticker at screen edge
- **Hidden** — invisible

Global hotkeys registered via a native Swift plugin. See [Hotkeys](#hotkeys).

### sinain-core/

Node.js hub service running on `:9500`. Responsibilities:

- **Audio pipeline** — captures from BlackHole (or any audio device) via sox/ffmpeg, transcribes
  with Gemini Flash, applies VAD threshold to skip silence
- **Agent loop** — periodic tick: builds context window from recent transcript + screen OCR,
  runs local LLM digest, optionally escalates to OpenClaw gateway
- **Escalation** — three modes: `off`, `selective` (trigger-based), `focus` (always-on);
  sends context to the AI agent and streams `[HUD:feed]` responses back to the overlay
- **SITUATION.md sync** — after every tick, pushes live situation context to the gateway
  workspace via `situation.update` RPC
- **WebSocket server** — feeds transcript items, agent responses, and control messages to the overlay

See [docs/ESCALATION.md](docs/ESCALATION.md) and [docs/ESCALATION-HEALTH.md](docs/ESCALATION-HEALTH.md).

### sense_client/

Python screen capture pipeline with three capture backends (in priority order):

1. **SCKCapture** — ScreenCaptureKit (macOS 12.3+); async zero-copy IOSurface, 2 FPS,
   GPU-native downscaling; camera-safe (no CoreMediaIO contention)
2. **ScreenKitCapture** — IPC fallback, reads frames from overlay app via `~/.sinain/capture/`
3. **ScreenCapture** — `CGDisplayCreateImage` legacy fallback

Change detection via SSIM diff suppresses unchanged frames before OCR. Privacy pipeline strips
`<private>...</private>` tags and auto-redacts credit cards, API keys, bearer tokens, and passwords.

### sinain-koog/

Python reflection pipeline triggered every 30 minutes by the sinain-hud-plugin HEARTBEAT:

| Script | Role |
|---|---|
| `signal_analyzer.py` | Identifies recurring friction signals from session history |
| `feedback_analyzer.py` | Mines agent responses for quality patterns |
| `memory_miner.py` | Extracts facts and concepts from idle session history |
| `playbook_curator.py` | Merges signals + feedback into `sinain-playbook.md` |
| `insight_synthesizer.py` | Produces `sinain-insights.md` daily synthesis |
| `tick_evaluator.py` | Scores each agent response against rubric |
| `eval_reporter.py` | Generates delta reports after 03:00 UTC daily |
| `triple_ingest.py` | Ingests playbook entries into the triplestore |

### sinain-hud-plugin/

OpenClaw server plugin providing:

- **`before_agent_start` hook** — auto-deploys HEARTBEAT.md, SKILL.md, sinain-koog scripts, and
  active module stack to the gateway workspace; generates `sinain-playbook-effective.md` by
  merging all active module patterns by priority
- **Curation pipeline** — runs the full sinain-koog reflection pipeline every 30 minutes
- **Context overflow watchdog** — auto-archives and truncates session transcript after 5
  consecutive token-limit errors (1 MB minimum guard)
- **Privacy stripping** — strips `<private>` tags from tool results before session persistence
- **`/sinain_status` command** — shows session state, overflow counter, last evaluation
- **`/sinain_modules` command** — shows the active module stack with priorities

### modules/

Hot-swappable knowledge packages. Each module is a directory with:
- `manifest.json` — id, name, priority (0–100), triggers, locked flag
- `patterns.md` — behavioral patterns injected into the agent's effective playbook

| Module | Status | Priority |
|---|---|---|
| `base-behaviors` | locked (always-on) | 0 |
| `claude-code-workflow` | activatable | configurable |
| `cairn2e-rules` | activatable | configurable |

Managed via `sinain-koog/module_manager.py`. See [Knowledge Modules](#knowledge-modules--skill-extraction).

---

## Memory System

SinainHUD uses a four-layer memory architecture, each layer with a distinct lifetime and purpose:

### Layer 1 — OpenClaw built-in memory

`memory.md` in the gateway workspace — curated long-term facts and preferences. Maintained by the
AI agent directly (tool calls). Also includes daily memory logs and compaction hooks that
summarize older history to stay within context limits.

### Layer 2 — Plugin sync engine

The `before_agent_start` hook fires before every agent session. It auto-deploys:
- Latest HEARTBEAT.md and SKILL.md from `sinain-koog/memory/`
- Active knowledge module stack (merged by priority into `sinain-playbook-effective.md`)
- All sinain-koog reflection scripts

This ensures every session starts with a fresh, consolidated context snapshot.

### Layer 3 — sinain-koog reflection pipeline

Runs every 30 minutes via HEARTBEAT. The pipeline:
1. Analyzes recent signals and feedback for quality patterns
2. Mines idle history for facts worth preserving
3. Curates and updates `sinain-playbook.md`
4. Scores recent agent responses (tick evaluator)
5. Generates delta evaluation reports
6. Ingests high-value entries into the triplestore

### Layer 4 — Knowledge modules

Domain expertise packages that are hot-swapped in and out as context changes.
See [Knowledge Modules](#knowledge-modules--skill-extraction).

---

## Knowledge Modules + Skill Extraction

A knowledge module packages domain expertise into a reusable, portable unit. Modules are stacked
by priority — higher-priority patterns take precedence in the effective playbook.

### CLI

```bash
python3 sinain-koog/module_manager.py --modules-dir modules/ <subcommand>
```

| Subcommand | Description |
|---|---|
| `list` | List all modules with status and priority |
| `stack` | Show the active stack in priority order |
| `activate <id> [--priority N]` | Activate a module |
| `suspend <id>` | Suspend a module (keeps it on disk) |
| `priority <id> <N>` | Change priority (0–100) |
| `info <id>` | Show module metadata |
| `guidance <id>` | Show or set session-specific guidance |
| `extract <new-id> --domain "..."` | **Extract** a new module from accumulated session knowledge (LLM-assisted) |
| `export <id>` | Package module as a `.sinain-module.json` bundle |
| `import <bundle>` | Import a module bundle |

The `extract` subcommand reads your playbook and memory logs, uses an LLM to identify coherent
domain patterns, and creates a new module (suspended by default — review before activating).

---

## Triplestore / Semantic Memory

> 🚧 **In Progress** — designed and operational; Graph RAG integration actively being developed.

`sinain-koog/triplestore.py` implements a Datomic-inspired immutable EAV (entity–attribute–value)
triple store backed by SQLite, with four covering indexes (EAVT, AEVT, VAET, AVET) for fast
graph traversal.

**Entity namespaces:**

| Prefix | Examples |
|---|---|
| `pattern:*` | Recurring behavioral patterns |
| `concept:*` | Domain concepts and terms |
| `session:*` | Session summaries |
| `signal:*` | Detected friction signals |
| `observation:*` | Agent observations |

**Triple extraction pipeline** (3-tier):

1. JSON direct extraction — structured LLM output parsed directly
2. Regex + validation — pattern-matched fallback for partial JSON
3. LLM fallback — free-text extraction when structured output fails

**Embeddings:** OpenRouter `text-embedding-3-small` (primary) with local MiniLM fallback.

**Graph RAG:** Vector seed → BFS traversal → re-ranked context injected at agent start.
Subagent sessions use isolated `BranchView`; novelties merged back on completion.

---

## HUD Skill Protocol

The AI agent communicates with the overlay using a structured message format:

```
[HUD:feed priority=<normal|high|urgent>] <message>
[HUD:silent]
[HUD:pong]
```

**Priority semantics:**
- `normal` — helpful info, no time pressure
- `high` — user needs this in the next 30 seconds
- `urgent` — about to make a mistake or miss something critical

Silence is a valid response — `[HUD:silent]` suppresses output when the agent has nothing to add.

See [docs/HUD-SKILL-PROTOCOL.md](docs/HUD-SKILL-PROTOCOL.md) for the full spec.

---

## Local Transcription (whisper.cpp)

By default sinain-core uses OpenRouter for audio transcription. You can switch to fully local, offline transcription via [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — no API keys needed for audio.

### One-time setup

```bash
./setup-local-stt.sh
```

This will:
1. Install `whisper-cli` via Homebrew (if not present)
2. Download the `ggml-large-v3-turbo` model (~1.5 GB) to `~/models/`
3. Run a smoke test to verify everything works

### Launch with local transcription

```bash
./start-local.sh            # wraps start.sh with local env vars
./start-local.sh --no-sense # skip screen capture, audio only
```

### Configuration

| Variable | Default | Description |
|---|---|---|
| `TRANSCRIPTION_BACKEND` | `openrouter` | `openrouter` or `local` |
| `LOCAL_WHISPER_BIN` | `whisper-cli` | Path to whisper-cli binary |
| `LOCAL_WHISPER_MODEL` | `~/models/ggml-large-v3-turbo.bin` | Path to GGML model file |
| `LOCAL_WHISPER_TIMEOUT_MS` | `15000` | Max time per transcription call |
| `TRANSCRIPTION_LANGUAGE` | `en-US` | Language code (auto-converted to ISO 639-1 for whisper) |

## Hotkeys

| Shortcut | Action |
|---|---|
| `Cmd+Shift+Space` | Toggle overlay visibility |
| `Cmd+Shift+H` | **Panic hide** — instant stealth + click-through + privacy |
| `Cmd+Shift+C` | Toggle click-through mode |
| `Cmd+Shift+M` | Cycle display mode (feed → alert → minimal → hidden) |
| `Cmd+Shift+T` | Toggle audio capture (start/stop transcription) |
| `Cmd+Shift+D` | Switch audio device (primary ↔ alt) |
| `Cmd+Shift+A` | Toggle audio feed on HUD (show/hide transcript items) |
| `Cmd+Shift+S` | Toggle screen capture pipeline |
| `Cmd+Shift+V` | Toggle screen feed on HUD (show/hide sense items) |
| `Cmd+Shift+E` | Cycle HUD tab (Stream ↔ Agent) |
| `Cmd+Shift+Up` | Scroll feed up (pauses auto-scroll) |
| `Cmd+Shift+Down` | Scroll feed down (resumes auto-scroll at bottom) |
| `Cmd+Shift+P` | Toggle position (bottom-right ↔ top-right) |
| `Cmd+Shift+Y` | Copy target message to clipboard |

---

## Quick Start

### Prerequisites

- macOS 12.3+ (ScreenCaptureKit required for sense_client primary backend)
- Node.js 22+
- Python 3.11+
- Flutter 3.10+ (`brew install flutter`)
- Tesseract (`brew install tesseract`) — for sense_client OCR
- An [OpenClaw](https://github.com/anthillnet/openclaw) gateway instance with the sinain-hud plugin

### Setup

```bash
git clone <repo>
cd sinain-hud
cp sinain-core/.env.example sinain-core/.env
# Edit sinain-core/.env — fill in OPENROUTER_API_KEY, OPENCLAW_WS_TOKEN, etc.
```

### Run

```bash
./start.sh
# Optional flags:
./start.sh --no-sense    # skip screen capture pipeline
./start.sh --no-overlay  # skip Flutter overlay (headless mode)
```

The overlay and sinain-core start together. macOS will prompt for Screen Recording permission on
first run.

---

## Configuration

Key environment variables in `sinain-core/.env`:

| Variable | Default | Description |
|---|---|---|
| `OPENCLAW_WS_URL` | `ws://localhost:18789` | OpenClaw gateway WebSocket |
| `OPENCLAW_WS_TOKEN` | — | 48-char hex gateway auth token |
| `OPENCLAW_HTTP_URL` | `http://localhost:18789/hooks/agent` | Gateway HTTP hooks endpoint |
| `OPENCLAW_SESSION_KEY` | `agent:main:sinain` | Target session key (must match gateway) |
| `ESCALATION_MODE` | `selective` | `off` / `selective` / `focus` / `rich` |
| `ESCALATION_COOLDOWN_MS` | `30000` | Minimum ms between escalations |
| `WS_PORT` | `9500` | WebSocket port for overlay |
| `OPENROUTER_API_KEY` | — | For transcription and local agent model |
| `AUDIO_DEVICE` | `BlackHole 2ch` | Audio capture device |
| `AUDIO_CHUNK_MS` | `5000` | Audio chunk duration before transcription |
| `AGENT_MODEL` | `google/gemini-2.5-flash-lite` | Local digest model |

See [docs/OPENCLAW-SETUP.md](docs/OPENCLAW-SETUP.md) for the full gateway deployment guide.

---

## Privacy Model

- **Ghost overlay** — `NSWindow.sharingType = .none`: invisible to screen share, recording,
  and screenshots
- **`<private>` tags** — wrap any on-screen text in `<private>...</private>`; sense_client strips
  it client-side; the sinain-hud plugin strips any remainder server-side before persistence
- **Auto-redaction** — sense_client automatically redacts credit cards, API keys, bearer tokens,
  AWS keys, and passwords from OCR text
- **Panic hotkey** — `Cmd+Shift+H`: instant stealth + click-through + privacy mode in one keystroke
- **Local-first** — sinain-core ↔ overlay traffic stays on localhost; audio is transcribed
  in-memory and never written to disk

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

- **overlay/** — Dart/Swift; follow Flutter conventions
- **sinain-core/** — TypeScript strict mode; `npm run lint` before commit
- **sense_client/** — Python 3.11+; type annotations preferred
- **sinain-koog/** — Python 3.11+; each script should be independently runnable with `--help`

---

## License

MIT
