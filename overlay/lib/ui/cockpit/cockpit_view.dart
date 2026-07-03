import 'package:flutter/material.dart';
import '../../core/models/work_state.dart';

/// The Athium attention cockpit (P1) — recreates "Athium Surfaces · §6" from the
/// design bundle. Honesty rendering is binding: qualitative tiers only, never raw
/// scores. Need = order + a 3-tier glyph (⚠ now · ◷ soon · · later); warmth is
/// color-cooled; evidence not affect; stuckness may color but carries no number.
///
/// See docs/DESIGN-WORK-STATE-MODEL.md.

// ── Palette (from the design bundle) ────────────────────────────────────────
class _C {
  static const panel = Color(0xFF1E1F22);
  static const card = Color(0xFF2B2D30);
  static const green = Color(0xFF1F8039); // RELIABLE / accent / warm
  static const orange = Color(0xFFE56D17); // PARTIAL / at-risk / now
  static const blue = Color(0xFF5B87E0); // "changed while away"
  static const red = Color(0xFFE5484D); // high re-entry
  static const grey = Color(0xFF6C707E); // dim / cool
  static const muted = Color(0xFFA8ADBD);
  static const text = Color(0xFFE8EAEE);
  static const hair = Color(0x0FFFFFFF); // rgba(255,255,255,.06)
  static const hairStrong = Color(0x1AFFFFFF); // rgba(255,255,255,.10)
  static const mono = 'JetBrainsMono';
}

typedef ThreadFeedback = void Function(String threadId, String action);

Color _warmth(ThreadCard t) {
  if (t.isActive) return _C.green;
  if (t.tier == NeedTier.now) return _C.orange;
  return _C.grey;
}

/// Region-thread dot: color-cooled by warmth (1 = just seen → green, 0 → grey),
/// mirroring the project-thread warmth cue. Never a number on screen.
Color _regionWarmth(double w) => Color.lerp(_C.grey, _C.green, w.clamp(0.0, 1.0))!;

/// Layered card shadow from the design bundle: a soft ambient drop plus a tight
/// contact shadow (`0 8px 32px /.26` + `0 2px 6px /.12`).
const _cardShadow = <BoxShadow>[
  BoxShadow(color: Color(0x42001C36), blurRadius: 32, offset: Offset(0, 8)),
  BoxShadow(color: Color(0x1F001C36), blurRadius: 6, offset: Offset(0, 2)),
];

({String glyph, Color color}) _glyph(NeedTier tier) {
  switch (tier) {
    case NeedTier.now:
      return (glyph: '⚠', color: _C.orange); // ⚠
    case NeedTier.soon:
      return (glyph: '◷', color: _C.muted); // ◷
    case NeedTier.later:
      return (glyph: '·', color: _C.grey); // ·
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 1 · Thread board — the hotkey-summoned panel
// ════════════════════════════════════════════════════════════════════════════
class AthiumCockpit extends StatelessWidget {
  final WorkStateView view;
  final ThreadFeedback onFeedback;
  const AthiumCockpit({super.key, required this.view, required this.onFeedback});

  @override
  Widget build(BuildContext context) {
    final active = view.active;
    return Container(
      width: 340,
      decoration: BoxDecoration(
        color: _C.panel,
        borderRadius: BorderRadius.circular(11),
        boxShadow: _cardShadow,
      ),
      padding: const EdgeInsets.fromLTRB(16, 15, 16, 15),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Text('ATTENTION',
                  style: TextStyle(fontFamily: _C.mono, fontSize: 12, fontWeight: FontWeight.w600, letterSpacing: 0.8, color: _C.muted)),
              const Spacer(),
              if (active != null)
                Text('▸ on: ${active.label}',
                    style: const TextStyle(fontFamily: _C.mono, fontSize: 10, color: _C.grey)),
            ],
          ),
          for (final t in view.background) _ThreadRow(t: t, onFeedback: onFeedback),
          if (active != null) _ActiveRow(t: active),
          if (view.board.isEmpty)
            const Padding(
              padding: EdgeInsets.only(top: 14),
              child: Text('No threads yet — observing.',
                  style: TextStyle(fontFamily: _C.mono, fontSize: 11, color: _C.grey)),
            ),
        ],
      ),
    );
  }
}

