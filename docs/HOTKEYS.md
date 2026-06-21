# Hotkeys

SinainHUD is mouse-driven — every action has a clickable affordance in the overlay (cycle view by clicking the eye, switch tabs, toggle capture, quit, etc.). Two things have no natural on-screen affordance, so they get global hotkeys.

| Shortcut | Action |
|---|---|
| `Cmd+Shift+P` (macOS) / `Ctrl+Shift+P` (Windows) | Reset window position to default corner |
| `Ctrl+Opt+Cmd+C` (macOS) | **Enrich clipboard** — take whatever you just copied, add Sinain's live situational context + relevant knowledge-graph facts (as if the copied text were an ROI), and write back *your content + the enriched seed* so the next paste is already enriched. Leaves the clipboard untouched if it's empty/non-text or enrichment fails. |

Registered via Carbon's `RegisterEventHotKey` in `overlay/macos/Runner/AppDelegate.swift`. It works system-wide — no need to focus the overlay window.

> **Quit** is the overlay's button/menu, not a hotkey. It still tears down the whole stack (overlay + backend) via `applicationWillTerminate → BackendLauncher.stop`.
