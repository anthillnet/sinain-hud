import 'package:flutter/material.dart';

import '../feed/idle_animation.dart';

class AgentIslandBar extends StatefulWidget {
  final int working;
  final int waiting;
  final VoidCallback onEyeTap;
  final GestureDragUpdateCallback onEyeDragUpdate;
  final GestureDragEndCallback onEyeDragEnd;
  final VoidCallback onCountsTap;

  const AgentIslandBar({
    super.key,
    required this.working,
    required this.waiting,
    required this.onEyeTap,
    required this.onEyeDragUpdate,
    required this.onEyeDragEnd,
    required this.onCountsTap,
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
    return Container(
      height: 34,
      decoration: BoxDecoration(
        color: const Color(0xFF1E1F22),
        borderRadius: const BorderRadius.only(
          bottomLeft: Radius.circular(10),
          bottomRight: Radius.circular(10),
        ),
        border: Border.all(color: const Color(0x1AFFFFFF)),
        boxShadow: const [
          BoxShadow(color: Color(0x66000000), blurRadius: 12, offset: Offset(0, 4)),
        ],
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: widget.onEyeTap,
            onPanUpdate: widget.onEyeDragUpdate,
            onPanEnd: widget.onEyeDragEnd,
            child: const SizedBox(
              width: 30,
              height: 32,
              child: IdleAnimation(size: 14),
            ),
          ),
          Container(width: 1, height: 16, color: const Color(0x1FFFFFFF)),
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: widget.onCountsTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
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
                                  border: Border.all(color: const Color(0xFF3369D6)),
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
                      decoration: const BoxDecoration(
                        color: Color(0xFF3369D6),
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
          ),
        ],
      ),
    );
  }
}