class _ThreadRow extends StatelessWidget {
  final ThreadCard t;
  final ThreadFeedback onFeedback;
  const _ThreadRow({required this.t, required this.onFeedback});

  @override
  Widget build(BuildContext context) {
    final g = _glyph(t.tier);
    final warmth = _warmth(t);
    return Container(
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.only(top: 11, bottom: 10),
      decoration: const BoxDecoration(border: Border(top: BorderSide(color: _C.hair))),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              SizedBox(width: 12, child: Text(g.glyph, textAlign: TextAlign.center, style: TextStyle(fontSize: 12, color: g.color))),
              const SizedBox(width: 9),
              Expanded(
                child: Text(t.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Colors.white)),
              ),
              const SizedBox(width: 8),
              CustomPaint(size: const Size(86, 22), painter: _Sparkline(t.trajectory, warmth)),
              const SizedBox(width: 8),
              SizedBox(
                width: 40,
                child: Text(t.ageLabel,
                    textAlign: TextAlign.right,
                    style: TextStyle(fontFamily: _C.mono, fontSize: 10, color: warmth)),
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.only(left: 21, top: 6),
            child: Wrap(spacing: 6, runSpacing: 4, children: [
              if (t.kgContext != null) _Chip('◆ ${t.kgContext}'),
              _Chip(t.evidence),
            ]),
          ),
          if (t.atRisk)
            Padding(
              padding: const EdgeInsets.only(left: 21, top: 9),
              child: _ResumeHook(t: t, onFeedback: onFeedback),
            ),
        ],
      ),
    );
  }
}

class _ResumeHook extends StatelessWidget {
  final ThreadCard t;
  final ThreadFeedback onFeedback;
  const _ResumeHook({required this.t, required this.onFeedback});

  @override
  Widget build(BuildContext context) {
    final resume = t.why.isNotEmpty ? t.why.first : 'pick up where you left off';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
      decoration: BoxDecoration(color: _C.orange.withValues(alpha: 0.09), borderRadius: BorderRadius.circular(7)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('↳ resume where you left off', style: TextStyle(fontSize: 10, color: _C.grey)),
          const SizedBox(height: 3),
          Text('"$resume"',
              style: const TextStyle(fontFamily: _C.mono, fontSize: 11, height: 1.35, color: _C.text)),
          const SizedBox(height: 9),
          Row(children: [
            _Btn('Pick it up', filled: true, onTap: () => onFeedback(t.topicId, 'accept')),
            const SizedBox(width: 6),
            _Btn('Not now', filled: false, onTap: () => onFeedback(t.topicId, 'dismiss')),
          ]),
        ],
      ),
    );
  }
}

