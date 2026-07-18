import 'package:flutter/material.dart';

import '../feed/idle_animation.dart';

class AgentIslandBar extends StatefulWidget {
  final int working;
  final int waiting;
  final String? trackedLabel;
  final int trackedActiveMs;
  final String? saveOfferLabel;
  final String? enrichLabel;
  final bool liveAssist;

  /// Agent-liveness color — the user's accent from settings (default green).
  final Color accent;
  final VoidCallback onEyeTap;
  final GestureDragUpdateCallback onEyeDragUpdate;
  final GestureDragEndCallback onEyeDragEnd;
  final VoidCallback onCountsTap;
  final VoidCallback? onSaveOfferTap;
  final VoidCallback? onEnrichTap;
  final VoidCallback? onLiveAssistTap;
  final double notchGap;
  final double notchHeight;
  final double barHeight;

  const AgentIslandBar({
    super.key,
    required this.working,
    required this.waiting,
    this.trackedLabel,
    this.trackedActiveMs = 0,
    this.saveOfferLabel,
    this.enrichLabel,
    this.liveAssist = false,
    required this.accent,
    required this.onEyeTap,
    required this.onEyeDragUpdate,
    required this.onEyeDragEnd,
    required this.onCountsTap,
    this.onSaveOfferTap,
    this.onEnrichTap,
    this.onLiveAssistTap,
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
  late final AnimationController _livePulse;

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
    _livePulse = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 700),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _halo.dispose();
    _pulse.dispose();
    _livePulse.dispose();
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
    final primary = _buildPrimary();
    final enrich =
        widget.liveAssist || widget.waiting > 0 || widget.enrichLabel == null
            ? null
            : _IslandSegment(
                color: const Color(0xFF4CAF6E),
                label: 'enrich? · ${widget.enrichLabel}',
                onTap: widget.onEnrichTap,
              );
    final content = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (primary != null) primary,
        if (primary != null && enrich != null)
          Container(width: 1, height: 16, color: const Color(0x1FFFFFFF)),
        if (enrich != null) enrich,
      ],
    );
    final counts = GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: widget.onCountsTap,
      child: Padding(
        padding: EdgeInsets.symmetric(
          horizontal: notchMode ? 8 : 10,
          vertical: notchMode || widget.barHeight >= 34 ? 8 : 3,
        ),
        child: widget.waiting > 0 && !widget.liveAssist
            ? Row(
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
              )
            : content,
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
          if (widget.waiting > 0 || primary != null || enrich != null) ...[
            if (!notchMode)
              Container(width: 1, height: 16, color: const Color(0x1FFFFFFF)),
            if (notchMode)
              // scaleDown: the wing width is an estimate — mono font metrics
              // and multi-digit counts must degrade gracefully, never overflow.
              Expanded(
                child: Center(
                  child: FittedBox(fit: BoxFit.scaleDown, child: counts),
                ),
              )
            else
              counts,
          ],
        ],
      ),
    );
  }

  Widget? _buildPrimary() {
    // Live voice is the one interruptive island state: it stays visible over
    // approvals, tracking, save offers, and agent activity.
    if (widget.liveAssist) {
      return _IslandSegment(
        color: const Color(0xFFE06C5B),
        labelColor: const Color(0xFFF2C4BC),
        label: '● live · call assist',
        // 700 ms each way matches the design's 1.4 s pulse cycle.
        pulse: _livePulse,
        onTap: widget.onLiveAssistTap,
      );
    }
    if (widget.waiting > 0) return null; // waiting uses the animated legacy row
    if (widget.saveOfferLabel != null) {
      return _IslandSegment(
        color: const Color(0xFF4CAF6E),
        label: 'save? ${widget.saveOfferLabel}',
        pulse: _pulse,
        onTap: widget.onSaveOfferTap,
      );
    }
    if (widget.trackedLabel != null) {
      final suffix = widget.working > 0
          ? '${widget.working} working'
          : _elapsed(widget.trackedActiveMs);
      return _IslandSegment(
        color: const Color(0xFF7A56D6),
        label: '${widget.trackedLabel} · $suffix',
        onTap: widget.onCountsTap,
      );
    }
    if (widget.working > 0) {
      return _IslandSegment(
        color: widget.accent,
        label: '${widget.working} working',
        pulse: _halo,
        halo: true,
        onTap: widget.onCountsTap,
      );
    }
    return null;
  }

  String _elapsed(int milliseconds) {
    final minutes = (milliseconds / 60000).floor();
    if (minutes < 60) return '${minutes.clamp(1, 59)}m';
    final hours = minutes ~/ 60;
    final remainder = minutes % 60;
    return remainder == 0 ? '${hours}h' : '${hours}h ${remainder}m';
  }
}

class _IslandSegment extends StatelessWidget {
  const _IslandSegment({
    required this.color,
    required this.label,
    this.onTap,
    this.pulse,
    this.halo = false,
    this.labelColor,
  });

  final Color color;
  final String label;
  final VoidCallback? onTap;
  final Animation<double>? pulse;
  final bool halo;
  final Color? labelColor;

  @override
  Widget build(BuildContext context) {
    Widget dot = Container(
      width: 7,
      height: 7,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );
    if (pulse != null) {
      dot = AnimatedBuilder(
        animation: pulse!,
        builder: (context, child) => Opacity(
          opacity: halo ? 1 : 0.55 + pulse!.value * 0.45,
          child: child,
        ),
        child: dot,
      );
    }
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          dot,
          const SizedBox(width: 5),
          Text(label,
              style: TextStyle(
                fontFamily: 'JetBrainsMono',
                fontSize: 10,
                color: labelColor ??
                    (color == const Color(0xFF4CAF6E)
                        ? const Color(0xFFCDE8D4)
                        : const Color(0xFFE8EAEE)),
              )),
        ]),
      ),
    );
  }
}
