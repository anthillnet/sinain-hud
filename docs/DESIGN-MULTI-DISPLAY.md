# Multi-Display Support — Implementation Plan

## Context

Multi-display was prototyped in PR #165 (ROIs follow the active display) and debugged
through PR #171 (wrong-screen placement, focus-following fallbacks, display-aware app
detection, eye migration on re-anchor). The display-id plumbing — `sck-capture
meta.json → sense_client → event.meta.screen → region.display → RegionEyePool` — is
complete and correct. But commit 526abd1 pinned capture to the primary display by
default (`--pin-display`, opt back in via `CAPTURE_FOLLOW_DISPLAY=true`) because the
capture-side *selection policy* was never solid: the active display is the one under
the **cursor**, which crosses screens constantly, so capture bounces between displays
and ROIs land on the wrong screen mid-bounce.

Independently, the overlay's own chrome is hardwired to the primary display: main HUD
placement/reset/snap, the manual region selector, and the persisted eye position all
assume `NSScreen.main` / display 0.

This plan fixes both. Out of scope: simultaneous capture of multiple displays (one
`SCStream` per display — deferred; expensive per-display OCR cost), Windows overlay
parity (no region features there yet), and the legacy CGDisplayCreateImage backend's
display-blindness (mitigated by the ≤8s IPC wait + auto-upgrade from a3e58d1).

---

## Chunk 1 — Capture display-selection policy

Goal: make "follow the active display" stable enough to be the default.

### 1.1 Frontmost-window display detection (`tools/sck-capture/main.swift`)

Replace the cursor heuristic as the primary signal. Port the approach already proven
in `sense_client/app_detector.py:27-55` to Swift:

- New `frontmostWindowDisplayID() -> CGDirectDisplayID?`:
  `CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)`,
  take the first layer-0 window (list is front-to-back), compute its bounds center,
  map to a display via `CGGetDisplaysWithPoint`.
- Existing `activeDisplayID()` (cursor, `main.swift:393-398`) becomes the fallback
  when no layer-0 window is found.

The prototype commit (598ed66) itself named this as the intended upgrade.

### 1.2 Hysteresis in the follow loop (`main.swift:477-507`)

The loop polls at 1 s and currently switches the instant the winner changes. Add
debounce state: track `candidateID` + consecutive-poll count; switch only after the
same display wins **3 consecutive polls (~3 s)**. Reset the counter whenever the
candidate flips back. Keep the macOS 14+ `updateConfiguration`/`updateContentFilter`
live-switch path (audio keeps flowing) and the pre-14 stay-on-initial behavior.
Log every switch with old→new ids.

The `meta.json` contract (`{timestamp, display, width, height}`) is unchanged — no
downstream changes needed for chunk 1.

### 1.3 Flip the default (`sinain-core/src/audio/capture-spawner-macos.ts:59-65`)

Last commit, only after manual two-display verification passes: invert the condition
so `--pin-display` is passed only when `CAPTURE_FOLLOW_DISPLAY=false`. Keep the
`opts.compat` stale-binary handling as is. Update `.env.example` and
`docs/CONFIGURATION.md`. If verification shows residual instability, ship 1.1+1.2
and keep the flag opt-in — the policy fix is valuable either way.

---

## Chunk 2 — Overlay multi-display correctness

Independent of chunk 1; every item below is broken today even with capture pinned.

### 2.1 Screen-resolution helper (`overlay/macos/Runner/WindowControlPlugin.swift`)

Add `static func screenContaining(_ frame: NSRect) -> NSScreen` — the `NSScreen` with
the largest intersection with `frame`; fallback to the screen at global origin
`.zero`, then `NSScreen.main`. This mirrors `RegionEyePool.screenFor`
(`RegionEyePool.swift:313-330`), which deliberately avoids `NSScreen.main` because it
follows key focus.

### 2.2 Snap against the window's own screen

`snapToEdges` (`WindowControlPlugin.swift:537-561`) snaps to
`NSScreen.main.visibleFrame` regardless of where the window is — dragging the HUD to
monitor 2 snaps it against monitor 1's edges. Pass the window frame in and use
`screenContaining(frame).visibleFrame`.

### 2.3 Rescue to the user's screen

