import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/services/window_service.dart';
import '../feed/idle_animation.dart';

/// State 1: The Sinain eye — a 48px circle with the pulsing eye animation.
/// Click → expand to controls. Drag → reposition window.
class EyeWidget extends StatefulWidget {
  final VoidCallback onTap;
  final double pupilDilation;

  const EyeWidget({
    super.key,
    required this.onTap,
    this.pupilDilation = 0.0,
  });

  @override
  State<EyeWidget> createState() => _EyeWidgetState();
}

class _EyeWidgetState extends State<EyeWidget> {
  Offset? _dragStartGlobal;
  Map<String, double>? _dragStartFrame;
  bool _isDragging = false;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: _isDragging ? null : widget.onTap,
      onPanStart: _onDragStart,
      onPanUpdate: _onDragUpdate,
      onPanEnd: _onDragEnd,
      child: Container(
        width: 48,
        height: 48,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: Colors.black.withValues(alpha: 0.7),
        ),
        child: IdleAnimation(
          size: 40,
          pupilDilation: widget.pupilDilation,
        ),
      ),
    );
  }

  void _onDragStart(DragStartDetails details) async {
    _isDragging = false;
    _dragStartGlobal = details.globalPosition;
    _dragStartFrame = await context.read<WindowService>().getWindowFrame();
  }

  void _onDragUpdate(DragUpdateDetails details) {
    if (_dragStartGlobal == null || _dragStartFrame == null) return;
    _isDragging = true;
    final dx = details.globalPosition.dx - _dragStartGlobal!.dx;
    final dy = details.globalPosition.dy - _dragStartGlobal!.dy;
    final frame = _dragStartFrame!;
    // macOS y-axis is inverted (origin at bottom-left)
    context.read<WindowService>().setWindowFrame(
          frame['x']! + dx,
          frame['y']! - dy,
          frame['w']!,
          frame['h']!,
        );
  }

  void _onDragEnd(DragEndDetails details) async {
    if (_isDragging) {
      // Persist the new position
      final frame = await context.read<WindowService>().getWindowFrame();
      if (frame != null) {
        // Save via settings service — import here to avoid circular
        // We'll use a callback instead
      }
    }
    _isDragging = false;
    _dragStartGlobal = null;
    _dragStartFrame = null;
  }
}
