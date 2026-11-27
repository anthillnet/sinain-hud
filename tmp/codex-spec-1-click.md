# Task 1: Notch island — open session stack on click, not hover

Repo: Flutter overlay app. Files to edit (ONLY these two):
- `overlay/lib/ui/overlay_shell.dart`
- `overlay/lib/ui/agents/agent_island_bar.dart`

STRICT RULES:
- Do NOT reformat any code you don't touch. No whitespace-only diffs, no import reordering, no `dart format` on whole files. Keep diffs minimal and surgical.
- Do not touch any other files.

## Current behavior
The parked notch island expands from `_IslandView.bar` to `_IslandView.stack` (the session list) when the mouse hovers over it (`MouseRegion` with `_onIslandEnter` / `_onIslandExit` in `overlay_shell.dart` around line 3126), and auto-collapses 400ms after mouse exit via `_islandCollapseTimer` unless pinned. Clicking the counts area (`onCountsTap`, ~line 3111) pins the island open.

## Desired behavior
Hover does nothing. A click on the island bar (anywhere except the eye, which keeps its own tap behavior) opens the session stack pinned; clicking again collapses it. This click path already exists as `onCountsTap` — reuse it.

## Changes in `overlay/lib/ui/overlay_shell.dart`
1. Delete the `_onIslandEnter` and `_onIslandExit` methods (~lines 925-951).
2. Remove the `MouseRegion(onEnter: _onIslandEnter, onExit: _onIslandExit, ...)` wrapper around the island build (~line 3126) — keep its child tree (`ColoredBox(...)`) in place.
3. Remove the now hover-only state entirely:
   - field `bool _islandHoverExpanded = false;` (line 169) and every reference to it (lines ~862-863, ~893, ~954-955, ~962, ~3114).
   - field `Timer? _islandCollapseTimer;` (line 172) and every `.cancel()` reference (in `_setIslandView`, `_unparkIsland`, `_pinIsland`, `_collapseIsland`, `_showEyeContextMenu` ~line 1744, and `dispose()` ~line 2040), plus the `import` stays (Timer used elsewhere).
4. In `onCountsTap` (~line 3111-3120), simplify the condition
   `if (_islandView == _IslandView.bar || (_islandHoverExpanded && !_islandPinned))`
   to `if (_islandView == _IslandView.bar)`, and add a guard at the top of the callback: `if (_islandContextMenuOpen) return;` (this preserves the old "don't expand while the eye context menu is open" intent; `_islandContextMenuOpen` must remain a read field so the analyzer doesn't flag it unused).
5. Do not change `_pinIsland` / `_collapseIsland` semantics beyond removing the hover state lines.

## Changes in `overlay/lib/ui/agents/agent_island_bar.dart`
The bar's outer `GestureDetector` (~line 207) currently only handles `onSecondaryTap`. Add `onTap: widget.onCountsTap` to it, so a click anywhere on the bar (the eye and the segment/counts areas are opaque `GestureDetector`s and keep consuming their own taps) toggles the session stack — this matters when the bar is idle and shows no counts segment at all.

## Verification
From `overlay/`: run `flutter analyze` — must pass with no new warnings (in particular no unused-field/unused-element warnings from the removed hover state).
