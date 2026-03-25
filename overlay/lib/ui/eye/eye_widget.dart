import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/services/window_service.dart';
import '../feed/idle_animation.dart';

/// State 1: The Sinain eye — a 48px circle with the pulsing eye animation.
/// Click → expand to controls. Drag → reposition window. Long-press → hide.
class EyeWidget extends StatefulWidget {
  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  final VoidCallback? onDragEnd;
  final double pupilDilation;

  const EyeWidget({
    super.key,
    required this.onTap,
    this.onLongPress,
    this.onDragEnd,
    this.pupilDilation = 0.0,
  });

  @override
  State<EyeWidget> createState() => _EyeWidgetState();
}

class _EyeWidgetState extends State<EyeWidget> {
  bool _isDragging = false;
  late final WindowService _windowService;

  @override
  void initState() {
    super.initState();
    _windowService = context.read<WindowService>();
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: _isDragging ? null : widget.onTap,
      onLongPress: widget.onLongPress,
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

  void _onDragUpdate(DragUpdateDetails details) {
    _isDragging = true;
    // Fire and forget — don't await to avoid async buildup
    _windowService.moveWindowBy(details.delta.dx, -details.delta.dy);
  }

  void _onDragEnd(DragEndDetails details) {
    if (_isDragging) {
      widget.onDragEnd?.call();
    }
    Future.microtask(() => _isDragging = false);
  }
}
