# Grammarly Mode — Region Eye Design

Region eyes detect actionable screen areas (errors, fixable code, questions) and show clickable sinain eye icons at those positions. Each eye can spawn an agent task and will eventually become a standalone 3-state HUD (Eye → Controls → Chat).

## Architecture

```
Agent tick → regions[] with pre-built spawnContext → WS → overlay
  ↓
RegionEyeApp (Eye 48×48) — appears at ROI position
  ↓ user tap
RegionEyeApp (Controls 280×120) — shows issue/tip + spinner, fires spawn
  ↓ ~200ms: Phase 1 accepted (non-blocking)
  ↓ 5-45s: Phase 2 completes async
RegionEyeApp (Chat ~300×400) — shows result, optional follow-up input
```

Data flow: sense_client ROI detection → sinain-core agent LLM → `region_highlight` WS message → overlay creates `desktop_multi_window` Flutter windows → native Swift configures each as 48×48 transparent floating NSPanel with privacy mode.

---

## Phase 1: Backend — Parallel Spawns + Non-blocking RPC ✅

**Status**: Completed. Branch: `fix/goose-bare-agent`

### 1a. SpawnQueue replaces spawnInFlight boolean ✅

- `SpawnQueue` (maxConcurrent:5, maxQueued:10) wired into `escalator.ts`
- Multiple ROI spawns can run in parallel
- **File**: `sinain-core/src/escalation/escalator.ts`

### 1b. Async two-phase RPC ✅

- `dispatchSpawnTask` uses `sendAgentRpcSplit()` instead of synchronous `sendRpc`
- Phase 1 (~200ms): delivery confirmed, queue slot freed immediately
- Phase 2 (5-45s): result handled async via `.then()`, never blocks
- `sendAgentRpcSplit` extended with `extraParams` for `lane`, `extraSystemPrompt`, `label`
- **File**: `sinain-core/src/escalation/openclaw-ws.ts`

### 1c. regionId routing ✅

- `regionId` added to `SpawnCommandMessage` and `SpawnTaskMessage` types
- Commands handler extracts and passes `regionId` through the pipeline
- `broadcastTaskEvent` includes `regionId` for overlay window targeting
- **Files**: `sinain-core/src/types.ts`, `sinain-core/src/overlay/commands.ts`

### 1d. Pre-built spawnContext with full context ✅