class _ActiveRow extends StatelessWidget {
  final ThreadCard t;
  const _ActiveRow({required this.t});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.only(top: 11),
      decoration: const BoxDecoration(border: Border(top: BorderSide(color: _C.hairStrong))),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const SizedBox(width: 12, child: Text('●', textAlign: TextAlign.center, style: TextStyle(fontSize: 12, color: _C.green))),
              const SizedBox(width: 9),
              Expanded(
                child: Text(t.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Colors.white)),
              ),
              const SizedBox(width: 8),
              CustomPaint(size: const Size(86, 22), painter: _Sparkline(t.trajectory, _C.green)),
              const SizedBox(width: 8),
              const SizedBox(width: 40, child: Text('active', textAlign: TextAlign.right, style: TextStyle(fontFamily: _C.mono, fontSize: 10, color: _C.green))),
            ],
          ),
          if (t.kgContext != null)
            Padding(
              padding: const EdgeInsets.only(left: 21, top: 6),
              child: _Chip('◆ ${t.kgContext}'),
            ),
          // Region-threads (the within-surface layer) nest inside the active
          // project-thread: one hierarchy, project → regions (§9).
          if (t.regions.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(left: 21, top: 8),
              child: Container(
                padding: const EdgeInsets.only(left: 11),
                decoration: const BoxDecoration(
                  border: Border(left: BorderSide(color: _C.hairStrong)),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [for (final r in t.regions) _RegionRow(r)],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _RegionRow extends StatelessWidget {
  final RegionThread r;
  const _RegionRow(this.r);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Container(
            width: 5,
            height: 5,
            decoration: BoxDecoration(color: _regionWarmth(r.warmth), shape: BoxShape.circle),
          ),
          const SizedBox(width: 7),
          Expanded(
            child: Text(r.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontFamily: _C.mono, fontSize: 11, color: _C.muted)),
          ),
        ],
      ),
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 2 · Ambient pill — resting / need-crossed
// ════════════════════════════════════════════════════════════════════════════
class AmbientPill extends StatelessWidget {
  final WorkStateView view;
  const AmbientPill({super.key, required this.view});

  @override
  Widget build(BuildContext context) {
    final alert = view.topAlert;
    if (alert == null) {
      // Resting: a single calm dot.
      return Container(width: 7, height: 7, decoration: const BoxDecoration(color: _C.green, shape: BoxShape.circle));
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
      decoration: BoxDecoration(
        color: _C.card,
        borderRadius: BorderRadius.circular(7),
        border: Border.all(color: _C.orange.withValues(alpha: 0.4)),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        const Text('⚠', style: TextStyle(fontSize: 9, color: _C.orange)),
        const SizedBox(width: 7),
        Text('${alert.label} · left ${alert.ageLabel} ago',
            style: const TextStyle(fontSize: 10, color: _C.text)),
      ]),
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 2b · Resume marker — collapsed "Back to…" pill (dashed marching-ants border).
//      The COLLAPSED state of the resumption card: appears the moment the user
//      returns to a cooled thread; tapping it expands into the ResumptionCard.
// ════════════════════════════════════════════════════════════════════════════
class ResumeMarker extends StatefulWidget {
  final ThreadCard t;
  final VoidCallback onTap;
  const ResumeMarker({super.key, required this.t, required this.onTap});

  @override
  State<ResumeMarker> createState() => _ResumeMarkerState();
}

class _ResumeMarkerState extends State<ResumeMarker> with SingleTickerProviderStateMixin {
  // Marching ants: one dash+gap period (9px) per loop, ~0.6s — matches the
  // design's `@keyframes sinAnts { to { stroke-dashoffset:-16 } } 0.6s linear`.
  late final AnimationController _ants =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 600))..repeat();

  @override
  void dispose() {
    _ants.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = _warmth(widget.t);
    // The regular ROI-eye, with the dashing around the eye itself, plus the
    // text tab — the eye stays pinned at the top-right corner, the tab slides
    // out to its left. No return glyph; the dashed ring signals "resume".
    return GestureDetector(
      onTap: widget.onTap,
      child: Row(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.center, children: [
        Flexible(
          child: Container(
            decoration: BoxDecoration(color: _C.card, borderRadius: BorderRadius.circular(6)),
            padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
            child: Text('Welcome back · ${widget.t.label}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12, color: _C.text)),
          ),
        ),
        const SizedBox(width: 7),
        AnimatedBuilder(
          animation: _ants,
          builder: (context, _) => CustomPaint(
            foregroundPainter: _AntsRing(color: color, phase: _ants.value * 9),
            child: const Padding(padding: EdgeInsets.all(5), child: _EyeMark(size: 18)),
          ),
        ),
      ]),
    );
  }
}

/// Marching-ants dashed ring around the eye (design `sinAnts`: dash 5, gap 4).
class _AntsRing extends CustomPainter {
  final Color color;
  final double phase;
  const _AntsRing({required this.color, required this.phase});

  @override
  void paint(Canvas canvas, Size size) {
    final path = Path()..addOval(Offset.zero & size);
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5;
    const dash = 5.0, gap = 4.0;
    for (final metric in path.computeMetrics()) {
      var dist = -(phase % (dash + gap));
      while (dist < metric.length) {
        final start = dist < 0 ? 0.0 : dist;
        final end = (dist + dash).clamp(0.0, metric.length);
        if (end > start) canvas.drawPath(metric.extractPath(start, end), paint);
        dist += dash + gap;
      }
    }
  }

  @override
  bool shouldRepaint(_AntsRing old) => old.phase != phase || old.color != color;
}

// ════════════════════════════════════════════════════════════════════════════
// 3 · Calibrated Resume Card (P5) — the re-entry instrument (not a summary)
//     Five heads: resume_brief · reentry_cost (tier) · estimated_focus_time
//     (band) · next_likely_action (top-k) · continuation_probability (loudness).
//     Every surfaced claim carries its evidence. See
//     docs/DESIGN-WSM-SIGNAL-INVENTORY.md §6.
// ════════════════════════════════════════════════════════════════════════════
class CalibratedResumeCard extends StatelessWidget {
  final ResumeCard card;
  final ThreadFeedback onFeedback;
  /// "Resume thread" — open sinain chat with a re-entry nudge (context
  /// preloaded, next steps). The shell fires the resume command + lane switch.
  final void Function(String threadId) onResume;
  final VoidCallback onCollapse;
  const CalibratedResumeCard({super.key, required this.card, required this.onFeedback, required this.onResume, required this.onCollapse});

  Color get _tierColor => switch (card.reentryTier) {
        'high' => _C.red,
        'medium' => _C.orange,
        _ => _C.green,
      };
  int get _tierBars => switch (card.reentryTier) { 'high' => 3, 'medium' => 2, _ => 1 };
  String get _tierLabel => switch (card.reentryTier) { 'high' => 'High', 'medium' => 'Medium', _ => 'Low' };

  @override
  Widget build(BuildContext context) {
    final hedged = card.reliability == 'low';
    return Container(
      width: 300,
      decoration: BoxDecoration(
        color: _C.panel,
        borderRadius: BorderRadius.circular(11),
        border: Border.all(color: (hedged ? _C.grey : _C.green).withValues(alpha: 0.4)),
        boxShadow: _cardShadow,
      ),
      padding: const EdgeInsets.fromLTRB(16, 15, 16, 14),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // header — eye pinned top-RIGHT (where the hero eye was); tapping it
          // (same area as the hero) collapses the card back to the marker.
          Row(children: [
            Expanded(
              child: Text('Resume · ${card.label}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: Colors.white)),
            ),
            const SizedBox(width: 5),
            GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: onCollapse,
              child: const Padding(padding: EdgeInsets.all(3), child: _EyeMark(size: 15)),
            ),
          ]),
          const SizedBox(height: 11),
          // head 1 — resume_brief (softened by reliability)
          const _Label('YOU LIKELY LEFT OFF'),
          const SizedBox(height: 3),
          Text(card.brief, style: const TextStyle(fontSize: 12, height: 1.35, color: _C.text)),
          const SizedBox(height: 11),
          // head 2 + 3 — re-entry tier · focus band (paired)
          Row(children: [
            Expanded(
              child: _StatBox(
                label: 'RE-ENTRY',
                child: Row(children: [
                  _TierBars(bars: _tierBars, color: _tierColor),
                  const SizedBox(width: 6),
                  Text(_tierLabel, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Colors.white)),
                ]),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _StatBox(
                label: 'LIKELY BLOCK',
                child: Text(card.focusDisplay, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Colors.white)),
              ),
            ),
          ]),
          // head 5 — next likely actions (top-k)
          if (card.nextActions.isNotEmpty) ...[
            const SizedBox(height: 11),
            const _Label('NEXT LIKELY ACTIONS'),
            const SizedBox(height: 6),
            for (var i = 0; i < card.nextActions.length; i++)
              Padding(
                padding: const EdgeInsets.only(bottom: 5),
                child: _ActionRow(rank: i + 1, label: card.nextActions[i].label, primary: i == 0),
              ),
          ],
          // changed while away
          if (card.changedWhileAway != null) ...[
            const SizedBox(height: 6),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              decoration: BoxDecoration(color: _C.blue.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(6)),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Text('↻', style: TextStyle(fontSize: 11, color: _C.blue)),
                const SizedBox(width: 7),
                Expanded(child: Text(card.changedWhileAway!, style: const TextStyle(fontSize: 11, height: 1.35, color: _C.muted))),
              ]),
            ),
          ],
          const SizedBox(height: 12),
          // primary actions
          Row(children: [
            Expanded(child: _Btn('Resume thread', filled: true, big: true, onTap: () => onResume(card.threadId))),
            const SizedBox(width: 7),
            _Btn('Dismiss', filled: false, big: true, onTap: () => onFeedback(card.threadId, 'dismiss')),
          ]),
          // one-tap calibration feedback (rotate one prompt; here: usefulness)
          const SizedBox(height: 11),
          Container(
            padding: const EdgeInsets.only(top: 11),
            decoration: const BoxDecoration(border: Border(top: BorderSide(color: _C.hair))),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('Was this useful?', style: TextStyle(fontSize: 11, color: _C.grey)),
              const SizedBox(height: 7),
              Wrap(spacing: 6, runSpacing: 6, children: [
                _FbChip('Saved me re-loading', () => onFeedback(card.threadId, 'useful')),
                _FbChip('Somewhat', () => onFeedback(card.threadId, 'somewhat')),
                _FbChip('No', () => onFeedback(card.threadId, 'not-useful')),
              ]),
            ]),
          ),
        ],
      ),
    );
  }
}

