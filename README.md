# Sinain

Always-on ambient intelligence that watches your workflow and proactively whispers the next step.

Sinain is three things:

1. **Universal Sensory & Context Layer** — eyes and ears for your existing agents (Claude, Codex, Goose, Junie). ScreenCaptureKit audio + screen capture + OCR builds rich, real-time context from everything happening on your machine.
2. **Private HUD** — an invisible overlay (`NSWindow.sharingType = .none` on macOS, `WDA_EXCLUDEFROMCAPTURE` on Windows) that only you can see. 4 display modes, client-side credential redaction, never captured in screen shares or recordings.
3. **Always Aware, Always With You** — a living playbook, four-layer memory, and portable knowledge modules that follow you across machines and sessions.

## Architecture

```
┌─── Your Device ─────────────────────────────────────────────────────┐
│                                                                     │
│  sck-capture (Swift)                                                │
│    ├─ system audio (PCM) ──► sinain-core :9500                      │
│    └─ screen frames (JPEG) ──► sense_client ─── POST /sense ──►    │
│                                                      │              │
│                              ┌────────────────────────┘              │
│                              │                                      │
│                         sinain-core                                 │
│                           ├─ audio pipeline → transcription         │
│                           ├─ agent loop → digest + HUD text         │
│                           ├─ escalation ──► OpenClaw Gateway (WS)   │
│                           │                  or sinain-agent (poll)  │
│                           └─ WebSocket feed                         │
│                                  │                                  │
│                                  ▼                                  │
│                           overlay (Flutter)                         │
│                           private, invisible to screen capture      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                          ┌────────┴─────────┐
                          ▼                  ▼
                   OpenClaw Gateway    sinain-agent
                   (server or local)   (bare agent, no gateway)
                     ├─ sinain-hud plugin
                     │   └─ sinain-knowledge (curation, playbook, eval)
                     └─ SITUATION.md, Telegram alerts
```

