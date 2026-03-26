# SinainHUD Overlay — Design Specification

> Source of truth for the 3-state overlay redesign (issue #37, branch `feat/overlay-redesign`).
> Replaces the old 4-mode overlay (Feed / Alert / Ticker / Hidden).

---

## 1. Architecture Overview

SinainHUD uses **native window management via platform channels**, not a Flutter-level overlay library. The overlay runs as an **NSPanel** (macOS) or **HWND with display affinity** (Windows), controlled by Flutter through a `MethodChannel`.

```
┌─────────────────────────────────────────────────────┐
│  Flutter (Dart)                                     │
│  ┌────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │OverlayShell│  │  FeedView    │  │CommandInput │  │
│  │(state mgr) │  │(agent/stream)│  │(user cmds)  │  │
│  └─────┬──────┘  └──────────────┘  └────────────┘  │
│        │ Platform Channel: sinain_hud/window        │
├────────┼────────────────────────────────────────────┤
│  Native│(Swift / C++)                               │
│  ┌─────┴──────────┐  ┌───────────────────────────┐  │
│  │WindowControl    │  │AppDelegate (Carbon hotkeys)│ │
│  │Plugin           │  │→ sinain_hud/hotkeys channel│ │
│  └────────────────┘  └───────────────────────────┘  │
│        │                                            │
│  ┌─────┴──────────────────────────────────────────┐ │
│  │ NSPanel (macOS) — sharingType = .none           │ │
│  │ borderless, floating, non-activating            │ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

**Why not GhostLayer / Flutter overlays?**
- Native NSPanel gives us `sharingType = .none` — invisible to screen capture (privacy-critical)
- Direct `setFrameOrigin` / `setFrame` avoids Flutter layout overhead during drag
- Carbon API global hotkeys work even when another app has focus
- `becomesKeyOnlyIfNeeded` controls focus stealing precisely per state

---

## 2. State Machine

### 2.1 States

| State | Window Size | Interactive | Key Window | Description |
|-------|-------------|-------------|------------|-------------|
| **Eye** | 48 × 48 | Yes (click, drag, long-press) | No | Minimal pulsing eye icon |
| **Controls** | 280 × 48 | Yes (buttons, drag) | No | Horizontal strip with capture toggles |
| **Chat** | W × H (resizable) | Yes (full UI) | Yes | Feed + command input + resize handles |
| **Hidden** | unchanged | No | No | Window ordered out, state preserved |

Default chat size: 427 × 293. Constraints: 300–800 wide, 200–900 tall.

### 2.2 Transitions

```
                    ┌──────────────────────┐
                    │       Hidden         │
                    └──┬────────────────┬──┘
           Cmd+Shift+Space         Cmd+Shift+Space
            (restore)                (hide from any)
                    │                   │
         ┌──────────▼───────────────────▼──────────┐
         │                                          │
    ┌────▼───┐    tap/M    ┌──────────┐  expand/F  ┌────▼───┐
    │  Eye   │────────────►│ Controls │───────────►│  Chat  │
    │ 48×48  │◄────────────│  280×48  │◄───────────│  W×H   │
    └────────┘  eye icon   └──────────┘  collapse  └────────┘
         │         tap          │                      │
         │                     │                      │
         └─────────────────────┴──────────────────────┘
                    Cmd+Shift+F (Eye ↔ Chat direct)
```

| Trigger | From | To | Notes |
|---------|------|----|-------|
| Tap on eye | Eye | Controls | Expand to controls strip |
| Tap on eye icon (in controls) | Controls | Eye | Collapse |
| Expand button / `Cmd+Shift+F` | Controls | Chat | Full panel |
| Collapse button | Chat | Controls | Shrink to strip |
| `Cmd+Shift+F` | Eye | Chat | Direct jump |
| `Cmd+Shift+F` | Chat | Eye | Direct jump back |
| `Cmd+Shift+M` | Any visible | Next state | Cycle: Eye → Controls → Chat → Eye |
| Long-press on eye | Eye | Hidden | Hide overlay |
| `Cmd+Shift+Space` | Any visible | Hidden | Hide, remember last state |
| `Cmd+Shift+Space` | Hidden | Last visible | Restore to last visible state |

### 2.3 Window Resize on Transition

All transitions anchor to the **top-right corner** of the eye position (macOS: that's `origin.x + width`, `origin.y`). When expanding:

```dart
// Anchor: eyeRight = frame.x + frame.w, eyeBottom = frame.y
switch (targetState) {
  case eye:      setWindowFrame(eyeRight - 48, eyeBottom, 48, 48);
  case controls: setWindowFrame(eyeRight - 280, eyeBottom, 280, 48);
  case chat:     setWindowFrame(eyeRight - chatW, eyeBottom, chatW, chatH);
}
```

On transition to **Chat**, call `makeKeyWindow()` (enable text input).
On transition away from Chat, call `resignKeyWindow()` (return focus to previous app).

---

## 3. Hotkey Map

All hotkeys use **Cmd+Shift** (macOS) / **Ctrl+Shift** (Windows).

### 3.1 Full Hotkey Table

| ID | Key | Action | Category | Handler Flow |
|----|-----|--------|----------|-------------|
| **1** | Space | Toggle visibility | Navigation | Native: `orderOut`/`orderFront` → Dart: `toggleVisibility(visible)` |
| **3** | M | Cycle state | Navigation | Dart: Eye → Controls → Chat → Eye (skip Hidden) |
| **4** | H | Quit overlay | System | Dart: `wsService.disconnect()` → Native: `NSApp.terminate` |
| **5** | T | Toggle audio capture | Capture | Dart: `ws.sendCommand('toggle_audio')` → Core → pipeline start/stop |
| **7** | A | Toggle audio feed | Display | Dart: `ws.toggleAudioFeed()` — local filter, no server call |
| **8** | Up | Scroll feed up | Feed | Dart: `ws.scrollFeed('up')` → FeedView: -200px animated |
| **9** | Down | Scroll feed down | Feed | Dart: `ws.scrollFeed('down')` → FeedView: +200px animated |
| **10** | S | Toggle screen capture | Capture | Dart: `ws.sendCommand('toggle_screen')` → Core → sense pipeline |
| **11** | V | Toggle screen feed | Display | Dart: `ws.toggleScreenFeed()` — local filter, no server call |
| **12** | E | Cycle tab (Agent/Tasks) | Navigation | Dart: `settingsService.cycleTab()` — IndexedStack swap |
| **13** | P | Reset position | Window | Dart: reset eye position to default (bottom-right, 16px margin) |
| **14** | Y | Copy message | Feed | Dart: `ws.requestCopy(activeTab)` → FeedView: clipboard |
| **15** | R | Toggle demo mode | Privacy | Native: `sharingType` toggle → Dart: `onTogglePrivacy(isPrivate)` |
| **17** | B | Toggle trait voices | Capture | Dart: `ws.sendCommand('toggle_traits')` |
| **18** | / | Focus command input | Input | Dart: transition to Chat if not already → focus TextField |
| **19** | F | Toggle Eye ↔ Chat | Navigation | Dart: `toggleChat()` — direct jump, no Controls intermediate |

### 3.2 Hotkey Changes from Original

| ID | Original Behavior | New Behavior | Rationale |
|----|-------------------|--------------|-----------|
| 3 (M) | Cycle 4 display modes | Cycle 3 states (Eye→Controls→Chat) | Alert/Ticker modes removed |
| 13 (P) | Toggle bottom-right ↔ top-right | Reset to default position | Free drag replaces fixed positions |
| 18 (/) | Show modal command input | Transition to Chat + focus input | Command input is always embedded in Chat |
| 19 (F) | *new* | Direct Eye ↔ Chat toggle | Quick access shortcut |

### 3.3 Native Handler (AppDelegate.swift)

```swift
private func processHotKey(id: UInt32) {
    guard let window = mainFlutterWindow else { return }
    switch id {
    case 1:  // Space — visibility
        let wasVisible = window.isVisible  // NOT cached flag
        if wasVisible { window.orderOut(nil) } else { window.orderFront(nil) }
        hotkeyChannel?.invokeMethod("onToggleVisibility", arguments: !wasVisible)
    case 3:  // M — cycle state
        hotkeyChannel?.invokeMethod("onCycleState", arguments: nil)
    case 4:  // H — quit
        hotkeyChannel?.invokeMethod("onQuit", arguments: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.terminate(nil) }
    case 5:  // T — toggle audio
        hotkeyChannel?.invokeMethod("onToggleAudio", arguments: nil)
    case 7:  // A — toggle audio feed
        hotkeyChannel?.invokeMethod("onToggleAudioFeed", arguments: nil)
    case 8:  // Up — scroll up
        hotkeyChannel?.invokeMethod("onScrollFeed", arguments: "up")
    case 9:  // Down — scroll down
        hotkeyChannel?.invokeMethod("onScrollFeed", arguments: "down")
    case 10: // S — toggle screen
        hotkeyChannel?.invokeMethod("onToggleScreen", arguments: nil)
    case 11: // V — toggle screen feed
        hotkeyChannel?.invokeMethod("onToggleScreenFeed", arguments: nil)
    case 12: // E — cycle tab
        hotkeyChannel?.invokeMethod("onCycleTab", arguments: nil)
    case 13: // P — reset position
        hotkeyChannel?.invokeMethod("onResetPosition", arguments: nil)
    case 14: // Y — copy message
        hotkeyChannel?.invokeMethod("onCopyMessage", arguments: nil)
    case 15: // R — toggle demo/privacy
        if #available(macOS 12.0, *) {
            let currentlyPrivate = window.sharingType == .none
            window.sharingType = currentlyPrivate ? .readOnly : .none
            hotkeyChannel?.invokeMethod("onTogglePrivacy", arguments: !currentlyPrivate)
        }
    case 17: // B — toggle traits
        hotkeyChannel?.invokeMethod("onToggleTraits", arguments: nil)
    case 18: // / — command input
        hotkeyChannel?.invokeMethod("onFocusInput", arguments: nil)
    case 19: // F — toggle chat
        hotkeyChannel?.invokeMethod("onToggleChat", arguments: nil)
    default: break
    }
}
```

### 3.4 Dart Handler (main.dart)

```dart
hotkeyChannel.setMethodCallHandler((call) async {
  switch (call.method) {
    case 'onToggleVisibility':
      overlayShellKey.currentState?.toggleVisibility(call.arguments as bool);
    case 'onCycleState':
      overlayShellKey.currentState?.cycleState();
    case 'onQuit':
      wsService.disconnect();
    case 'onToggleAudio':
      wsService.sendCommand('toggle_audio');
    case 'onToggleAudioFeed':
      wsService.toggleAudioFeed();
    case 'onScrollFeed':
      wsService.scrollFeed(call.arguments as String);
    case 'onToggleScreen':
      wsService.sendCommand('toggle_screen');
    case 'onToggleScreenFeed':
      wsService.toggleScreenFeed();
    case 'onCycleTab':
      settingsService.cycleTab();
    case 'onResetPosition':
      overlayShellKey.currentState?.resetPosition();
    case 'onCopyMessage':
      wsService.requestCopy(settingsService.settings.activeTab.name);
    case 'onTogglePrivacy':
      settingsService.setPrivacyModeTransient(call.arguments as bool);
    case 'onToggleTraits':
      wsService.sendCommand('toggle_traits');
    case 'onFocusInput':
      overlayShellKey.currentState?.focusInput();
    case 'onToggleChat':
      overlayShellKey.currentState?.toggleChat();
  }
});
```

---

## 4. Controls Layout

### 4.1 Controls Bar (State: Controls, 280 × 48)

```
┌────────────────────────────────────────────────────────────┐
│  [👁] [🔊] [🎤]          [⚙] [◀] [▶]  (●)               │
│  screen audio  mic     settings collapse expand  eye-anim  │
│                        ▲ Spacer                            │
│  ◄─── drag anywhere on background ───►                     │
└────────────────────────────────────────────────────────────┘
```

**Left group** — Capture toggles (green when active, dim when off):
- Screen: `Icons.visibility` / `Icons.visibility_off`
- Audio: `Icons.volume_up_rounded` / `Icons.volume_off_rounded`
- Mic: `Icons.mic` / `Icons.mic_off`

**Right group** — Actions:
- Settings: `Icons.settings` → opens `.env` file in system editor
- Collapse: `Icons.chevron_right` → transition to Eye
- Expand: `Icons.open_in_full` → transition to Chat
- Eye animation: 40px `IdleAnimation` in 40px circle — tap → Eye state

**Drag**: Entire background is draggable via `GestureDetector.onPanUpdate`.
**Colors**: Active toggles = `#00FF88`. Inactive = `white @ 0.3`. Action icons = `white @ 0.5`.

