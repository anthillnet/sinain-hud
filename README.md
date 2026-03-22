# SinainHUD

Ambient AI overlay for macOS and Windows — invisible to screen capture, surfacing real-time
insights from audio and screen context via an LLM agent loop. A ghost window
(`NSWindow.sharingType = .none`) whispers advice only you can see, while a portable knowledge
system curates your accumulated context into a living playbook.

## Architecture

```
Audio (ScreenCaptureKit) ──┐
                           ├─► sinain-core :9500 ──► OpenClaw Gateway ──► AI Agent
Screen (SCKit / OCR) ──────┘         │                      │
                                     │ WebSocket feed        │ [HUD:feed] responses
                                     ▼                       ▼
                                Overlay (Flutter)       Telegram alerts
                                     │
                                SITUATION.md ──► sinain-memory (30-min reflection)
                                                     │
                                            triplestore.db (Graph RAG)
```

| Component | Language | Purpose |
|---|---|---|
| **overlay/** | Dart / Swift | Ghost window HUD, 4 display modes, global hotkeys |
| **sinain-core/** | Node.js (TypeScript) | Audio transcription, agent loop, escalation, WS feed |
| **sense_client/** | Python | ScreenCaptureKit capture, SSIM diff, OCR, privacy filter |
| **sinain-memory/** | Python | Reflection pipeline: signal analysis, memory mining, playbook curation, triplestore |
| **sinain-hud-plugin/** | TypeScript | OpenClaw plugin: lifecycle hooks, auto-deploy, heartbeat, overflow watchdog |
| **modules/** | JSON + Markdown | Hot-swappable knowledge modules with priority-based stacking |

## System Requirements

- **macOS 12.3+** (primary — ScreenCaptureKit) or **Windows** (native, with win-audio-capture)
- Node.js 18+, Python 3.10+
- OpenRouter API key (free tier works) or local whisper.cpp for offline transcription
- macOS: Screen Recording + Microphone permissions
- Windows: cmake + C++ compiler (MinGW/MSVC) for win-audio-capture build
- Flutter 3.10+ only needed for development (`sinain setup-overlay --from-source`)

## Quick Start

### npx (recommended)

```bash
npx @geravant/sinain start
```

On first run, create `~/.sinain/.env`:
```bash
mkdir -p ~/.sinain
echo "OPENROUTER_API_KEY=sk-or-..." > ~/.sinain/.env
```

Optional flags: `--no-sense`, `--no-overlay`, `--no-agent`, `--agent=codex`

To install the overlay (pre-built, no Flutter needed):
```bash
npx @geravant/sinain setup-overlay
```

Other commands: `npx @geravant/sinain stop | status`

### From source

```bash
git clone https://github.com/anthillnet/sinain-hud
cd sinain-hud
cp sinain-core/.env.example sinain-core/.env
# Edit .env — set OPENROUTER_API_KEY at minimum
./start.sh                   # full system
./start.sh --no-sense        # skip screen capture
./start.sh --no-overlay      # headless mode
```

For local transcription (no API key needed for audio): `./setup-local-stt.sh`, then `./start-local.sh`

## Setup Guides

| Setup | Description | Guide |
|---|---|---|
| Local OpenClaw | Gateway on your Mac | [docs/INSTALL-LOCAL.md](docs/INSTALL-LOCAL.md) |
| Remote OpenClaw | Gateway on a Linux server | [docs/INSTALL-REMOTE.md](docs/INSTALL-REMOTE.md) |
| NemoClaw (Brev) | NVIDIA cloud with NIM models | [docs/INSTALL.md](docs/INSTALL.md) |
| Bare Agent | Any coding agent, no gateway | [docs/INSTALL-BARE-AGENT.md](docs/INSTALL-BARE-AGENT.md) |
| Windows | Native setup (no WSL2 needed) | [setup-windows.sh](setup-windows.sh) |

## Components

### overlay/
Flutter macOS ghost window (`NSWindow.sharingType = .none`) — invisible to all screen sharing
and recording. 4 display modes: Feed, Alert, Minimal, Hidden. See [Hotkeys](docs/HOTKEYS.md).

### sinain-core/
Node.js hub on `:9500` — audio pipeline, agent analysis loop, escalation orchestration, WebSocket
feed to overlay, SITUATION.md sync via RPC. See [sinain-core/README.md](sinain-core/README.md).

### sense_client/
Python screen capture with three backends: SCKCapture (ScreenCaptureKit, primary), ScreenKitCapture
(IPC fallback), ScreenCapture (CGDisplayCreateImage legacy). SSIM change detection, OCR via
OpenRouter vision, privacy auto-redaction.

### sinain-memory/
Reflection pipeline triggered every 30 minutes: signal analysis, feedback mining, playbook
curation, tick evaluation, triplestore ingestion. See [Knowledge System](docs/knowledge-system.md).

### sinain-hud-plugin/
OpenClaw server plugin — auto-deploys workspace files, runs curation pipeline, context overflow
watchdog, privacy stripping, `/sinain_status` and `/sinain_modules` commands.

### modules/
Hot-swappable knowledge packages with priority-based stacking. Each module has a `manifest.json`
and `patterns.md`. Managed via `sinain-memory/module_manager.py`.
See [Knowledge System](docs/knowledge-system.md).

## Configuration

All config via environment variables in `sinain-core/.env`. Essential variables:

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

- **Ghost overlay** — `NSWindow.sharingType = .none`: invisible to screen share, recording,
  and screenshots
- **`<private>` tags** — wrap on-screen text in `<private>...</private>`; stripped client-side
  by sense_client and server-side by the plugin before persistence
- **Auto-redaction** — credit cards, API keys, bearer tokens, AWS keys, passwords
- **Local-first** — all traffic stays on localhost; audio transcribed in-memory, never persisted
- **Privacy modes** — configurable levels: off, standard, strict, paranoid

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