`resetToDefaultPosition` (`WindowControlPlugin.swift:192-197`, wired to ⌘⇧P) and the
initial placement (`AppDelegate.swift:253-260`) use `NSScreen.main`. Use the screen
under the mouse cursor (`NSEvent.mouseLocation` → screen containing point) with
primary fallback — ⌘⇧P is a rescue gesture; it should bring the HUD to where the
user is.

### 2.4 React to display-configuration changes

Nothing observes screen changes today; unplugging a monitor can strand the HUD
off-screen. Observe `NSApplication.didChangeScreenParametersNotification` in the
plugin: if the HUD frame no longer intersects any `NSScreen.visibleFrame`, re-home it
via the reset path; then notify Dart over the channel (`onScreensChanged`) so
`region_eye_controller.dart` re-runs eye placement (eyes whose display disappeared
fall back to primary via the existing `screenFor` fallback).

### 2.5 Persist the eye's display with its position

`hud_settings.dart:28-30` stores a bare `eyeX/eyeY`; restore
(`main.dart:139-148`, `settings_service.dart:41`) can land off-screen after a layout
change. Add `eyeDisplay` (int, 0 = unset) to `HudSettings` + `SettingsService`.
Report the display id from native when a drag completes (add it to the
`onNativeDragComplete` payload via `screenContaining`). On restore, verify via
`getScreens()` (`window_service.dart:319-338`) that the stored display exists and the
point lies within it; otherwise fall back to the default position.

### 2.6 Multi-screen manual region selector

Today `RegionSelector` (`WindowControlPlugin.swift:574-640`) builds one panel sized
to `NSScreen.main.frame` — regions on other monitors can't be selected, and the
result carries no display id (Dart hardcodes display 0, `overlay_shell.dart:602`).

- **Swift**: create one panel + `RegionSelectView` per `NSScreen` (each at
  `screen.frame`), all tinted simultaneously. First `mouseDown` freezes the others;
  Esc cancels all. On confirm, convert the rect to that screen's local top-left
  coords and include `display` (NSScreenNumber) and that screen's `screenW/screenH`
  in the `selectRegion` result (`WindowControlPlugin.swift:286-290`).
- **Dart** (`overlay_shell.dart:593-618`): `display` flows through the existing
  numeric-field forwarding into the `region_select` WS message
  (`websocket_service.dart:576`). Fix the `_pendingManualPos` HUD teleport to map the
  selection's local coords through that display's global frame from `getScreens()` —
  mirror `_openChatNearRegion` (`overlay_shell.dart:1049-1077`).
- **Core**: `commands.ts:131-135` forwards `sel.display`; `onRegionSelect`
  (`index.ts:2498`) matches only sense events with `ev.meta.screen === sel.display`
  when scaling OCR lines (undefined/0 keeps today's behavior), and skips the tier-2
  live-frame crop-OCR when the current frame's display differs;
  `RegionTracker.addManual` (`region-tracker.ts:784-806`) accepts and stores
  `display` on the region so the eye renders on the selected screen
  (`RegionHighlight.display` already exists, `types.ts:135`).

---

## Suggested commit / PR structure

Two PRs, independently testable and revertable:

1. **capture-follow-policy** — 1.1, 1.2 as one commit; 1.3 (default flip + docs) as a
   separate final commit.
2. **overlay-multi-display** — 2.1–2.4 (Swift window chrome), 2.5 (persistence),
   2.6 (selector, spans Swift + Dart + core) as separate commits.

## Verification

Static: `cd tools/sck-capture && ./build.sh`; `cd sinain-core && npx tsc --noEmit`;
`cd overlay && flutter analyze && flutter test`.

Manual, on a two-display setup:

1. `CAPTURE_FOLLOW_DISPLAY=true ./start.sh` — move the frontmost window between
   displays: `meta.json.display` follows after ~3 s; waving the cursor across screens
   does NOT switch capture; audio (feed transcription) continues across a switch.
2. Eyes appear on the captured display; dragging a tracked window to the other
   display and refocusing migrates the eye (existing a361773 path).
3. Drag the HUD to display 2 — it snaps to display 2's edges. ⌘⇧P from display 2
   rescues to the cursor's screen.
4. Region-select: tint covers both screens; drag on display 2 → eye, chat, and OCR
   content all on/from display 2.
5. Change display arrangement / unplug display 2: HUD re-homes if stranded; display-2
   eyes fall back to primary.
6. Restart the overlay: eye restores to its saved display; with that display removed,
   it falls back to the default position.