### 4.2 Chat Header (State: Chat, 36px tall)

```
┌─────────────────────────────────────────────────────────────┐
│ [▼] [👁] [🔊] [🎤]                          [⚙]  (●)     │
│ collapse  screen audio mic                settings eye-anim│
│                                                             │
│ ◄─── drag on header ───►                                   │
└─────────────────────────────────────────────────────────────┘
```

Same control set as Controls bar, but:
- Collapse (`Icons.expand_more`) → transition to Controls
- Eye animation (24px) → tap transitions to Eye
- All icons use `small: true` variant (12px icon, 4px padding)

### 4.3 Chat Body

```
┌─────────────────────────────────────────────────────────────┐
│ [header — 36px, draggable]                                  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  FeedView (agent channel)                                  │
│  ┌─ 14:30:22  Agent response with **markdown**            │
│  │  14:30:25  Another response                             │
│  │                                                         │
│  │                          ┌─────────────────────────┐    │
│  │                          │ User message (cyan box) │    │
│  │                          └─────────────────────────┘    │
│  │                                                         │
│  └─ 14:31:02  ··· (thinking indicator)                    │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ ⌘ Enter = send | Shift+Enter = spawn agent    [input]      │
└─────────────────────────────────────────────────────────────┘
```

**Resize handles**: 6px transparent zones on all 4 edges:
- Left edge: grow left, anchor right (`resizeWindowBy(-dx, 0, anchorRight: true)`)
- Right edge: grow right, anchor left (`resizeWindowBy(dx, 0)`)
- Top edge: grow up, anchor top (`resizeWindowBy(0, -dy, anchorTop: true)`)
- Bottom edge: grow down, anchor bottom (`resizeWindowBy(0, dy)`)

