import 'dart:math';
import 'package:flutter/material.dart';

class IdleAnimation extends StatefulWidget {
  final String label;

  const IdleAnimation({super.key, this.label = 'awaiting sinain…'});

  @override
  State<IdleAnimation> createState() => _IdleAnimationState();
}

class _IdleAnimationState extends State<IdleAnimation>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 4),
    )..repeat(reverse: true);
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
                width: 80,
                height: 80,
                child: CustomPaint(
                  painter: _PulseRingPainter(t),
                ),
              ),
              const SizedBox(height: 12),
              Text(
                widget.label,
                style: TextStyle(
                  fontFamily: 'JetBrainsMono',
                  fontSize: 11,
                  color: Colors.white.withValues(alpha: 0.30 + t * 0.25),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _PulseRingPainter extends CustomPainter {
  final double t;

  _PulseRingPainter(this.t);

  static const _color = Color(0xFF00FF88);
  static const _lineCount = 8;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = 26.0 + t * 6.0;

    // Ring
    final ringPaint = Paint()
      ..color = _color.withValues(alpha: 0.15 + t * 0.20)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.0;
    canvas.drawCircle(center, radius, ringPaint);

    // Cat-slit pupil — drifts lazily inside the ring
    final driftX = sin(t * pi * 0.7) * radius * 0.18;
    final driftY = cos(t * pi * 1.1) * radius * 0.12;
    final pupilCenter = center.translate(driftX, driftY);
    final slitHalfHeight = radius * 0.55;
    final slitHalfWidth = 3.0 + t * 4.0; // narrows/widens with breath

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
      ..color = _color.withValues(alpha: 0.20 + t * 0.25)
      ..style = PaintingStyle.fill;
    canvas.drawPath(pupilPath, pupilPaint);

    // Radial lines
    final linePaint = Paint()
      ..color = _color.withValues(alpha: 0.10 + t * 0.15)
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
  bool shouldRepaint(_PulseRingPainter oldDelegate) => oldDelegate.t != t;
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
