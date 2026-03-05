# SinainHUD

Private AI overlay for macOS. Live advice from [Sinain](https://github.com/Geravant/sinain), invisible to screen capture.

A vampire whispering in your ear — except it's text, and only you can see it.

## What is this?

An always-on-top transparent overlay that displays real-time AI advice while you work, present, or take calls. Uses macOS `NSWindow.sharingType = .none` to stay invisible to screen sharing, recording, and screenshots.

**Components:**
- **overlay/** — Flutter + Swift macOS app (the HUD you see)
- **sinain-core/** — Node.js service (agent loop, audio pipeline, screen context, WebSocket server)
- **sense_client/** — Python screen capture + privacy pipeline
- **sinain-koog/** — Python reflection scripts (signal analysis, feedback, mining, curation, synthesis)
- **sinain-hud-plugin/** — OpenClaw plugin (lifecycle hooks, auto-deploy, session summaries)
- **skills/sinain-hud/** — Skill definition (HEARTBEAT.md, SKILL.md)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        macOS Host                            │
│                                                              │
│  ┌────────────┐      ┌──────────────────────────────────┐   │
│  │ SinainHUD  │◄════►│         sinain-core              │   │
│  │ (Overlay)  │ WS   │         localhost:9500           │   │
│  └────────────┘      │                                  │   │
│                      │  ┌──────────┐  ┌──────────────┐  │   │
│                      │  │ Audio    │  │ Agent Loop   │  │   │
│                      │  │ Pipeline │  │ (digest,     │  │   │
│  ┌────────────┐      │  └────┬─────┘  │  escalation) │  │   │
│  │sense_client│─────►│       │        └──────┬───────┘  │   │
│  │(capture +  │ POST │       │               │          │   │
│  │ privacy)   │      └───────┼───────────────┼──────────┘   │
│  └────────────┘              │               │               │
│   <private> strip            │          writeSituationMd()   │
│   + auto-redact              │               ▼               │
│                              │    ~/.openclaw/workspace/     │
│                              │       SITUATION.md            │
└──────────────────────────────┼───────────────────────────────┘
                               │ escalateToOpenClaw()
                    ┌──────────┼──────────┐
                    │  HTTP    │    WS    │
                    ▼          ▼          │
           ┌───────────────────────────┐  │
           │   OpenClaw Gateway        │  │
           │   (hooks + agent.wait)    │◄─┘
           │                           │
           │  ┌──────────────────────┐ │
           │  │  sinain-hud plugin   │ │
           │  │  (auto-deploy,       │ │
           │  │   privacy strip,     │ │
           │  │   session summaries) │ │
           │  └──────────────────────┘ │
           └───────────────────────────┘
```

The agent loop runs a periodic tick: capture screen/audio, build a context window, generate a digest via LLM, optionally escalate to OpenClaw. See [docs/ESCALATION.md](docs/ESCALATION.md) for the full escalation pipeline and [docs/ESCALATION-HEALTH.md](docs/ESCALATION-HEALTH.md) for health monitoring, warnings, and runbooks.

## Quick Start

### Prerequisites
- macOS 11.0+ (Big Sur or later)
- Flutter 3.10+ (`brew install flutter`)
- Node.js 22+ (`brew install node`)
- An [anthillnet/openclaw](https://github.com/anthillnet/openclaw) instance (our fork of OpenClaw, includes the sinain-hud plugin)

### 1. sinain-core Service

```bash
cd sinain-core
npm install
cp .env.example .env
# Edit .env with your OpenClaw gateway URL and token
npm run dev
```

### 2. Overlay App

```bash
cd overlay
flutter pub get
flutter run -d macos --debug
```

### 3. Screen Capture (optional)

```bash
cd sense_client
pip install -r requirements.txt
# Requires Tesseract: brew install tesseract
python -m sense_client
```

macOS will prompt for Screen Recording permission on first run.

### 4. OpenClaw Extension (optional)

This requires the [anthillnet fork of OpenClaw](https://github.com/anthillnet/openclaw), which includes the sinain-hud plugin. Install the HUD skill in your OpenClaw workspace for Sinain's HUD-specific behavior.

## Hotkeys

| Shortcut | Action |
|---|---|
| `Cmd+Shift+Space` | Toggle overlay visibility |
| `Cmd+Shift+C` | Toggle click-through mode |
| `Cmd+Shift+M` | Cycle display mode (feed → alert → minimal → hidden) |
| `Cmd+Shift+H` | Panic hide — instant stealth + click-through + privacy |
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

## Display Modes

- **Feed**: Scrolling text feed (default)
- **Alert**: Single urgent card
- **Minimal**: One-line ticker at screen edge
- **Hidden**: Invisible

## Configuration

sinain-core reads from environment or `.env`:

| Variable | Default | Description |
|---|---|---|
| `OPENCLAW_GATEWAY_URL` | `http://localhost:3000` | OpenClaw gateway |
| `OPENCLAW_TOKEN` | — | Gateway auth token |
| `OPENCLAW_SESSION_KEY` | — | Target session |
| `WS_PORT` | `9500` | WebSocket port for overlay |
| `RELAY_MIN_INTERVAL_MS` | `30000` | Min time between escalations |
| `AUDIO_DEVICE` | `default` | Audio capture device (e.g. `BlackHole 2ch`) |
| `AUDIO_ALT_DEVICE` | `BlackHole 2ch` | Alt device for `Cmd+Shift+D` switch |
| `AUDIO_GAIN_DB` | `20` | Gain applied to capture (dB, helps with BlackHole) |
| `AUDIO_VAD_THRESHOLD` | `0.003` | RMS energy threshold for voice detection |
| `AUDIO_CHUNK_MS` | `10000` | Audio chunk duration before transcription |
| `AUDIO_CAPTURE_CMD` | `sox` | Capture backend (`sox` or `ffmpeg`) |
| `OPENROUTER_API_KEY` | — | OpenRouter API key for transcription + triggers |
| `TRIGGER_ENABLED` | `false` | Enable Gemini Flash trigger classification |

Escalation pipeline (see [docs/ESCALATION.md](docs/ESCALATION.md)):

| Variable | Default | Description |
|---|---|---|
| `OPENCLAW_GATEWAY_WS_URL` | `ws://localhost:18789` | OpenClaw gateway WebSocket |
| `OPENCLAW_GATEWAY_TOKEN` | — | Token for gateway WS auth |
| `OPENCLAW_HOOK_URL` | `http://localhost:18789/hooks/agent` | OpenClaw HTTP hooks endpoint |
| `OPENCLAW_HOOK_TOKEN` | — | Token for HTTP hook auth |
| `ESCALATION_MODE` | `selective` | `off` / `selective` / `focus` |
| `ESCALATION_COOLDOWN_MS` | `30000` | Min ms between escalations |
| `SITUATION_MD_ENABLED` | `true` | Write SITUATION.md each tick |
| `OPENCLAW_WORKSPACE_DIR` | `~/.openclaw/workspace` | Directory for SITUATION.md |

## Privacy

- Overlay is **invisible** to screen sharing, recording, and screenshots
- All traffic stays on localhost (sinain-core ↔ overlay)
- Audio is transcribed in memory, never stored to disk
- Panic hide (`Cmd+Shift+H`) instantly clears everything
- **`<private>` tags**: wrap any on-screen text in `<private>...</private>` — sense_client strips it before sending to sinain-core
- **Auto-redaction**: credit cards, API keys, bearer tokens, AWS keys, and passwords are automatically redacted from OCR text
- **Server-side stripping**: the sinain-hud plugin strips any remaining `<private>` tags from tool results before they're persisted to session history

## Roadmap

- [x] Phase 1: Overlay + Bridge MVP
- [x] Phase 2: Audio pipeline (live transcription → context)
- [x] Phase 3: Screen capture pipeline (OCR → context window)
- [ ] Phase 4: Polish (diarization, smart batching, themes)
- [x] Phase 5: OpenClaw escalation (SITUATION.md + hooks + agent.wait)
- [x] Phase 6: Plugin architecture (sinain-hud plugin, privacy pipeline)
- [x] Phase 7: sinain-koog — offloaded reflection pipeline (5 Python scripts via OpenRouter, orchestrated by HEARTBEAT.md)

## License

MIT