---

## 5. Window Management

### 5.1 Platform Channel API (`sinain_hud/window`)

| Method | Args | Effect |
|--------|------|--------|
| `setTransparent` | — | Clear background, enable layer |
| `setPrivacyMode` | `{enabled}` | `sharingType = .none` (invisible to capture) |
| `setAlwaysOnTop` | `{enabled}` | `window.level = .floating` |
| `hideWindow` | — | `window.orderOut(nil)` |
| `showWindow` | — | `window.orderFront(nil)` |
| `setWindowFrame` | `{x, y, w, h}` | Absolute frame set |
| `getWindowFrame` | — | Returns `{x, y, w, h}` |
| `moveWindowBy` | `{dx, dy}` | Delta move (fire-and-forget, no layout cascade) |
| `resizeWindowBy` | `{dw, dh, anchorRight, anchorTop}` | Delta resize with constraints + anchor control |
| `makeKeyWindow` | — | Enable text input focus |
| `resignKeyWindow` | — | Return focus to previous app |
| `openFile` | `{path}` | `NSWorkspace.shared.open()` |

### 5.2 Drag Behavior

| State | Drag Target | Behavior |
|-------|-------------|----------|
| Eye | Entire 48px circle | `moveWindowBy(dx, -dy)` — fire-and-forget |
| Controls | Entire bar background | `moveWindowBy(dx, -dy)` — fire-and-forget |
| Chat | Header bar (36px) | `moveWindowBy(dx, -dy)` — fire-and-forget |
| Chat | Edge handles (6px) | `resizeWindowBy(dw, dh, ...)` — with anchors |