- When agent emits regions, `buildEscalationMessage()` serializes the full context window (screen OCR, audio transcripts, errors, app history) into each region's `spawnContext`
- `spawnContext` and `regionId` passed through `region_highlight` WS message
- Replaces the old approach of referencing `sinain_get_context` MCP tool (which OpenClaw subagents don't have access to)
- **Files**: `sinain-core/src/agent/loop.ts`, `sinain-core/src/index.ts`

---

## Phase 1.5: Flutter Multi-Window Foundation ✅

**Status**: Completed. Branch: `feat/region-multi-window`

### Multi-window via desktop_multi_window ✅

- Each region eye is a separate Flutter engine window
- Native Swift configures windows via `FlutterMultiWindowPlugin.setOnWindowCreatedCallback`
- 48×48, borderless, transparent, floating, privacy mode (`sharingType = .none`)
- Method channel `sinain_hud/region_window` for position/show/drag/tap
- **Files**: `overlay/macos/Runner/AppDelegate.swift`, `overlay/lib/main.dart`, `overlay/lib/ui/regions/region_eye_app.dart`

### Native drag support ✅

- NSEvent monitor for smooth native drag on region eye windows
- `beginDrag` handler in AppDelegate's `configureRegionWindow`

### Tap → spawn pipeline ✅

- Tap events forwarded from secondary engine → Swift → main engine via `mainWindowChannel`
- Main engine's `WindowService.regionTapStream` receives taps
- `OverlayShell` subscribes and dispatches spawn commands
- 2-second tap debounce prevents flood

### ROI coordinate scaling ✅

- Sense ROI bboxes flow through sinain-core to overlay
- `frameSize` included in `region_highlight` message
- Overlay computes `screenSize / frameSize` scale factor via `getScreenSize` native call
- Eyes positioned at actual ROI screen locations

---

## Phase 2: Region Window 3-State UI (TODO)

### 2a. Extend native secondary window capabilities

**File**: `overlay/macos/Runner/AppDelegate.swift` (`configureRegionWindow`)

Add to the method channel handler:
- `setWindowFrame` — resize window for Controls (280×120) and Chat (~300×400) states
- `makeKey` — `window.makeKeyAndOrderFront(nil)` for text input in Chat state
- `resignKey` — return focus when collapsing

Add static dictionary for cross-engine communication:
```swift
static var regionChannels: [String: FlutterMethodChannel] = [:]
```
Register each secondary engine's channel keyed by region ID when the Dart side calls `setPosition`.

### 2b. Add pushRegionState to WindowControlPlugin

**File**: `overlay/macos/Runner/WindowControlPlugin.swift`

New case in `handle()`:
```swift
case "pushRegionState":
    let regionId = args?["regionId"] as? String ?? ""
    if let ch = AppDelegate.regionChannels[regionId] {
        ch.invokeMethod("onStateUpdate", arguments: args)
    }
    result(nil)
```

This bridges the main Flutter engine → Swift → secondary Flutter engine.

### 2c. Route spawn_task events by regionId in OverlayShell

**File**: `overlay/lib/ui/overlay_shell.dart`

- Subscribe to `ws.spawnTaskStream`
- When a `spawn_task` message has a `regionId`, call `_windowService.pushRegionState(regionId, taskData)`
- In `_handleRegionTap()`: use pre-built `spawnContext` from region highlight instead of assembling text; include `regionId` in the spawn command
- In `_createRegionWindows()`: pass `spawnContext` in the args JSON

### 2d. Transform RegionEyeApp to 3-state

**File**: `overlay/lib/ui/regions/region_eye_app.dart`

Add `RegionState { eye, controls, chat }` enum and state machine:

- **Eye** (48×48): Current behavior. Tap → transition to Controls, fire spawn command via channel
- **Controls** (280×120): Show issue text, tip, action type, spinner while spawn in flight. Data already in `_regionData`. Listen for `onStateUpdate` from native channel
- **Chat** (~300×400): Show spawn result (scrollable), optional follow-up input via `CommandInput`. Call `makeKey` for text focus. Dismiss → back to Eye

### 2e. New widget files

- `overlay/lib/ui/regions/region_controls.dart` — Compact card: issue, tip, action buttons, spinner
- `overlay/lib/ui/regions/region_chat.dart` — Result display + optional CommandInput for follow-ups

---

## Phase 3: Pre-computation + Instant Feedback (TODO)

### 3a. Pre-assembled spawnContext ✅ (done in Phase 1d)

Already wired. Full context window serialized via `buildEscalationMessage("rich")` when regions are emitted.

### 3b. Instant transition on tap

On tap:
1. RegionEyeApp transitions to Controls state IMMEDIATELY (issue/tip from cached `_regionData`)
2. Sends `spawn_command` with pre-built `spawnContext` + `regionId` via native channel
3. Main window forwards to sinain-core WS
4. sinain-core: `sendAgentRpcSplit` → `acceptedPromise` resolves in ~200ms
5. `broadcastTaskEvent("spawned", regionId)` → main window routes to region window → spinner shows
6. Phase 2 completes (5-45s) → `broadcastTaskEvent("completed", regionId, resultPreview)` → region window transitions to Chat with result

**Perceived latency**: Eye → Controls is instant (0ms). Controls shows spinner. Result arrives in 5-45s (irreducible agent processing time).

---

## Phase 4: Polish (TODO)

- Clean up region windows when new `region_highlight` replaces old (close stale windows)
- Handle dismiss while spawn in flight (don't lose result — buffer it)
- Multiple taps debounce already in place (2s cooldown in RegionEyeApp)
- Consider auto-dismiss after N seconds of inactivity
- Persist region chat position on drag

---

## Files Summary

| File | Changes | Status |
|------|---------|--------|
| `sinain-core/src/escalation/escalator.ts` | SpawnQueue, sendAgentRpcSplit, regionId | ✅ |
| `sinain-core/src/escalation/openclaw-ws.ts` | extraParams on sendAgentRpcSplit | ✅ |
| `sinain-core/src/escalation/spawn-queue.ts` | regionId on SpawnEntry | ✅ |
| `sinain-core/src/types.ts` | regionId, spawnContext on message types | ✅ |
| `sinain-core/src/overlay/commands.ts` | Extract regionId from spawn_command | ✅ |
| `sinain-core/src/agent/loop.ts` | Full spawnContext via buildEscalationMessage | ✅ |
| `sinain-core/src/index.ts` | Pass spawnContext in region_highlight | ✅ |
| `overlay/macos/Runner/AppDelegate.swift` | configureRegionWindow, setWindowFrame/makeKey | ✅ base, TODO resize/key |
| `overlay/macos/Runner/WindowControlPlugin.swift` | pushRegionState handler | TODO |
| `overlay/lib/ui/overlay_shell.dart` | Route spawn_task by regionId, use spawnContext | TODO |
| `overlay/lib/ui/regions/region_eye_app.dart` | 3-state machine (Eye/Controls/Chat) | TODO |
| `overlay/lib/ui/regions/region_controls.dart` | New: Controls card widget | TODO |
| `overlay/lib/ui/regions/region_chat.dart` | New: Chat panel widget | TODO |
| `overlay/lib/core/services/websocket_service.dart` | Parse regionId from spawn_task | TODO |
| `overlay/lib/core/models/region_highlight.dart` | Add spawnContext field | TODO |

## Verification

1. **Parallel spawns**: Tap two different region eyes rapidly — both should show spinners, both should receive results independently
2. **Latency**: From tap to "spawned" status should be <500ms (Phase 1 only)
3. **3-state transition**: Eye → Controls (instant) → Chat (when result arrives) → Eye (dismiss)
4. **Main window free**: Main overlay should remain responsive and unblocked during region spawns
5. **Text input**: Chat state in region window should accept keyboard input for follow-up commands
6. **Result routing**: Spawn result should appear only in the region window that initiated it, not in the main feed (or optionally in both)
