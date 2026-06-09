# Grammarly Mode — Region Eyes (v2)

Region eyes surface actionable screen areas (errors, typos, fixable code,
stuck questions) as small clickable sinain eye icons positioned at the real
screen location of the issue. Tapping an eye opens the main HUD chat next to
the region, showing the detected issue and the suggested approach; the user
launches the background agent task explicitly from there (taps never
auto-spawn).

This is the v2 redesign on top of current main. It replaces the v1 prototype
from `feat/region-multi-window` (grid-positioned placeholder eyes, text-blob
context, per-region multi-engine windows planned but never built).

## Design principles

1. **The LLM never invents coordinates.** Screen OCR lines in the analyzer
   prompt are prefixed with `[S<id>]` (the SenseEvent id). The LLM anchors
   each region by echoing `sourceId`; sinain-core resolves the bbox from that
   event's `imageBbox` + `frameSize` (capture-frame pixels, sent by
   sense_client). Regions without a resolvable bbox stack in the top-right
   screen corner.

2. **Stable region identity.** `regionId = "r-" + sha256(normalized issue)[0:10]`.
   The same issue re-detected on a later tick keeps its id — no eye flicker.
   The overlay reconciles panels by id (create/move/remove deltas only).

3. **Main HUD as viewport, eyes as tabs.** Tapping an eye opens the HUD chat
   near the region with a region action banner (issue + tip + explicit Run
   button). Spawns run in parallel (up to 3 concurrent), each region's status
   routes back to its eye badge (idle → working → ready/failed); results land
   in the chat feed and the tasks pipeline. No multi-engine Flutter windows,
   no cross-engine channels.

4. **Spawn context assembled at spawn time, not detection time.** On tap,
   sinain-core builds the task from the tracked region (issue + tip + source
   OCR + the *current* digest) — never a stale text blob baked in at
   detection.

5. **Zero added LLM cost.** Regions piggyback on the existing analysis tick
   via an optional `regions` field in the response JSON.

## Data flow

```
sense_client ──POST /sense {roi: {bbox, frame_size}}──▶ SenseBuffer (imageBbox, frameSize)
                                                              │
agent tick: prompt lines tagged [S<id>] ──▶ LLM ──▶ {hud, digest, regions:[{issue, tip, action, sourceId}]}
                                                              │
RegionTracker (stable ids, bbox resolution, TTL expiry) ──▶ ws: region_highlight {regions:[{id, issue, tip, action, bbox, frameSize}]}
                                                              │
overlay RegionEyeController ──▶ scale bbox frame→screen ──▶ native RegionEyePool (48×48 NSPanels, sharingType=.none)
                                                              │ tap
chat opens near region + RegionActionBanner (issue, tip, ⚡ Run)
                                                              │ explicit Run
ws: spawn_command {text, regionId} ──▶ core builds task from tracker ──▶ escalator.dispatchSpawnTask(task, label, {regionId})
                                                              │
ws: spawn_task {taskId, status, regionId} ──▶ eye badge (working/ready/failed) + chat feed result
```

## Components

### sinain-core
- `types.ts` — `RawRegion` (LLM output), `RegionHighlight` (tracked, with
  bbox), `RegionHighlightMessage`, `regionId` on `SpawnCommandMessage` /
  `SpawnTaskMessage`, `frameSize` on `SenseEvent`, `regionsEnabled` on
  `AnalysisConfig`.
- `agent/analyzer.ts` — `REGIONS_SECTION` appended to the system prompt when
  `REGIONS_ENABLED` (default true); `[S<id>]` prefixes on screen lines;
  `parseRegions()` (max 3, validated action enum, sourceId).
- `agent/region-tracker.ts` — `RegionTracker`: stable content-hash ids, bbox
  resolution from the referenced sense event, expiry after 2 missed ticks or
  5 min, change detection (broadcast only on diff). `buildRegionSpawnTask()`:
  spawn-time context assembly.
- `agent/loop.ts` — `onRegions` callback fired every tick (also with
  undefined, so expiry advances).
- `index.ts` — wires tracker → `region_highlight` broadcast; region-aware
  `onSpawnCommand` (regionId → tracked region → task text).
- `overlay/ws-handler.ts` — replays the latest region set to late-joining
  overlay clients.
- `escalation/escalator.ts` — `spawnsInFlight` counter (max 3 concurrent,
  was a single boolean), `regionByTask` map echoes `regionId` on every
  `spawn_task` broadcast (cleared on terminal status).