**Performance**: `moveWindowBy` uses `setFrameOrigin()` natively (no `display: true` overhead). The WindowService reference is cached in `initState()` to avoid `context.read()` during rapid drag events.

**dy inversion**: Flutter's coordinate system has Y increasing downward. macOS has Y increasing upward. All drag handlers negate dy: `moveWindowBy(dx, -dy)`.

### 5.3 Resize Constraints (Native)

```swift
let newW = min(max(frame.width + dw, 300), 800)   // 300–800
let newH = min(max(frame.height + dh, 200), 900)   // 200–900
```

### 5.4 Position & Size Persistence

| Property | Persisted | When Saved | Restored On |
|----------|-----------|------------|-------------|
| Eye position (x, y) | SharedPreferences | After drag end | App startup |
| Chat size (w, h) | SharedPreferences | After resize end | State transition to Chat |
| HudState | SharedPreferences | On every transition | App startup |
| Active tab | SharedPreferences | On tab cycle | App startup |

**Eye position** doubles as the anchor point for all states. When the user drags in Controls or Chat mode, the position is saved as if it were the eye's top-right corner.

### 5.5 macOS Y-Axis Notes

macOS window coordinates have origin at **bottom-left** of the screen. When anchoring the top edge during resize:

```swift
// Keep top edge fixed: top = origin.y + height
// If height changes: new origin.y = old origin.y + (old height - new height)
if anchorTop {
    frame.origin.y += (oldH - newH)
}
```

