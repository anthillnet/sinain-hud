# Task 2: Notch island — floor the wing text scale (session label readability)

File to edit (ONLY this one): `overlay/lib/ui/agents/agent_island_bar.dart`

STRICT RULES:
- Do NOT reformat code you don't touch. Minimal, surgical diff.
- Do not touch any other files.

## Current behavior
In notch mode, the bar's wing content (`counts` — session/tracked label, save-offer, enrich, working/waiting counts) is wrapped in:

```dart
Expanded(
  child: Center(
    child: FittedBox(fit: BoxFit.scaleDown, child: counts),
  ),
)
```

`FittedBox(scaleDown)` gives the child unbounded width, so a long session label takes its full intrinsic width and gets scaled down without limit — the text can become unreadably small.

## Desired behavior
The text never scales below a threshold. Define:

```dart
/// Wing text never scales below this — long labels ellipsize instead of
/// shrinking unreadably (12px label bottoms out at ~10px).
static const double _minWingTextScale = 0.85;
```

as a `static const` on `_AgentIslandBarState`. Bound the child's width so the scale-down factor can never go below it:

```dart
Expanded(
  child: Center(
    child: LayoutBuilder(
      builder: (context, constraints) => FittedBox(
        fit: BoxFit.scaleDown,
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: constraints.maxWidth / _minWingTextScale,
          ),
          child: counts,
        ),
      ),
    ),
  ),
)
```

Keep the existing "scaleDown: the wing width is an estimate…" comment in place (adjust wording only if needed).

For this to degrade via ellipsis instead of Row overflow when the width bound bites, the segments in the `content` Row (~line 110-118) must be flexible. Change:

```dart
final content = Row(
  mainAxisSize: MainAxisSize.min,
  children: [
    if (primary != null) primary,
    ...
    if (enrich != null) enrich,
  ],
);
```

so `primary` and `enrich` are each wrapped in `Flexible(child: ...)` (the divider Container between them stays as-is). `_IslandSegment` already ellipsizes its label via `Flexible` + `TextOverflow.ellipsis`, so once bounded it degrades gracefully.

## Verification
From `overlay/`: `flutter analyze` (binary at /opt/homebrew/bin/flutter) — must pass with no new warnings.
