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
| `Cmd+Shift+M` | Cycle display mode (feed → alert → minimal) |
| `Cmd+Shift+H` | Panic hide — instant |

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

## Privacy

- Overlay is **invisible** to screen sharing, recording, and screenshots
- All traffic stays on localhost (bridge ↔ overlay)
- Audio is transcribed in memory, never stored to disk
- Panic hide (`Cmd+Shift+H`) instantly clears everything

## Roadmap

- [x] Phase 1: Overlay + Bridge MVP
- [ ] Phase 2: Audio pipeline (live transcription → context)
- [ ] Phase 3: Screen capture pipeline
- [ ] Phase 4: Polish (diarization, smart batching, themes)

## License

MIT