---

## 6. Feed System

### 6.1 Channels

| Channel | Content | Tab | Persistence |
|---------|---------|-----|-------------|
| `agent` | AI analysis, user messages, escalation results | Agent tab | `WebSocketService.agentFeedItems` (survives widget rebuilds) |
| `stream` | Audio transcripts, screen OCR, system messages | Stream tab (future) | None (ephemeral) |

### 6.2 Feed Item Model

```dart
class FeedItem {
  final String id;
  final String text;
  final FeedPriority priority;    // normal, high, urgent
  final FeedChannel channel;      // agent, stream
  final FeedSender sender;        // agent, user
  final DateTime timestamp;
  double opacity;                 // mutable, for fade-out
}
```

### 6.3 Feed Behavior

**Ring buffer**: Max 50 items. When exceeded, trim oldest items and shift selection index.

**Auto-scroll**: Enabled by default. Jumps to `maxScrollExtent` after each new item (via `addPostFrameCallback`). Disabled when user scrolls up manually.

**Manual scroll**: Hotkey-driven (Up/Down arrows). Steps of 200px with 150ms easeOut animation. After animation completes, updates `_selectedIndex` to the topmost half-visible item.

**Selection**: Highlighted with 2px left border in `#00E5FF @ 0.6`. Timestamp changes to cyan. Unselected items have white timestamp at 0.25 alpha.

**Scroll-to-bottom**: Down arrow past `maxScrollExtent - 10px` re-enables auto-scroll and clears selection.

**Fade-out timer**: Every 30 seconds:
- Items > 10 min old: opacity decreases by 0.15 (floor: 0.15)
- Items > 5 min old: opacity decreases by 0.05 (floor: 0.30)
- Items at opacity ≤ 0.15 are removed (if > 10 items remain)

**Copy**: `Cmd+Shift+Y` copies the selected item's text (or last item if no selection) to clipboard. Long-press on any item also copies.

### 6.4 Message Rendering

**Agent messages** (left-aligned):
```
14:30:22 ▌ Agent response with **markdown** support
```
- Timestamp: `HH:MM:SS` in JetBrainsMono 10px
- Priority bar: 3px × 12px colored indicator (red = urgent, orange = high, hidden for normal)
- Body: MarkdownBody with JetBrainsMono 12px, color matches priority

**User messages** (right-aligned):
```
                              ┌─────────────────────┐
                              │ User's typed message │
                              └─────────────────────┘
```
- Cyan box (`#1A3A4A` background, `#00E5FF @ 0.2` border)
- Text in `#00E5FF`, JetBrainsMono 12px
- Left padding: 40px (indented from left edge)

