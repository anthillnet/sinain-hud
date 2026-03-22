# Hotkeys

All global hotkeys use the **Cmd+Shift** prefix and are registered via Carbon's `RegisterEventHotKey` in `overlay/macos/Runner/AppDelegate.swift`. They work system-wide — no need to focus the overlay window.

## Display

| Shortcut | Action |
|---|---|
| `Cmd+Shift+Space` | Toggle overlay visibility |
| `Cmd+Shift+M` | Cycle display mode (feed → alert → minimal → hidden) |
| `Cmd+Shift+E` | Cycle HUD tab (Agent ↔ Tasks) |
| `Cmd+Shift+P` | Toggle position (bottom-right ↔ top-right) |
| `Cmd+Shift+R` | Toggle demo mode (privacy off — visible to screen capture) |
| `Cmd+Shift+H` | Quit overlay |

## Audio & Screen

| Shortcut | Action |
|---|---|
| `Cmd+Shift+T` | Toggle audio capture (mute/unmute transcription) |
| `Cmd+Shift+A` | Toggle audio feed on HUD (show/hide transcript items) |
| `Cmd+Shift+S` | Toggle screen capture pipeline |
| `Cmd+Shift+V` | Toggle screen feed on HUD (show/hide sense items) |

## Navigation

| Shortcut | Action |
|---|---|
| `Cmd+Shift+Up` | Scroll feed up (pauses auto-scroll) |
| `Cmd+Shift+Down` | Scroll feed down (resumes auto-scroll at bottom) |

## Utility

| Shortcut | Action |
|---|---|
| `Cmd+Shift+/` | Open command input (type commands to sinain-core) |
| `Cmd+Shift+Y` | Copy target message to clipboard |
| `Cmd+Shift+B` | Toggle trait voices |