class _StatBox extends StatelessWidget {
  final String label;
  final Widget child;
  const _StatBox({required this.label, required this.child});
  @override
  Widget build(BuildContext context) => Container(
        decoration: BoxDecoration(color: _C.card, borderRadius: BorderRadius.circular(7)),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: const TextStyle(fontSize: 9, letterSpacing: 0.5, fontWeight: FontWeight.w600, color: _C.grey)),
          const SizedBox(height: 3),
          child,
        ]),
      );
}

class _TierBars extends StatelessWidget {
  final int bars; // 1..3 filled
  final Color color;
  const _TierBars({required this.bars, required this.color});
  @override
  Widget build(BuildContext context) => Row(mainAxisSize: MainAxisSize.min, children: [
        for (var i = 0; i < 3; i++)
          Padding(
            padding: const EdgeInsets.only(right: 2),
            child: Container(width: 5, height: 11, decoration: BoxDecoration(color: i < bars ? color : const Color(0xFF3A3D42), borderRadius: BorderRadius.circular(1))),
          ),
      ]);
}

class _ActionRow extends StatelessWidget {
  final int rank;
  final String label;
  final bool primary;
  const _ActionRow({required this.rank, required this.label, required this.primary});
  @override
  Widget build(BuildContext context) => Container(
        decoration: BoxDecoration(
          color: const Color(0xFF15161A),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: primary ? _C.green.withValues(alpha: 0.3) : Colors.white.withValues(alpha: 0.06)),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
        child: Row(children: [
          Text('$rank', style: TextStyle(fontSize: 10, fontWeight: FontWeight.w700, color: primary ? _C.green : _C.grey)),
          const SizedBox(width: 8),
          Expanded(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, color: primary ? _C.text : _C.muted))),
        ]),
      );
}