### 6.5 Feed Persistence

Agent feed items are stored in `WebSocketService.agentFeedItems` (max 50). When FeedView mounts with `channel == agent` and `_items.isEmpty`, it restores from this list. This ensures messages survive Eye ↔ Controls ↔ Chat transitions that rebuild the widget tree.

### 6.6 Feed Filtering (Client-Side)

| Filter | Prefix Matched | Toggle |
|--------|---------------|--------|
| Audio feed | `[📝]`, `[🔊]`, `[🎤]` | `Cmd+Shift+A` / toggle button |
| Screen feed | `[👁]` | `Cmd+Shift+V` / toggle button |

Filtering happens in `WebSocketService._onMessage` before items reach the stream. Toggling broadcasts a status feed item ("Audio feed enabled/disabled").

---

## 7. Animation

### 7.1 IdleAnimation (Eye)

The eye is a `CustomPaint` widget with three layers:

**Ring**: Pulsing circle outline
- Base radius: 32.5% of widget size
- Expansion: +7.5% at peak
- Color: `#00FF88`
- Alpha oscillates: `alphaMin` (0.30) → `alphaMax` (0.55) over `cycleDuration` (4s)

**Cat-Slit Pupil**: Vertical slit that breathes
- Drifts lazily within the ring (sin/cos at different phases)
- Vertical half-height: 55% of ring radius
- Base width: 3px + 4px breathing expansion
- `pupilDilation` (0.0–1.0): interpolates from slit → near-circle
- Rendered with quadratic bezier curves for smooth shape

**Radial Spikes**: 8 lines at 45-degree intervals
- Length: 3px ± 7px oscillation per line (phase-varied)
- Alpha: ring alpha × 0.5
- Stroke: 1.5px

### 7.2 Contextual Eye States

| Condition | pupilDilation | cycleDuration | alphaMin/Max | Effect |
|-----------|---------------|---------------|--------------|--------|
| Idle | 0.0 | 4s | 0.30 / 0.55 | Calm, slow pulse |
| New content | 0.6 | 2s | 0.40 / 0.70 | Dilated, faster, brighter |
| Thinking | 0.3 | 1.5s | 0.35 / 0.65 | Alert, rapid |
| Hidden/muted | 0.0 | 6s | 0.20 / 0.35 | Barely visible |

### 7.3 Thinking Indicator

When `thinkingStream` emits `true`, the eye enters "thinking" animation state. The Chat panel can optionally show `···` text below the feed. When `false`, return to idle or new-content state.

---

## 8. Command Input

### 8.1 Behavior

The command input is a 32px bar at the bottom of the Chat panel. It is **always visible** in Chat state.

| Key | Action |
|-----|--------|
| Enter | Send as `user_command` (augments next escalation, expires 30s) |
| Shift+Enter | Send as `spawn_command` (background agent task) |
| Escape | Dismiss input / optionally collapse to Controls |

### 8.2 User Command Flow

```
User types "what is this?"
  → TextField.onSubmitted
    → ws.sendUserCommand("what is this?")
    → WS: { type: "user_command", text: "what is this?" }

Core receives:
  → Echo back as feed: { type: "feed", channel: "agent", sender: "user", text: "..." }
  → Broadcast: { type: "thinking", active: true }
  → Queue for next escalation (30s TTL)

On escalation response:
  → Broadcast: { type: "thinking", active: false }
  → Feed response on agent channel
```

### 8.3 Spawn Command Flow

```
User types "summarize errors" + Shift+Enter
  → ws.sendSpawnCommand("summarize errors")
  → WS: { type: "spawn_command", text: "summarize errors" }

Core receives:
  → Generate taskId, allocate child session
  → Broadcast: { type: "spawn_task", taskId, status: "spawned", label: "..." }
  → Poll gateway for result (5-min timeout, 5s interval)
  → On completion: { type: "spawn_task", taskId, status: "completed", resultPreview: "..." }
  → Feed: "[🤖] summarize errors:\n<result>"
```