| Component | Language | Purpose |
|---|---|---|
| **sinain-core/** | Node.js (TypeScript) | Central hub: audio pipeline, agent loop, escalation, WS feed |
| **overlay/** | Dart / Swift / C++ | Private overlay HUD (macOS + Windows), 4 display modes, global hotkeys |
| **sense_client/** | Python | ScreenCaptureKit capture, SSIM diff, OCR, privacy filter |
| **tools/sck-capture/** | Swift | Unified ScreenCaptureKit binary: system audio + screen frames |
| **sinain-agent/** | Bash | Bare agent runner: polls sinain-core, invokes Claude/Codex/Goose/Junie/Aider |
| **sinain-mcp-server/** | TypeScript | MCP server exposing sinain tools to agents |
| **sinain-hud-plugin/** | TypeScript | OpenClaw plugin: lifecycle hooks, knowledge curation, overflow watchdog |
| **modules/** | JSON + Markdown | Hot-swappable knowledge modules with priority-based stacking |

## System Requirements

- **macOS 12.3+** (ScreenCaptureKit) or **Windows 10 2004+** (private overlay via WDA_EXCLUDEFROMCAPTURE)
- Node.js 18+, Python 3.10+
- OpenRouter API key (free tier works) — or run fully local with whisper.cpp + Ollama (no cloud needed)
- **Optional:** [Ollama](https://ollama.com) for local vision AI (screen understanding without cloud APIs)
- macOS: Screen Recording + Microphone permissions
- Windows: Microphone permission (private overlay works out of the box)
- Flutter 3.10+ only needed for development (`sinain setup-overlay --from-source`)

> **Windows hotkeys** use `Ctrl+Shift` instead of `Cmd+Shift`. See [Hotkeys](docs/HOTKEYS.md).

## Quick Start

### Step 1: Install Node.js and Python

If you don't have them yet:
- **Node.js 18+** — download from [nodejs.org](https://nodejs.org/) (LTS recommended)
- **Python 3.10+** — download from [python.org](https://www.python.org/downloads/) or run `brew install python3`

Verify with: `node -v` and `python3 --version`

### Step 2: Get an OpenRouter API key (optional for local-only mode)

> **Running fully local?** Skip this step. If you have Ollama + whisper-cli, sinain works without any cloud API. See [Running Fully Local](#running-fully-local-no-cloud-apis) below.

1. Go to [openrouter.ai](https://openrouter.ai) and sign up (free tier works)
2. Create an API key from the dashboard — it starts with `sk-or-...`

### Step 3: Install the overlay

This downloads the pre-built HUD app (~20 MB). No Flutter or Xcode needed.

```bash
npx @geravant/sinain setup-overlay
```

### Step 4: Grant macOS permissions

sinain needs two permissions. macOS will prompt you on first run, but you can set them up in advance:

1. Open **System Settings → Privacy & Security → Screen Recording** — add your Terminal app
2. Open **System Settings → Privacy & Security → Microphone** — add your Terminal app

> You may need to restart your Terminal after granting permissions.

### Step 5: Start sinain

```bash
npx @geravant/sinain start
```

On first run, an interactive setup wizard configures `~/.sinain/.env` — it asks for your
transcription backend (local whisper or OpenRouter), API key, agent, local vision (Ollama),
escalation mode, and optional OpenClaw gateway. To re-run the wizard later: `npx @geravant/sinain setup`.

You should see a status banner showing all services running. The HUD overlay appears as a
small window on your screen — it's invisible to screen capture and recording.

**Privacy modes** control what data is sent where (configured in `~/.sinain/.env`):

| Mode | What it does |
|---|---|
| `off` | All data flows freely — maximum insight quality, no filtering |
| `standard` | **Default (wizard).** Auto-redacts credentials before cloud APIs |
| `strict` | Only summaries leave your machine — no raw text sent to cloud |
| `paranoid` | Fully local with Ollama. No cloud API calls. Requires `LOCAL_VISION_ENABLED=true`. |

See [Privacy Threat Model](docs/privacy-protection-design.md) for full details.

### Managing sinain

```bash
npx @geravant/sinain stop       # stop all services
npx @geravant/sinain status     # check what's running
npx @geravant/sinain start --no-sense    # skip screen capture
npx @geravant/sinain start --no-overlay  # headless (no HUD window)
```

### Running Fully Local (No Cloud APIs)

sinain can run without any cloud API keys using local models:

- **Audio**: whisper-cli (local transcription, ~1.5 GB model)
- **Vision**: Ollama with llava (local screen understanding, ~4.7 GB model)
- **Agent analysis**: Ollama handles both text and vision ticks locally
- **Agent**: Any MCP-capable agent (Claude, Codex, Junie, Goose) for escalation responses

```bash
# 1. Install local transcription
./setup-local-stt.sh

# 2. Install Ollama + vision model
brew install ollama
ollama pull llava

# 3. Configure .env (or let the setup wizard handle it)
echo "LOCAL_VISION_ENABLED=true" >> ~/.sinain/.env
echo "LOCAL_VISION_MODEL=llava" >> ~/.sinain/.env
echo "PRIVACY_MODE=paranoid" >> ~/.sinain/.env

# 4. Start
./start-local.sh
```

Startup confirms local mode:
```
[local] Starting SinainHUD with local transcription...
[local]   backend:  whisper-cpp
[local]   vision:   Ollama (llava) — local
[local]   agent:    claude (transport=http) — start with: sinain-agent/run.sh
```

Available local vision models:

| Model | Size | Speed (warm) | Best for |
|-------|------|-------------|----------|
| `llava` | 4.7 GB | ~2s/frame | General use (recommended) |
| `llama3.2-vision` | 7.9 GB | ~4s/frame | Best accuracy |
| `moondream` | 1.7 GB | ~1s/frame | Fastest, lower quality |

### From source (for developers)

```bash
git clone https://github.com/anthillnet/sinain-hud
cd sinain-hud
cp .env.example ~/.sinain/.env
# Edit .env — set OPENROUTER_API_KEY at minimum
./start.sh                   # full system
./start.sh --no-sense        # skip screen capture
./start.sh --no-overlay      # headless mode
```

For local transcription: `./setup-local-stt.sh`, then `./start-local.sh`
For fully local (no cloud APIs): also set `LOCAL_VISION_ENABLED=true` in `.env` — see [Running Fully Local](#running-fully-local-no-cloud-apis)

## Setup Guides

| Setup | Description | Guide |
|---|---|---|
| Local OpenClaw | Gateway on your Mac | [docs/INSTALL-LOCAL.md](docs/INSTALL-LOCAL.md) |
| Remote OpenClaw | Gateway on a Linux server | [docs/INSTALL-REMOTE.md](docs/INSTALL-REMOTE.md) |
| NemoClaw (Brev) | NVIDIA cloud with NIM models | [docs/INSTALL.md](docs/INSTALL.md) |
| Bare Agent | Any coding agent, no gateway | [docs/INSTALL-BARE-AGENT.md](docs/INSTALL-BARE-AGENT.md) |
| Windows | Native setup (no WSL2 needed) | [setup-windows.sh](setup-windows.sh) |

## Components

### sinain-core/
Node.js hub on `:9500` — audio pipeline, agent analysis loop, escalation orchestration, WebSocket
feed to overlay, SITUATION.md sync via RPC. See [sinain-core/README.md](sinain-core/README.md).

### overlay/
Flutter private overlay (`NSWindow.sharingType = .none` on macOS, `WDA_EXCLUDEFROMCAPTURE` on
Windows) — invisible to all screen sharing and recording. 4 display modes: Feed, Alert, Minimal,
Hidden. See [Hotkeys](docs/HOTKEYS.md).

### sense_client/
Python screen capture with three backends: SCKCapture (ScreenCaptureKit, primary), ScreenKitCapture
(IPC fallback), ScreenCapture (CGDisplayCreateImage legacy). SSIM change detection, OCR via
OpenRouter vision, privacy auto-redaction.

### tools/sck-capture/
Swift binary using ScreenCaptureKit — single `SCStream` captures both system audio (raw PCM →
stdout → sinain-core AudioPipeline) and screen frames (JPEG → IPC → sense_client). Zero-setup
on macOS 13+, replaces the old sox/BlackHole audio path.

### sinain-agent/
Bare agent runner for use without an OpenClaw gateway. Polls sinain-core for pending escalations,
invokes the selected agent (Claude, Codex, Goose, Junie, or Aider), and posts responses back.
MCP-capable agents call sinain tools directly; others use pipe mode.

### sinain-mcp-server/
MCP server that exposes sinain tools (`sinain_get_escalation`, `sinain_respond`, `sinain_get_context`,
etc.) to any MCP-compatible agent. Started automatically by the launcher.

### sinain-hud-plugin/
OpenClaw server plugin — auto-deploys workspace files, runs the knowledge curation pipeline
(signal analysis, feedback mining, playbook curation, tick evaluation), context overflow
watchdog, privacy stripping, `/sinain_status` and `/sinain_modules` commands.
Includes `sinain-knowledge/` engine for portable knowledge and snapshot management.

### modules/
Hot-swappable knowledge packages with priority-based stacking. Each module has a `manifest.json`
and `patterns.md`. See [Knowledge System](docs/knowledge-system.md).

## Configuration

All config via environment variables in `~/.sinain/.env` (created by the setup wizard). Essential variables:

| Variable | Default | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | — | **Required** (unless using local transcription) |
| `ESCALATION_MODE` | `selective` | `off` / `selective` / `focus` / `rich` |
| `OPENCLAW_WS_URL` | `ws://localhost:18789` | Gateway WebSocket endpoint |

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full reference (30+ variables).

## Hotkeys

Global hotkeys use the **Cmd+Shift** prefix. Essential shortcuts:

| Shortcut | Action |
|---|---|
| `Cmd+Shift+Space` | Toggle overlay visibility |
| `Cmd+Shift+M` | Cycle display mode |
| `Cmd+Shift+H` | Quit overlay |
| `Cmd+Shift+/` | Open command input |

See [docs/HOTKEYS.md](docs/HOTKEYS.md) for all 15 shortcuts.

## Privacy

- **Invisible overlay** — `NSWindow.sharingType = .none`: invisible to screen share, recording,
  and screenshots
- **`<private>` tags** — wrap on-screen text in `<private>...</private>`; stripped client-side
  by sense_client and server-side by the plugin before persistence
- **Auto-redaction** — credit cards, API keys, bearer tokens, AWS keys, passwords
- **Local-first** — all traffic stays on localhost; audio transcribed in-memory, never persisted
- **Privacy modes** — 4 levels (`off`, `standard`, `strict`, `paranoid`) configured via
  `PRIVACY_MODE` in `~/.sinain/.env`. Default is `off` (no filtering). Set to `standard`
  for auto-redaction of sensitive data before it reaches cloud APIs. See [Step 3](#step-3-configure-sinain) in Quick Start.

See [Privacy Threat Model](docs/privacy-protection-design.md) for the full design.

## Deep Dives

| Topic | Doc |
|---|---|
| Knowledge System | [docs/knowledge-system.md](docs/knowledge-system.md) |
| Escalation Architecture | [docs/clean-architecture-escalation.md](docs/clean-architecture-escalation.md) |
| Personality Traits | [docs/PERSONALITY-TRAITS-SYSTEM.md](docs/PERSONALITY-TRAITS-SYSTEM.md) |
| Privacy Threat Model | [docs/privacy-protection-design.md](docs/privacy-protection-design.md) |
| HUD Skill Protocol | [docs/HUD-SKILL-PROTOCOL.md](docs/HUD-SKILL-PROTOCOL.md) |
| Profiling & Metrics | [sinain-core/docs/PROFILING.md](sinain-core/docs/PROFILING.md) |
| sinain-core Reference | [sinain-core/README.md](sinain-core/README.md) |
| NemoClaw Spec | [docs/nemoclaw-setup-spec.md](docs/nemoclaw-setup-spec.md) |
| Full Configuration | [docs/CONFIGURATION.md](docs/CONFIGURATION.md) |
| All Hotkeys | [docs/HOTKEYS.md](docs/HOTKEYS.md) |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