class _FbChip extends StatelessWidget {
  final String label;
  final VoidCallback onTap;
  const _FbChip(this.label, this.onTap);
  @override
  Widget build(BuildContext context) => GestureDetector(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(5), border: Border.all(color: Colors.white.withValues(alpha: 0.16))),
          child: Text(label, style: const TextStyle(fontSize: 11, color: _C.muted)),
        ),
      );
}

// ════════════════════════════════════════════════════════════════════════════
// 4 · The offer — Alert, never modal
// ════════════════════════════════════════════════════════════════════════════
class OfferCard extends StatelessWidget {
  final ThreadCard t;
  final ThreadFeedback onFeedback;
  const OfferCard({super.key, required this.t, required this.onFeedback});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 226,
      decoration: BoxDecoration(
        color: _C.card,
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: _C.green.withValues(alpha: 0.5)),
        boxShadow: const [BoxShadow(color: Color(0x52001C36), blurRadius: 26, offset: Offset(0, 8))],
      ),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('${t.label} looks stuck where you left it',
              style: const TextStyle(fontSize: 11, height: 1.35, color: _C.text)),
          const SizedBox(height: 3),
          Text('"${t.evidence}" · ${t.ageLabel}',
              style: const TextStyle(fontFamily: _C.mono, fontSize: 10, color: _C.muted)),
          const SizedBox(height: 9),
          Row(children: [
            _Btn('Pick it up', filled: true, onTap: () => onFeedback(t.topicId, 'accept')),
            const SizedBox(width: 6),
            _Btn('Not now', filled: false, onTap: () => onFeedback(t.topicId, 'dismiss')),
          ]),
        ],
      ),
    );
  }
}