---

## 9. WebSocket Protocol

### 9.1 Connection

- URL: `ws://localhost:9500` (configurable via `ws_url` setting)
- Auto-reconnect: exponential backoff 1s → 2s → 4s → ... → 30s (capped)
- On connect: server sends current status + replays last 20 feed items + active spawn tasks
- Heartbeat: server pings every 10s, client responds with pong

### 9.2 Server → Overlay Messages

| Type | Key Fields | Purpose |
|------|-----------|---------|
| `feed` | `text, priority, ts, channel, sender` | Feed item (agent or stream) |
| `status` | `audio, mic, screen, envPath` | Capture state update |
| `spawn_task` | `taskId, status, label, resultPreview` | Task lifecycle |
| `thinking` | `active: bool` | Agent analysis in progress |
| `ping` | `ts` | Heartbeat |

### 9.3 Overlay → Server Messages

| Type | Key Fields | Purpose |
|------|-----------|---------|
| `command` | `action` | Toggle audio/mic/screen/traits |
| `user_command` | `text` | Augment next escalation |
| `spawn_command` | `text` | Launch background agent |
| `message` | `text` | Direct message to gateway |
| `pong` | `ts` | Heartbeat response |
| `profiling` | `rssMb, uptimeS, ts` | Client telemetry (every 30s) |

### 9.4 Status Fields

```typescript
interface BridgeState {
  audio: "active" | "muted";
  mic: "active" | "muted";
  screen: "active" | "off";
  traits?: "active" | "off";
  connection: "connected" | "disconnected" | "connecting";
  envPath?: string;  // Path to loaded .env file
}
```

---

## 10. Settings Persistence

### 10.1 SharedPreferences Keys

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `overlay_state` | String | `"eye"` | HudState enum name |
| `active_tab` | String | `"agent"` | HudTab enum name |
| `privacy_mode` | bool | `true` | Screen capture privacy |
| `ws_url` | String | `"ws://localhost:9500"` | WebSocket URL |
| `eye_x` | double | `-1` | Eye X position (-1 = default) |
| `eye_y` | double | `-1` | Eye Y position (-1 = default) |
| `chat_width` | double | `427` | Chat panel width |
| `chat_height` | double | `293` | Chat panel height |

### 10.2 Default Eye Position

If `eyeX < 0` (first launch), position at:
```
x = screen.maxX - 48 - 16  (16px margin from right)
y = screen.minY + 16        (16px margin from bottom)
```

---

## 11. Cross-Platform

### 11.1 macOS (Primary)

- NSPanel with `sharingType = .none`
- Carbon API global hotkeys (`Cmd+Shift+*`)
- `WindowControlPlugin.swift` handles all window operations
- `AppDelegate.swift` registers hotkeys and bridges to Flutter

### 11.2 Windows

- HWND with `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` (Windows 10 2004+)
- Global hotkeys via `RegisterHotKey` Win32 API (`Ctrl+Shift+*`)
- `window_control_plugin.cpp` — mirrors Swift WindowControlPlugin
- `hotkey_handler.cpp` — mirrors AppDelegate hotkey logic

**Key differences:**
| Feature | macOS | Windows |
|---------|-------|---------|
| Modifier | `Cmd+Shift` | `Ctrl+Shift` |
| Privacy API | `sharingType = .none` | `WDA_EXCLUDEFROMCAPTURE` |
| Window level | `.floating` | `HWND_TOPMOST` |
| Key window | `makeKeyAndOrderFront` | `SetForegroundWindow` |
| File open | `NSWorkspace.shared.open()` | `ShellExecuteW()` |

### 11.3 Files Requiring Parity

| Swift (macOS) | C++ (Windows) |
|---------------|---------------|
| `macos/Runner/WindowControlPlugin.swift` | `windows/runner/window_control_plugin.cpp` |
| `macos/Runner/AppDelegate.swift` | `windows/runner/hotkey_handler.cpp` |
| `macos/Runner/MainFlutterWindow.swift` | `windows/runner/main_flutter_window.cpp` |
| `macos/Runner/HUDConfig.swift` | `windows/runner/hud_config.h` |