- `overlay/commands.ts` — extracts `regionId` from `spawn_command`.

### sense_client
- `sender.py` — `frame_size: [w, h]` included in the `roi` payload
  (`package_roi` / `package_full_frame`); bbox stays in capture-frame pixels.

### overlay (Flutter, macOS)
- `core/models/region_highlight.dart` — wire model.
- `core/services/websocket_service.dart` — `region_highlight` → `regionStream`
  + cached `regions`; `regionId` on `SpawnTask`; `sendSpawnCommand(text,
  regionId:)`.
- `core/services/window_service.dart` — `getScreenSize`, `showRegionEyes`,
  `updateRegionEye`, `clearRegionEyes`, `regionTapStream` (native
  `onRegionTap` callback).
- `ui/regions/region_eye_controller.dart` — orchestration: bbox scaling
  (screen/frame), corner stacking fallback, tap → open chat near region,
  explicit `spawn()`, spawn_task status → eye badge, settings gate.
- `ui/regions/region_action_banner.dart` — banner above the chat input:
  issue + tip + ⚡ Run button (the only spawn trigger) + dismiss.
- `ui/overlay_shell.dart` — `_openChatNearRegion(x, y)`: moves the HUD next
  to the eye (top-left → macOS bottom-left conversion) and opens chat;
  holds the active region for the banner.
- `ui/settings/display_settings_panel.dart` — REGION EYES toggle
  (default ON, persisted).

### overlay (Swift, macOS)
- `macos/Runner/RegionEyePool.swift` — pool of non-activating floating
  NSPanels keyed by region id; `sharingType = .none` (invisible to screen
  capture); native-drawn eye with state border + badge (idle green / working
  orange pulse / ready green ✓ / failed red); taps → method channel.
- `macos/Runner/WindowControlPlugin.swift` — `getScreenSize`,
  `showRegionEyes`, `updateRegionEye`, `clearRegionEyes` cases.

## Interaction model (eyes as tabs)

- Tap an eye → HUD chat opens next to the region with the **region action
  banner**: the detected issue, the suggested approach, and a ⚡ Run button.
  Nothing spawns yet.
- Press **⚡ Run** → eye turns orange (working), the spawn fires with
  `regionId` (feed echo `⚡ [👁 fix] <issue>` appears in chat). Up to 3
  spawns run in parallel; duplicate launches are debounced overlay-side and
  fingerprint-deduped core-side.
- Tap another eye while the first is working → its own banner shows; running
  tasks keep going. The HUD re-anchors to the new region.
- A task completes → its eye badge flips to **ready** (green ✓) without
  hijacking the current view; the result lands in the chat feed (and the
  spawn task pipeline).
- Tap a **working/ready** eye → HUD chat opens near it; the banner shows the
  region again (Run is a no-op while working).
- Eyes disappear when the issue stops being detected (2 ticks) or after
  5 min; in-flight results still land in the chat feed.

## Gating

- Core: `REGIONS_ENABLED=true|false` (.env) — when off, the LLM isn't even
  asked for regions (no prompt tokens spent).
- Overlay: "REGION EYES" toggle in display settings (default ON) — when off,
  panels are cleared and broadcasts ignored.

## Future work (deliberately deferred)

- Per-region chat windows (3-state Eye → Controls → Chat) — the regionId
  threading, parallel spawn lane, and tracker are the prerequisites; the
  main-HUD viewport can be upgraded without rework.
- Windows parity (`WDA_EXCLUDEFROMCAPTURE` popups in the C++ runner).
- Word-level bbox anchoring (needs OCR word boxes from the vision pipeline).
- Per-region conversation history (currently the shared chat feed).

## Verification

1. **Anchoring**: open a terminal with an error visible → eye should appear
   near the error region (sense ROI), not in a fixed grid.
2. **Stability**: same error across several ticks → the eye must not flicker
   or change id (`regions` log line in sinain-core shows the id set).
3. **Explicit spawn**: tapping an eye must only open the chat + banner —
   no task may launch until ⚡ Run is pressed.
4. **Parallel spawns**: run two regions back-to-back → both badges go
   orange, both results arrive independently (`spawnsInFlight` in /health).
4. **Badge routing**: result must flip only the originating eye to ✓.
5. **Privacy**: eyes must be invisible in a screen recording
   (sharingType = .none).
6. **Gating**: REGION EYES toggle off → panels disappear immediately;
   REGIONS_ENABLED=false → no `regions` field requested from the LLM.
