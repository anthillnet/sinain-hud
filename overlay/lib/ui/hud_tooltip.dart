import 'dart:async';
import 'package:flutter/material.dart';

/// Hover tooltip that never intercepts pointer events.
///
/// Uses [CustomSingleChildLayout] + [positionDependentBox] for content-sized,
/// bounds-clamped placement (matches Flutter's built-in Tooltip behavior).
/// [MouseRegion] is the only trigger — no [GestureDetector] means no
/// conflicts with the target's own tap handlers. [IgnorePointer] on the
/// overlay makes clicks pass through to the button below.
class HudTooltip extends StatefulWidget {
  final String message;
  final Widget child;
  final Duration waitDuration;
  final Duration hideDelay;

  const HudTooltip({
    super.key,
    required this.message,
    required this.child,
    this.waitDuration = const Duration(milliseconds: 400),
    this.hideDelay = const Duration(milliseconds: 150),
  });

  /// Dismiss every currently-visible HudTooltip AND cancel pending
  /// show timers. Call this from code paths that invalidate cached target
  /// positions (HUD state transitions, window resize, etc.).
  static void dismissAll() {
    for (final state in List<_HudTooltipState>.from(_states)) {
      state._showTimer?.cancel();
      state._hideTimer?.cancel();
      state._hide();
    }
  }

  /// All mounted tooltip states. Visibility is tracked separately via
  /// [_HudTooltipState._entry].
  static final Set<_HudTooltipState> _states = <_HudTooltipState>{};

  @override
  State<HudTooltip> createState() => _HudTooltipState();
}

class _HudTooltipState extends State<HudTooltip> {
  OverlayEntry? _entry;
  Timer? _showTimer;
  Timer? _hideTimer;

  @override
  void initState() {
    super.initState();
    HudTooltip._states.add(this);
  }

  void _scheduleShow() {
    _hideTimer?.cancel();
    if (_entry != null) return;
    _showTimer?.cancel();
    _showTimer = Timer(widget.waitDuration, _show);
  }

  void _scheduleHide() {
    _showTimer?.cancel();
    if (_entry == null) return;
    _hideTimer?.cancel();
    _hideTimer = Timer(widget.hideDelay, _hide);
  }

  void _show() {
    if (!mounted || _entry != null) return;

    final target = context.findRenderObject() as RenderBox?;
    if (target == null || !target.attached || !target.hasSize) return;

    final overlayState = Overlay.of(context);
    final overlayBox = overlayState.context.findRenderObject() as RenderBox?;
    if (overlayBox == null || !overlayBox.hasSize) return;
    final overlaySize = overlayBox.size;

    // Target center in overlay-local coordinates.
    final targetOffset = target.localToGlobal(
      target.size.center(Offset.zero),
      ancestor: overlayBox,
    );

    // Skip only if tooltip can't fit in either direction.
    // positionDependentBox handles the rest of the clamping.
    const estimatedTooltipHeight = 22.0;
    const margin = 10.0;
    final verticalOffset = target.size.height / 2 + 4;
    final canFitBelow = targetOffset.dy + verticalOffset + estimatedTooltipHeight
        <= overlaySize.height - margin;
    final canFitAbove = targetOffset.dy - verticalOffset - estimatedTooltipHeight
        >= margin;
    if (!canFitBelow && !canFitAbove) return;

    // Enforce singleton: dismiss every other visible tooltip.
    for (final other in List<_HudTooltipState>.from(HudTooltip._states)) {
      if (other != this && other._entry != null) other._hide();
    }

    _entry = OverlayEntry(
      builder: (_) => IgnorePointer(
        child: CustomSingleChildLayout(
          delegate: _HudTooltipLayoutDelegate(
            target: targetOffset,
            verticalOffset: verticalOffset,
            preferBelow: true,
          ),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 200),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(
                color: Colors.black.withValues(alpha: 0.9),
                borderRadius: BorderRadius.circular(4),
                border: Border.all(color: Colors.white.withValues(alpha: 0.15)),
              ),
              child: Text(
                widget.message,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontFamily: 'JetBrainsMono',
                  fontSize: 10,
                  color: Colors.white,
                  decoration: TextDecoration.none,
                ),
              ),
            ),
          ),
        ),
      ),
    );
    overlayState.insert(_entry!);
  }

  void _hide() {
    _entry?.remove();
    _entry = null;
  }

  @override
  void dispose() {
    HudTooltip._states.remove(this);
    _showTimer?.cancel();
    _hideTimer?.cancel();
    _hide();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      onEnter: (_) => _scheduleShow(),
      onExit: (_) => _scheduleHide(),
      child: widget.child,
    );
  }
}

class _HudTooltipLayoutDelegate extends SingleChildLayoutDelegate {
  final Offset target;
  final double verticalOffset;
  final bool preferBelow;

  _HudTooltipLayoutDelegate({
    required this.target,
    required this.verticalOffset,
    required this.preferBelow,
  });

  @override
  BoxConstraints getConstraintsForChild(BoxConstraints constraints) =>
      constraints.loosen();

  @override
  Offset getPositionForChild(Size size, Size childSize) =>
      positionDependentBox(
        size: size,
        childSize: childSize,
        target: target,
        verticalOffset: verticalOffset,
        preferBelow: preferBelow,
        margin: 10.0,
      );

  @override
  bool shouldRelayout(_HudTooltipLayoutDelegate old) =>
      target != old.target ||
      verticalOffset != old.verticalOffset ||
      preferBelow != old.preferBelow;
}
