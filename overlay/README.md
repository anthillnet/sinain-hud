# SinainHUD Overlay

Ghost-like macOS overlay app. Dark, minimal, semi-transparent HUD that floats above all windows.

## Architecture

```
lib/
├── main.dart                    # App entry, service init
├── core/
│   ├── models/
│   │   ├── feed_item.dart       # Feed item with priority
│   │   └── hud_settings.dart    # Display mode, settings
│   └── services/
│       ├── window_service.dart   # Platform channel → Swift
│       ├── websocket_service.dart # WS bridge connection
│       └── settings_service.dart  # SharedPreferences persistence
└── ui/
    ├── hud_shell.dart           # Main shell, mode switcher
    ├── feed/feed_view.dart      # Scrolling feed mode
    ├── alert/alert_card.dart    # Urgent alert card mode
    ├── ticker/ticker_view.dart  # Minimal ticker mode
    └── status/status_bar.dart   # Connection + mode indicator

macos/Runner/
├── AppDelegate.swift            # Window config, global hotkeys
├── MainFlutterWindow.swift      # NSPanel subclass
└── WindowControlPlugin.swift    # Native window control channel
```

## Features

- **Ghost overlay** — transparent, click-through, invisible to screen capture
- **4 display modes** — Feed (scrolling), Alert (urgent card), Minimal (ticker), Hidden
- **Privacy mode** — `sharingType = .none` hides from screen recording
- **Global hotkeys:**
  - `⌘⇧Space` — Toggle visibility
  - `⌘⇧C` — Toggle click-through
  - `⌘⇧M` — Cycle display mode
  - `⌘⇧H` — Panic hide (instant stealth)
  - `⌘⇧T` — Toggle audio capture
  - `⌘⇧D` — Switch audio device
  - `⌘⇧A` — Toggle audio feed on HUD
  - `⌘⇧↑` — Scroll feed up
  - `⌘⇧↓` — Scroll feed down
- **WebSocket bridge** — Connects to `ws://localhost:9500` with auto-reconnect
- **LSUIElement** — Hidden from Dock and Cmd+Tab

## Setup

1. Install fonts:
   ```
   # Download JetBrains Mono TTF files into fonts/
   ```

2. Run:
   ```bash
   flutter pub get
   flutter run -d macos
   ```

## Bridge Protocol

The overlay connects to `ws://localhost:9500` and expects JSON messages:

```json
// Feed item
{"type": "feed", "data": {"id": "1", "text": "Hello", "priority": "normal"}}

// Urgent alert
{"type": "feed", "data": {"id": "2", "text": "ALERT!", "priority": "urgent"}}

// Status update
{"type": "status", "data": {"audio": true, "connected": true}}
```

## Design

- Terminal/HUD aesthetic, not a chat app
- Monospace font (JetBrains Mono)
- Dark semi-transparent (0.85 opacity black)
- Priority colors: white (normal), amber (high), red (urgent)
- Old feed items fade with time
- No borders, no title bar, no window chrome
