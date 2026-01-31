# SinainHUD

Private AI overlay for macOS. Live advice from [Sinain](https://github.com/Geravant/sinain), invisible to screen capture.

A vampire whispering in your ear — except it's text, and only you can see it.

## What is this?

An always-on-top transparent overlay that displays real-time AI advice while you work, present, or take calls. Uses macOS `NSWindow.sharingType = .none` to stay invisible to screen sharing, recording, and screenshots.

**Components:**
- **overlay/** — Flutter + Swift macOS app (the HUD you see)
- **bridge/** — Node.js service (connects overlay ↔ OpenClaw)
- **extension/** — OpenClaw skill (Sinain's HUD behavior)

## Architecture

```
┌────────────────────────────────────────────────┐
│                  macOS Host                     │
│                                                 │
│  ┌────────────┐     ┌───────────────────────┐  │
│  │ SinainHUD  │◄═══►│    Bridge Service     │  │
│  │ (Overlay)  │ WS  │    localhost:9500      │  │
│  └────────────┘     │                       │  │
│                     │  ┌─────────────────┐  │  │
│                     │  │  Context Relay   │  │  │
│                     │  │  Filter/Compress │  │  │
│                     │  └────────┬────────┘  │  │
│                     └───────────┼───────────┘  │
│                                 │               │
└─────────────────────────────────┼───────────────┘
                                  │ HTTPS
                        ┌─────────▼────────┐
                        │  OpenClaw (Sinain)│
                        └──────────────────┘
```

## Quick Start

### Prerequisites
- macOS 11.0+ (Big Sur or later)
- Flutter 3.10+ (`brew install flutter`)
- Node.js 18+ (`brew install node`)
- An OpenClaw instance with Sinain running

### 1. Bridge Service

```bash
cd bridge
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

### 3. OpenClaw Extension (optional)

Install the HUD skill in your OpenClaw workspace for Sinain's HUD-specific behavior.

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

## Display Modes

- **Feed**: Scrolling text feed (default)
- **Alert**: Single urgent card
- **Minimal**: One-line ticker at screen edge
- **Hidden**: Invisible

## Configuration

Bridge service reads from environment or `config.json`:

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

## Privacy

- Overlay is **invisible** to screen sharing, recording, and screenshots
- All traffic stays on localhost (bridge ↔ overlay)
- Audio is transcribed in memory, never stored to disk
- Panic hide (`Cmd+Shift+H`) instantly clears everything

## Roadmap

- [x] Phase 1: Overlay + Bridge MVP
- [x] Phase 2: Audio pipeline (live transcription → context)
- [ ] Phase 3: Screen capture pipeline
- [ ] Phase 4: Polish (diarization, smart batching, themes)

## License

MIT
