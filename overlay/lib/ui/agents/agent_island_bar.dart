import 'package:flutter/material.dart';

import '../feed/idle_animation.dart';

class AgentIslandBar extends StatefulWidget {
  final int working;
  final int waiting;

  /// Agent-liveness color — the user's accent from settings (default green).
  final Color accent;
  final VoidCallback onEyeTap;
  final GestureDragUpdateCallback onEyeDragUpdate;
  final GestureDragEndCallback onEyeDragEnd;
  final VoidCallback onCountsTap;
  final double notchGap;
  final double notchHeight;
  final double barHeight;

  const AgentIslandBar({
    super.key,
    required this.working,
    required this.waiting,
    required this.accent,
    required this.onEyeTap,
    required this.onEyeDragUpdate,
    required this.onEyeDragEnd,
    required this.onCountsTap,
    this.notchGap = 0,
    this.notchHeight = 0,
    this.barHeight = 34,
  });

  @override
  State<AgentIslandBar> createState() => _AgentIslandBarState();
}

class _AgentIslandBarState extends State<AgentIslandBar>
    with TickerProviderStateMixin {
  late final AnimationController _halo;
  late final AnimationController _pulse;

  @override
  void initState() {
    super.initState();
    _halo = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 2400),
    )..repeat();
    _pulse = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 1),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _halo.dispose();
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final notchMode = widget.notchGap > 0;
    final eye = GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: widget.onEyeTap,
      onPanUpdate: widget.onEyeDragUpdate,
      onPanEnd: widget.onEyeDragEnd,
      child: SizedBox(
        width: notchMode ? 46 : 30,
        height: notchMode ? widget.notchHeight : widget.barHeight,
        child: const IdleAnimation(size: 14),
      ),
    );
    final counts = GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: widget.onCountsTap,
      child: Padding(
        padding: EdgeInsets.symmetric(
          horizontal: notchMode ? 8 : 10,
          vertical: notchMode || widget.barHeight >= 34 ? 8 : 3,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            AnimatedBuilder(
              animation: _halo,
              builder: (context, child) {
                final halo = Curves.easeOut.transform(_halo.value);
                return SizedBox(
                  width: 17,
                  height: 17,
                  child: Stack(alignment: Alignment.center, children: [
                    Transform.scale(
                      scale: 0.6 + halo * 1.6,
                      child: Opacity(
                        opacity: 1 - halo,
                        child: Container(
                          width: 7,
                          height: 7,
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            border: Border.all(color: widget.accent),
                          ),
                        ),
                      ),
                    ),
                    child!,
                  ]),
                );
              },
              child: Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(
                  color: widget.accent,
                  shape: BoxShape.circle,
                ),
              ),
            ),
            const SizedBox(width: 5),
            Text(
              '${widget.working} working',
              style: const TextStyle(
                fontFamily: 'JetBrainsMono',
                fontSize: 10,
                color: Color(0xFFE8EAEE),
              ),
            ),
            if (widget.waiting > 0) ...[
              const SizedBox(width: 7),
              Container(
                width: 2,
                height: 2,
                decoration: const BoxDecoration(
                  color: Color(0xFF6C707E),
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 7),
              AnimatedBuilder(
                animation: _pulse,
                builder: (context, child) => Opacity(
                  opacity: 1 - _pulse.value * 0.65,
                  child: child,
                ),
                child: Text(
                  '${widget.waiting} waiting',
                  style: const TextStyle(
                    fontFamily: 'JetBrainsMono',
                    fontSize: 10,
                    color: Color(0xFFD9A21B),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
    return Container(
      height: notchMode ? widget.notchHeight : widget.barHeight,
      decoration: BoxDecoration(
        color: notchMode ? const Color(0xFF000000) : const Color(0xFF1E1F22),
        borderRadius: const BorderRadius.only(
          bottomLeft: Radius.circular(10),
          bottomRight: Radius.circular(10),
        ),
        border: notchMode ? null : Border.all(color: const Color(0x1AFFFFFF)),
        boxShadow: notchMode
            ? null
            : const [
                BoxShadow(
                    color: Color(0x66000000),
                    blurRadius: 12,
                    offset: Offset(0, 4)),
              ],
      ),
      child: Row(
        mainAxisAlignment:
            notchMode ? MainAxisAlignment.start : MainAxisAlignment.center,
        children: [
          eye,
          if (notchMode) SizedBox(width: widget.notchGap),
          if (widget.working + widget.waiting > 0) ...[
            if (!notchMode)
              Container(width: 1, height: 16, color: const Color(0x1FFFFFFF)),
            if (notchMode) Expanded(child: Center(child: counts)) else counts,
          ],
        ],
      ),
    );
  }
}
