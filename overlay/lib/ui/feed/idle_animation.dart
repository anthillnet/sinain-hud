import 'dart:math';
import 'package:flutter/material.dart';

/// Sinain eye animation — pulsing ring, cat-slit pupil, radial spikes.
///
/// [pupilDilation] controls the pupil shape: 0.0 = narrow slit, 1.0 = full circle.
/// [cycleDuration] controls animation speed (default 4s = idle).
/// [alphaRange] controls brightness range (default 0.3→0.55 for idle).
/// [size] controls the widget size (default 80).
/// [label] optional text below the eye.
class IdleAnimation extends StatefulWidget {
  final String? label;
  final double pupilDilation;
  final Duration cycleDuration;
  final double alphaMin;
  final double alphaMax;
  final double size;

  const IdleAnimation({
    super.key,
    this.label,
    this.pupilDilation = 0.0,
    this.cycleDuration = const Duration(seconds: 4),
    this.alphaMin = 0.30,
    this.alphaMax = 0.55,
    this.size = 80,
  });

  @override
  State<IdleAnimation> createState() => _IdleAnimationState();
}

class _IdleAnimationState extends State<IdleAnimation>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: widget.cycleDuration,
    )..repeat(reverse: true);
  }

  @override
  void didUpdateWidget(IdleAnimation oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.cycleDuration != widget.cycleDuration) {
      _controller.duration = widget.cycleDuration;
      if (!_controller.isAnimating) {
        _controller.repeat(reverse: true);
      }
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Center(
      child: _AnimatedBuilder(
        listenable: _controller,
        builder: (context, _) {
          final t = _controller.value;
          return Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              SizedBox(
                width: widget.size,
                height: widget.size,
                child: CustomPaint(
                  painter: _PulseRingPainter(
                    t,
                    pupilDilation: widget.pupilDilation,
                    alphaMin: widget.alphaMin,
                    alphaMax: widget.alphaMax,
                  ),
                ),
              ),
              if (widget.label != null) ...[
                const SizedBox(height: 12),
                Text(
                  widget.label!,
                  style: TextStyle(
                    fontFamily: 'JetBrainsMono',
                    fontSize: 11,
                    color: Colors.white.withValues(
                      alpha: widget.alphaMin + t * (widget.alphaMax - widget.alphaMin),
                    ),
                  ),
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _PulseRingPainter extends CustomPainter {
  final double t;
  final double pupilDilation;
  final double alphaMin;
  final double alphaMax;

  _PulseRingPainter(
    this.t, {
    this.pupilDilation = 0.0,
    this.alphaMin = 0.15,
    this.alphaMax = 0.35,
  });

  static const _color = Color(0xFF00FF88);
  static const _lineCount = 8;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final baseRadius = size.width * 0.325; // ~26px at 80px size
    final radius = baseRadius + t * (size.width * 0.075); // ~6px expansion at 80px

    final alpha = alphaMin + t * (alphaMax - alphaMin);

    // Ring
    final ringPaint = Paint()
      ..color = _color.withValues(alpha: alpha)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.0;
    canvas.drawCircle(center, radius, ringPaint);

    // Cat-slit pupil — drifts lazily inside the ring
    // pupilDilation 0.0 = narrow slit, 1.0 = full circle
    final driftX = sin(t * pi * 0.7) * radius * 0.18;
    final driftY = cos(t * pi * 1.1) * radius * 0.12;
    final pupilCenter = center.translate(driftX, driftY);
    final slitHalfHeight = radius * 0.55;
    // Base slit width from breath + dilation controls how round the pupil is
    final baseSlitWidth = 3.0 + t * 4.0;
    final dilatedWidth = slitHalfHeight * 0.8; // near-circle width
    final slitHalfWidth = baseSlitWidth + (dilatedWidth - baseSlitWidth) * pupilDilation;

    final pupilPath = Path()
      ..moveTo(pupilCenter.dx, pupilCenter.dy - slitHalfHeight)
      ..quadraticBezierTo(
        pupilCenter.dx + slitHalfWidth, pupilCenter.dy,
        pupilCenter.dx, pupilCenter.dy + slitHalfHeight,
      )
      ..quadraticBezierTo(
        pupilCenter.dx - slitHalfWidth, pupilCenter.dy,
        pupilCenter.dx, pupilCenter.dy - slitHalfHeight,
      )
      ..close();

    final pupilPaint = Paint()
      ..color = _color.withValues(alpha: alpha * 0.8)
      ..style = PaintingStyle.fill;
    canvas.drawPath(pupilPath, pupilPaint);

    // Radial spike lines
    final linePaint = Paint()
      ..color = _color.withValues(alpha: alpha * 0.5)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5;

    for (int i = 0; i < _lineCount; i++) {
      final angle = i * pi / 4;
      final phase = sin(t * pi + i * 0.4);
      final lineLength = 3.0 + phase.abs() * 7.0;

      final startX = center.dx + cos(angle) * radius;
      final startY = center.dy + sin(angle) * radius;
      final endX = center.dx + cos(angle) * (radius + lineLength);
      final endY = center.dy + sin(angle) * (radius + lineLength);

      canvas.drawLine(Offset(startX, startY), Offset(endX, endY), linePaint);
    }
  }

  @override
  bool shouldRepaint(_PulseRingPainter oldDelegate) =>
      oldDelegate.t != t || oldDelegate.pupilDilation != pupilDilation;
}

/// Like AnimatedBuilder but works with newer Flutter
class _AnimatedBuilder extends AnimatedWidget {
  final Widget Function(BuildContext, Widget?) builder;

  const _AnimatedBuilder({
    required super.listenable,
    required this.builder,
  });

  @override
  Widget build(BuildContext context) {
    return builder(context, null);
  }
}
