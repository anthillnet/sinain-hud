# Task 3: Notch island session list must match the eye's list exactly (bookmarks + full functionality)

Files to edit (ONLY these three):
- `overlay/lib/ui/capture/session_list_view.dart`
- `overlay/lib/ui/overlay_shell.dart`
- `overlay/test/session_list_view_test.dart`

STRICT RULES:
- Do NOT reformat code you don't touch. Minimal, surgical diffs. No import reordering.
- Do not touch any other files.

## Background
`SessionListView` has two render paths gated by `widget.islandMode`:
- **island branch** (build(), ~line 196-240): compact ListView — live lane + tracked sessions + candidate groups only. NO "BOOKMARKED" section, no "TRACKING NOW" header, groups collapsed behind a chevron with actions hidden in an expanded sub-row, `LongPressDraggable` instead of `Draggable`, context cards `forceExpanded: true`.
- **eye branch** (~line 241-319): "TRACKING NOW" header, always-expanded session rows with inline ✦/⚑/✕ actions and hover preview on ✦, candidate groups, then a "BOOKMARKED" section with `_bookmarkRow` (▶ resume, ↗ share, ✕ release), plain `Draggable`.

The island was hover-expanded before; it now opens by click and pins as key window, so the reduced island UI is no longer wanted. The notch list must be IDENTICAL to the eye list in content and functionality.

## Changes in `overlay/lib/ui/capture/session_list_view.dart`
1. Remove the `islandMode` field and constructor parameter entirely.
2. Delete the island-only build branch (`if (widget.islandMode) { ... }` in `build()`).
3. Restructure the remaining (eye) layout so it also works in the short island window (~380px) WITHOUT RenderFlex overflow: turn the outer `Padding > Column[...]` into a single scrollable `ListView` (same outer padding `fromLTRB(14, 12, 14, 12)`, `padding: EdgeInsets.zero` on the ListView) whose children are, in the SAME order as today's eye branch:
   - "TRACKING NOW" header row (+ count)
   - live voice lane (if active)
   - empty-state text OR session rows (`_activeRow`) with the hover-preview text blocks
   - candidate groups
   - the 14px spacer
   - "BOOKMARKED" header row (+ count)
   - bookmarks empty-state text OR the `_bookmarkRow` entries inline (they are currently inside `Expanded(child: ListView(...))` — inline them as plain children; the outer ListView now scrolls everything). Do not change row widgets themselves.
4. In `_activeRow`, remove all `islandMode` branching so it renders exactly like the eye path today: header `onTap: null`, no agent-count/chevron suffix (keep the `s.paused` suffix variant), inline ✦/⚑/✕ actions with the hover preview MouseRegion, NO expanded-actions sub-row, `_contextCard(..., forceExpanded: false)`, and rows always expanded.
5. Delete the now-dead expansion machinery: `_isGroupExpanded`, `_expandedGroups`, `_initializedGroups` (and any related fields), if nothing else uses them.
6. In `_dragSource`, always return `Draggable<String>` (drop the `LongPressDraggable` island case).
7. Remove any other now-dead `islandMode` references (e.g. the `forceExpanded` argument value, comments that describe the island divergence).

## Changes in `overlay/lib/ui/overlay_shell.dart`
1. In `_buildAgentStack`, remove `islandMode: true` from the `SessionListView(...)` call (keep the `ValueKey('island-sessions')` and all callbacks).
2. Bump `static const double _stackListHeight = 228;` (line ~51) to `380` so the bookmarks section has room in the island window. Update the comment if there is one.

## Changes in `overlay/test/session_list_view_test.dart`
The last test (~line 230+) pumps `SessionListView(islandMode: true, ...)` and asserts collapse/expand on header taps. That behavior no longer exists. Rewrite this test to assert the unified behavior with the same fixtures: both agents' lane lines (`'waiting agent · permission needed'` and `'quiet agent · Read · code'`) are visible immediately without any tap, and the `'BOOKMARKED'` section header renders. Remove the `islandMode` parameter usage. Keep the rest of the file untouched.

## Verification
From `overlay/` (flutter binary at /opt/homebrew/bin/flutter):
- `flutter analyze` — no issues
- `flutter test` — all pass
