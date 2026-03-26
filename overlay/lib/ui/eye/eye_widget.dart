import 'dart:io';
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
  final Color eyeColor;

  const EyeWidget({
    super.key,
    required this.onTap,
    this.onLongPress,
    this.onDragEnd,
    this.pupilDilation = 0.0,
    this.eyeColor = const Color(0xFF00FF88),
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
    return GestureDetector(
      onTap: _isDragging ? null : widget.onTap,
      onLongPress: widget.onLongPress,
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
          color: widget.eyeColor,
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
