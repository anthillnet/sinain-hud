import 'dart:io';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/services/window_service.dart';
import '../feed/idle_animation.dart';
import '../hud_tooltip.dart';

/// State 1: The Sinain eye — a 48px circle with the pulsing eye animation.
/// Click → expand to controls. Drag → reposition window. Long-press → hide.
class EyeWidget extends StatefulWidget {
  final VoidCallback onTap;
  final VoidCallback? onDoubleTap;
  final VoidCallback? onLongPress;
  final VoidCallback? onSecondaryTap;
  final VoidCallback? onDragEnd;
  final double pupilDilation;
  final Color eyeColor;

  /// Degraded-state surface (runtime-architecture §3): when a stack service
  /// is stale/down or the backend is unreachable, the eye wears a small
  /// status dot and its tooltip leads with one human sentence.
  /// Null = healthy, no dot.
  final String? degradedHint;
  final Color degradedColor;

  const EyeWidget({
    super.key,
    required this.onTap,
    this.onDoubleTap,
    this.onLongPress,
    this.onSecondaryTap,
    this.onDragEnd,
    this.pupilDilation = 0.0,
    this.eyeColor = const Color(0xFF00FF88),
    this.degradedHint,
    this.degradedColor = const Color(0xFFFFAA00),
  });

  @override
  State<EyeWidget> createState() => _EyeWidgetState();
}

class _EyeWidgetState extends State<EyeWidget> {
  bool _isDragging = false;
  late final WindowService _windowService;
  static final bool _isMacOS = Platform.isMacOS;

  @override
  void initState() {
    super.initState();
    _windowService = context.read<WindowService>();
  }

  @override
  Widget build(BuildContext context) {
    final gestures = widget.onSecondaryTap != null
        ? 'Tap to expand · double-tap to grab a region · right-click for all actions · long-press to hide'
        : widget.onDoubleTap != null
            ? 'Tap to expand · double-tap to grab a region · long-press to hide'
            : 'Tap to expand, long-press to hide';
    final hint = widget.degradedHint;
    return HudTooltip(
      // Degraded state leads: the human sentence first, gestures second.
      message: hint != null ? '$hint\n$gestures' : gestures,
      child: GestureDetector(
        onTap: _isDragging ? null : widget.onTap,
        onDoubleTap: _isDragging ? null : widget.onDoubleTap,
        onLongPress: widget.onLongPress,
        onSecondaryTap: _isDragging ? null : widget.onSecondaryTap,
        onPanStart: _onDragStart,
        onPanUpdate: _onDragUpdate,
        onPanEnd: _onDragEnd,
        child: SizedBox(
          width: 48,
          height: 48,
          child: Stack(
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: Colors.black.withValues(alpha: 0.7),
                ),
                child: IdleAnimation(
                  size: 40,
                  pupilDilation: widget.pupilDilation,
                  color: widget.eyeColor,
                ),
              ),
              if (hint != null)
                Positioned(
                  right: 2,
                  bottom: 2,
                  child: Container(
                    width: 11,
                    height: 11,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: widget.degradedColor,
                      border: Border.all(
                        color: Colors.black.withValues(alpha: 0.85),
                        width: 1.5,
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  void _onDragStart(DragStartDetails details) {
    _isDragging = true;
    if (_isMacOS) {
      // Hand off to native — NSEvent monitor handles all tracking
      _windowService.beginNativeDrag();
    }
  }

  void _onDragUpdate(DragUpdateDetails details) {
    if (_isMacOS) return; // native is handling it
    _isDragging = true;
    _windowService.moveWindowBy(details.delta.dx, -details.delta.dy);
  }

  void _onDragEnd(DragEndDetails details) {
    if (!_isMacOS && _isDragging) {
      // Windows: persist position from Flutter side
      widget.onDragEnd?.call();
    }
    Future.microtask(() => _isDragging = false);
  }
}