---

## 12. Native Configuration (HUDConfig)

```swift
struct HUDConfig {
    static let eyeSize: CGFloat = 48
    static let controlsBarHeight: CGFloat = 48
    static let controlsBarWidth: CGFloat = 280
    static let defaultChatWidth: CGFloat = 427
    static let defaultChatHeight: CGFloat = 293
    static let minChatWidth: CGFloat = 300
    static let minChatHeight: CGFloat = 200
    static let maxChatWidth: CGFloat = 800
    static let maxChatHeight: CGFloat = 900
    static let margin: CGFloat = 16
    static let fallbackScreenRect = NSRect(x: 0, y: 0, width: 1920, height: 1080)
}
```

---

## 13. File Map

### Flutter (Dart)
| File | Purpose |
|------|---------|
| `lib/main.dart` | App entry, service init, hotkey bridge |
| `lib/ui/overlay_shell.dart` | State machine, transitions, layouts |
| `lib/ui/eye/eye_widget.dart` | Eye state widget (48px) |
| `lib/ui/feed/feed_view.dart` | Agent/stream feed with scroll/select/copy |
| `lib/ui/feed/idle_animation.dart` | Cat-eye animation (CustomPaint) |
| `lib/ui/input/command_input.dart` | Text input bar |
| `lib/core/models/hud_settings.dart` | HudState, HudTab, HudSettings |
| `lib/core/models/feed_item.dart` | FeedItem, FeedChannel, FeedPriority, FeedSender |
| `lib/core/models/spawn_task.dart` | SpawnTask, SpawnTaskStatus |
| `lib/core/services/websocket_service.dart` | WS client, streams, feed persistence |
| `lib/core/services/window_service.dart` | Platform channel to native window |
| `lib/core/services/settings_service.dart` | SharedPreferences persistence |
| `lib/core/constants.dart` | Fonts, sizes, colors |

### Native (macOS)
| File | Purpose |
|------|---------|
| `macos/Runner/MainFlutterWindow.swift` | NSPanel configuration |
| `macos/Runner/AppDelegate.swift` | Carbon hotkeys + method channel bridge |
| `macos/Runner/WindowControlPlugin.swift` | Window control platform channel |
| `macos/Runner/HUDConfig.swift` | Dimension constants |

### Core (TypeScript)
| File | Purpose |
|------|---------|
| `sinain-core/src/overlay/ws-handler.ts` | WS server, broadcast, replay buffer |
| `sinain-core/src/overlay/commands.ts` | Command routing (toggle, user_command, spawn) |
| `sinain-core/src/types.ts` | Message type definitions |

---

## 14. Implementation Status

### Done
- [x] 3-state model (Eye, Controls, Chat, Hidden)
- [x] State machine transitions + cycleState()
- [x] Window resize per state
- [x] Native moveWindowBy (delta-based drag)
- [x] Native resizeWindowBy (with anchors)
- [x] Feed persistence (agentFeedItems)
- [x] User message rendering (right-aligned cyan)
- [x] Thinking indicator (broadcast)
- [x] Chat header controls (screen/audio/mic toggles)
- [x] Settings button (open .env)
- [x] Resize handles on chat edges
- [x] Hide/restore sync (window.isVisible)
- [x] Copy on long-press
- [x] All 19 hotkeys (macOS): Space, M, H, F, T, A, Up, Down, S, V, E, P, Y, R, B, /
- [x] Tasks tab with IndexedStack + tab indicator (AGT/TSK)
- [x] Contextual eye animation (pupilDilation: thinking=0.3, newContent=0.6)
- [x] Demo mode badge ("DEMO" in red on controls bar + chat header)
- [x] Windows platform parity (7 new methods + hotkey updates)
- [x] focusInput() — Cmd+Shift+/ transitions to Chat + focuses TextField
- [x] resetPosition() — Cmd+Shift+P resets to default bottom-right
- [x] Tooltip removal (no hover messages per design requirement)