// ── Shared bits ─────────────────────────────────────────────────────────────
class _Label extends StatelessWidget {
  final String text;
  const _Label(this.text);
  @override
  Widget build(BuildContext context) => Text(text,
      style: const TextStyle(fontSize: 10, letterSpacing: 0.6, fontWeight: FontWeight.w600, color: _C.grey));
}

class _Chip extends StatelessWidget {
  final String text;
  const _Chip(this.text);
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
        decoration: BoxDecoration(color: _C.card, borderRadius: BorderRadius.circular(4)),
        child: Text(text, style: const TextStyle(fontSize: 10, color: _C.muted)),
      );
}

class _Btn extends StatelessWidget {
  final String label;
  final bool filled;
  final bool big;
  final VoidCallback onTap;
  const _Btn(this.label, {required this.filled, required this.onTap, this.big = false});
  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: big ? 30 : 24,
        padding: EdgeInsets.symmetric(horizontal: big ? 12 : 11),
        decoration: BoxDecoration(
          color: filled ? _C.green : Colors.transparent,
          borderRadius: BorderRadius.circular(filled ? 6 : 5),
          border: filled ? null : Border.all(color: Colors.white.withValues(alpha: 0.18)),
        ),
        alignment: Alignment.center,
        child: Text(label,
            style: TextStyle(fontSize: big ? 13 : 11, fontWeight: FontWeight.w500, color: filled ? Colors.white : _C.muted)),
      ),
    );
  }
}

/// The Sinain eye mark from the design bundle — a dark disc with a green ring
/// and a vertical leaf pupil (SVG viewBox 0 0 30 30, rendered at [size]).
class _EyeMark extends StatelessWidget {
  final double size;
  const _EyeMark({this.size = 15});
  @override
  Widget build(BuildContext context) => CustomPaint(size: Size.square(size), painter: const _EyePainter());
}

class _EyePainter extends CustomPainter {
  const _EyePainter();
  @override
  void paint(Canvas canvas, Size size) {
    final s = size.width / 30.0; // viewBox is 30×30
    final c = Offset(15 * s, 15 * s);
    final r = 13.5 * s;
    canvas.drawCircle(c, r, Paint()..color = _C.panel);
    canvas.drawCircle(
      c,
      r,
      Paint()
        ..color = _C.green
        ..style = PaintingStyle.stroke
        ..strokeWidth = 3 * s,
    );
    final leaf = Path()
      ..moveTo(15 * s, 7.5 * s)
      ..cubicTo(17.6 * s, 11.5 * s, 17.6 * s, 18.5 * s, 15 * s, 22.5 * s)
      ..cubicTo(12.4 * s, 18.5 * s, 12.4 * s, 11.5 * s, 15 * s, 7.5 * s)
      ..close();
    canvas.drawPath(leaf, Paint()..color = _C.green);
  }

  @override
  bool shouldRepaint(_EyePainter old) => false;
}

/// Trajectory polyline (values 0..1, left→right).
class _Sparkline extends CustomPainter {
  final List<double> values;
  final Color color;
  const _Sparkline(this.values, this.color);

  @override
  void paint(Canvas canvas, Size size) {
    if (values.length < 2) return;
    const pad = 3.0;
    final n = values.length;
    final path = Path();
    for (var i = 0; i < n; i++) {
      final x = pad + i * (size.width - 2 * pad) / (n - 1);
      final y = (size.height - pad) - values[i].clamp(0, 1) * (size.height - 2 * pad);
      i == 0 ? path.moveTo(x, y) : path.lineTo(x, y);
    }
    canvas.drawPath(
      path,
      Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round,
    );
  }

  @override
  bool shouldRepaint(_Sparkline old) => old.values != values || old.color != color;
}
