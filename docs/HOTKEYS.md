# Hotkeys

SinainHUD is mouse-driven — every action has a clickable affordance in the overlay (cycle view by clicking the eye, switch tabs, toggle capture, quit, etc.). The one exception is recovering a window that's been dragged off-screen, so there is a single global hotkey for it.

| Shortcut | Action |
|---|---|
| `Cmd+Shift+P` (macOS) / `Ctrl+Shift+P` (Windows) | Reset window position to default corner |

Registered via Carbon's `RegisterEventHotKey` in `overlay/macos/Runner/AppDelegate.swift`. It works system-wide — no need to focus the overlay window.

> **Quit** is the overlay's button/menu, not a hotkey. It still tears down the whole stack (overlay + backend) via `applicationWillTerminate → BackendLauncher.stop`.
