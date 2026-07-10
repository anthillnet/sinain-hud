import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/constants.dart';
import '../../core/models/context_cards.dart';
import '../../core/theme/hud_theme.dart';

/// Deliberate-capture HUD controls (docs/DESIGN-DELIBERATE-CAPTURE.md §5,
/// wireframes: "Deliberate Capture.dc.html").
///
/// The gestures (Save · Call AI · Build context) are triggered from the
/// existing context menu; Save/Call AI open the compact range chooser, Build
/// context fires immediately on the clipboard. Cards render the results.

const _orange = Color(0xFFE56D17);

TextStyle _mono(double size, Color color,
        {FontWeight weight = FontWeight.w400, double? height}) =>
    TextStyle(
      fontFamily: HudConstants.monoFont,
      fontSize: size,
      color: color,
      fontWeight: weight,
      height: height,
    );

// ── Range chooser ───────────────────────────────────────────────────────────

class RangeChooser extends StatelessWidget {
  final String title; // "Save last…" | "Call AI on last…"
  final List<RangeOption> options;
  final int defaultMinutes;
  final ValueChanged<int> onPick;
  final VoidCallback onClose;

  const RangeChooser({
    super.key,
    required this.title,
    required this.options,
    required this.onPick,
    required this.onClose,
    this.defaultMinutes = 30,
  });

  @override
  Widget build(BuildContext context) {
    final t = HudTheme.of(context);
    final opts = options.isNotEmpty
        ? options
        : const [
            RangeOption(minutes: 5, covers: '', availableMinutes: 0),
            RangeOption(minutes: 15, covers: '', availableMinutes: 0),
            RangeOption(minutes: 30, covers: '', availableMinutes: 0),
            RangeOption(minutes: 60, covers: '', availableMinutes: 0),
          ];
    return Container(
      width: 264,
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: t.panelBg,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: t.border),
        boxShadow: t.shadow,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(10, 6, 6, 9),
            child: Row(children: [
              Expanded(
                  child: Text(title,
                      style: _mono(12, t.textPrimary,
                          weight: FontWeight.w600))),
              MouseRegion(
                cursor: SystemMouseCursors.click,
                child: GestureDetector(
                  onTap: onClose,
                  child: Text('✕', style: _mono(11, t.textDim)),
                ),
              ),
            ]),
          ),
          for (final o in opts) _option(t, o),
        ],
      ),
    );
  }

  Widget _option(HudTheme t, RangeOption o) {
    final selected = o.minutes == defaultMinutes;
    final capped =
        o.availableMinutes > 0 && o.availableMinutes < o.minutes;
    final covers = capped
        ? 'only ${o.availableMinutes} min so far'
        : (o.covers.isEmpty ? '—' : o.covers);
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => onPick(o.minutes),
        child: Container(
          margin: const EdgeInsets.only(bottom: 3),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          decoration: BoxDecoration(
            color: selected
                ? t.selectionAccent.withValues(alpha: 0.12)
                : Colors.transparent,
            borderRadius: BorderRadius.circular(7),
            border: Border.all(
                color: selected
                    ? t.selectionAccent.withValues(alpha: 0.5)
                    : Colors.transparent),
          ),
          child: Row(children: [
            SizedBox(
              width: 34,
              child: Text('${o.minutes}m',
                  style: _mono(13, t.textPrimary, weight: FontWeight.w600)),
            ),
            Expanded(
              child: Text(covers,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: _mono(10, t.textMuted)),
            ),
            if (selected)
              Text('default', style: _mono(9, t.selectionAccent)),
          ]),
        ),
      ),
    );
  }
}

// ── Shared card scaffolding ─────────────────────────────────────────────────

class _CardShell extends StatelessWidget {
  final Widget child;
  final Color? borderColor;
  final double width;
  const _CardShell(
      {required this.child, this.borderColor, this.width = 340});

  @override
  Widget build(BuildContext context) {
    final t = HudTheme.of(context);
    return Container(
      width: width,
      padding: const EdgeInsets.fromLTRB(15, 13, 15, 13),
      decoration: BoxDecoration(
        color: t.panelBg,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: borderColor ?? t.border),
        boxShadow: t.shadow,
      ),
      child: child,
    );
  }
}

class _SectionHead extends StatelessWidget {
  final String label;
  final Color? color;
  const _SectionHead(this.label, {this.color});

  @override
  Widget build(BuildContext context) {
    final t = HudTheme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 3, top: 8),
      child: Text(label,
          style: _mono(9, color ?? t.textDim, weight: FontWeight.w600)),
    );
  }
}

/// Honest shimmer lines — never a spinner (wireframe §5).
class _Shimmer extends StatefulWidget {
  final List<double> widths;
  const _Shimmer({this.widths = const [0.7, 0.92, 0.84, 0.66]});

  @override
  State<_Shimmer> createState() => _ShimmerState();
}

class _ShimmerState extends State<_Shimmer>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
      vsync: this, duration: const Duration(milliseconds: 1100))
    ..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = HudTheme.of(context);
    return AnimatedBuilder(
      animation: _c,
      builder: (_, __) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final w in widget.widths)
            FractionallySizedBox(
              widthFactor: w,
              child: Container(
                height: 8,
                margin: const EdgeInsets.only(bottom: 8),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(3),
                  gradient: LinearGradient(
                    begin: Alignment(-1 + 2 * _c.value, 0),
                    end: Alignment(-0.2 + 2 * _c.value, 0),
                    colors: [
                      t.bubbleBg,
                      t.bubbleBg.withValues(alpha: 0.45),
                      t.bubbleBg,
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

Widget _cardButton(HudTheme t, String label, VoidCallback onTap,
    {bool primary = false}) {
  return MouseRegion(
    cursor: SystemMouseCursors.click,
    child: GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Container(
        height: 28,
        padding: const EdgeInsets.symmetric(horizontal: 11),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: primary ? t.selectionAccent : Colors.transparent,
          borderRadius: BorderRadius.circular(6),
          border: primary ? null : Border.all(color: t.border),
        ),
        child: Text(label,
            style: _mono(11, primary ? Colors.white : t.textMuted,
                weight: primary ? FontWeight.w500 : FontWeight.w400)),
      ),
    ),
  );
}

// ── Situation brief (Call AI) ───────────────────────────────────────────────

class BriefCard extends StatelessWidget {
  final ContextBrief brief;
  final VoidCallback onDismiss;
  final VoidCallback onSaveRange;
  final VoidCallback onAskFollowUp;

  /// Where the follow-up goes: 'chat' (in-HUD agent lane) or 'term'
  /// (PTY seeded with the brief). Mirrors the tab-level chat/term switch.
  final String dest;
  final ValueChanged<String>? onDestChanged;

  const BriefCard({
    super.key,
    required this.brief,
    required this.onDismiss,
    required this.onSaveRange,
    required this.onAskFollowUp,
    this.dest = 'chat',
    this.onDestChanged,
  });

  Widget _destToggle(HudTheme t) {
    Widget pill(String id, String label) {
      final selected = dest == id;
      return MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () => onDestChanged?.call(id),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
            decoration: BoxDecoration(
              color: selected
                  ? t.selectionAccent.withValues(alpha: 0.18)
                  : Colors.transparent,
              borderRadius: BorderRadius.circular(5),
            ),
            child: Text(label,
                style: _mono(10, selected ? t.textPrimary : t.textDim,
                    weight: selected ? FontWeight.w600 : FontWeight.w400)),
          ),
        ),
      );
    }

    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: t.hairline),
      ),
      padding: const EdgeInsets.all(1),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        pill('chat', 'chat'),
        pill('term', '⌨ term'),
      ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    final t = HudTheme.of(context);
    final working = brief.status == CardStatus.working;
    return _CardShell(
      borderColor: brief.status == CardStatus.error
          ? _orange.withValues(alpha: 0.4)
          : t.selectionAccent.withValues(alpha: 0.35),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(children: [
            Expanded(
              child: Text(
                  working
                      ? 'Calling AI · last ${brief.minutes} min'
                      : 'Last ${brief.minutes} minutes${brief.partial ? " · partial" : ""}',
                  style:
                      _mono(13, t.textPrimary, weight: FontWeight.w600)),
            ),
            if (brief.latencyMs != null)
              Text('${(brief.latencyMs! / 1000).toStringAsFixed(2)}s',
                  style: _mono(10, t.textDim)),
            const SizedBox(width: 8),
            MouseRegion(
              cursor: SystemMouseCursors.click,
              child: GestureDetector(
                  onTap: onDismiss,
                  child: Text('✕', style: _mono(12, t.textDim))),
            ),
          ]),
          if (brief.coverage.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(brief.coverage, style: _mono(10, t.textDim)),
            ),
          const SizedBox(height: 8),
          if (working) const _Shimmer(),
          if (brief.status == CardStatus.error)
            Text(brief.error ?? 'failed',
                style: _mono(11, _orange, height: 1.4)),
          if (brief.status == CardStatus.ready) ...[
            if (brief.timeline.isNotEmpty) ...[
              const _SectionHead('TIMELINE'),
              for (final e in brief.timeline)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SizedBox(
                          width: 40,
                          child: Text(e.at,
                              textAlign: TextAlign.right,
                              style: _mono(10, t.textDim))),
                      const SizedBox(width: 8),
                      Expanded(
                          child: Text(e.what,
                              style: _mono(11, t.textMuted, height: 1.3))),
                    ],
                  ),
                ),
            ],
            if (brief.goal.isNotEmpty) ...[
              const _SectionHead('CURRENT GOAL'),
              Text(brief.goal,
                  style: _mono(12, t.textPrimary, height: 1.35)),
            ],
            if (brief.problems.isNotEmpty) ...[
              const _SectionHead('OPEN PROBLEMS', color: _orange),
              for (final p in brief.problems)
                Padding(
                  padding: const EdgeInsets.only(bottom: 3),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('• ',
                          style: TextStyle(color: _orange, fontSize: 11)),
                      Expanded(
                          child: Text(p,
                              style: _mono(11, t.textMuted, height: 1.3))),
                    ],
                  ),
                ),
            ],
            if (brief.entities.isNotEmpty) ...[
              const _SectionHead('ENTITIES'),
              Wrap(
                spacing: 6,
                runSpacing: 5,
                children: [
                  for (final e in brief.entities)
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 7, vertical: 3),
                      decoration: BoxDecoration(
                        color: t.bubbleBg,
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Text(e, style: _mono(10, t.textMuted)),
                    ),
                ],
              ),
            ],
            const SizedBox(height: 12),
            Row(children: [
              if (onDestChanged != null) ...[
                _destToggle(t),
                const SizedBox(width: 7),
              ],
              Expanded(
                  child: _cardButton(
                      t,
                      dest == 'term' ? 'Open terminal' : 'Ask follow-up',
                      onAskFollowUp,
                      primary: true)),
              const SizedBox(width: 7),
              _cardButton(t, 'Save this range', onSaveRange),
            ]),
          ],
        ],
      ),
    );
  }
}

// ── Enrich card (Build context) ─────────────────────────────────────────────

class EnrichCardWidget extends StatelessWidget {
  final EnrichCard card;
  final VoidCallback onDismiss;
  final VoidCallback? onCallAi;
  final VoidCallback? onCopy;

  const EnrichCardWidget({
    super.key,
    required this.card,
    required this.onDismiss,
    this.onCallAi,
    this.onCopy,
  });

  @override
  Widget build(BuildContext context) {
    final t = HudTheme.of(context);
    final working = card.status == CardStatus.working;
    return _CardShell(
      borderColor: card.status == CardStatus.error
          ? _orange.withValues(alpha: 0.4)
          : t.selectionAccent.withValues(alpha: 0.35),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(children: [
            Expanded(
                child: Text('Build context',
                    style: _mono(12, t.textPrimary, weight: FontWeight.w600))),
            if (card.latencyMs != null)
              Text('${(card.latencyMs! / 1000).toStringAsFixed(2)}s · last 10 min',
                  style: _mono(10, t.textDim)),
            const SizedBox(width: 8),
            MouseRegion(
              cursor: SystemMouseCursors.click,
              child: GestureDetector(
                  onTap: onDismiss,
                  child: Text('✕', style: _mono(12, t.textDim))),
            ),
          ]),
          Padding(
            padding: const EdgeInsets.only(top: 3),
            child: Text(card.focus,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: _mono(10, t.textDim)),
          ),
          const SizedBox(height: 6),
          if (working) const _Shimmer(widths: [0.85, 0.95, 0.6]),
          if (card.status == CardStatus.error)
            Text(card.error ?? 'failed',
                style: _mono(11, _orange, height: 1.4)),
          if (card.status == CardStatus.ready) ...[
            const _SectionHead('WHAT IT IS'),
            Text(card.what, style: _mono(11, t.textPrimary, height: 1.35)),
            const _SectionHead('HOW IT CONNECTS'),
            Text(card.connects,
                style: _mono(11, t.textPrimary, height: 1.35)),
            const _SectionHead('NEXT'),
            Text(card.next, style: _mono(11, t.textMuted, height: 1.35)),
            const SizedBox(height: 12),
            Row(children: [
              if (onCallAi != null)
                Expanded(
                    child: _cardButton(t, 'Call AI', onCallAi!, primary: true)),
              if (onCallAi != null && onCopy != null)
                const SizedBox(width: 7),
              if (onCopy != null) _cardButton(t, 'Copy', onCopy!),
            ]),
          ],
        ],
      ),
    );
  }
}

// ── Save receipt ────────────────────────────────────────────────────────────

class SaveReceiptCard extends StatefulWidget {
  final SaveReceipt receipt;
  final VoidCallback onUndo;
  final VoidCallback onDismiss;

  const SaveReceiptCard({
    super.key,
    required this.receipt,
    required this.onUndo,
    required this.onDismiss,
  });

  @override
  State<SaveReceiptCard> createState() => _SaveReceiptCardState();
}

class _SaveReceiptCardState extends State<SaveReceiptCard> {
  Timer? _ticker;
  int _remaining = 0;

  @override
  void initState() {
    super.initState();
    _syncCountdown();
  }

  @override
  void didUpdateWidget(SaveReceiptCard old) {
    super.didUpdateWidget(old);
    if (old.receipt.saveId != widget.receipt.saveId ||
        old.receipt.status != widget.receipt.status) {
      _syncCountdown();
    }
  }

  void _syncCountdown() {
    _ticker?.cancel();
    final undo = widget.receipt.undoSeconds;
    if (widget.receipt.status == SaveStatus.saved && undo != null) {
      _remaining = undo;
      _ticker = Timer.periodic(const Duration(seconds: 1), (t) {
        if (!mounted) return;
        setState(() => _remaining = _remaining > 0 ? _remaining - 1 : 0);
        if (_remaining == 0) t.cancel();
      });
    }
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  Widget _chip(HudTheme t, String label) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
        decoration: BoxDecoration(
          color: t.bubbleBg,
          borderRadius: BorderRadius.circular(4),
        ),
        child: Text(label, style: _mono(10, t.textMuted)),
      );

  @override
  Widget build(BuildContext context) {
    final t = HudTheme.of(context);
    final r = widget.receipt;
    final undoTotal = r.undoSeconds ?? 30;
    final (title, border) = switch (r.status) {
      SaveStatus.saving => (
          'Saving last ${r.minutes} min · ${r.coverage}…',
          t.border
        ),
      SaveStatus.saved => (
          'Saved to memory',
          t.selectionAccent.withValues(alpha: 0.35)
        ),
      SaveStatus.committed => (
          'Committed to memory',
          t.selectionAccent.withValues(alpha: 0.35)
        ),
      SaveStatus.undone => ('Save undone — nothing written', t.border),
      SaveStatus.error => ('Save failed', _orange.withValues(alpha: 0.4)),
    };
    return _CardShell(
      width: 320,
      borderColor: border,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(children: [
            Expanded(
                child: Text(title,
                    style: _mono(12, t.textPrimary, weight: FontWeight.w600))),
            if (r.status == SaveStatus.saved && _remaining > 0)
              MouseRegion(
                cursor: SystemMouseCursors.click,
                child: GestureDetector(
                  onTap: widget.onUndo,
                  child: Text('Undo',
                      style: _mono(11, t.selectionAccent,
                          weight: FontWeight.w500)),
                ),
              ),
            if (r.status != SaveStatus.saving) ...[
              const SizedBox(width: 10),
              MouseRegion(
                cursor: SystemMouseCursors.click,
                child: GestureDetector(
                    onTap: widget.onDismiss,
                    child: Text('✕', style: _mono(12, t.textDim))),
              ),
            ],
          ]),
          if (r.status == SaveStatus.error)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(r.error ?? 'unknown error',
                  style: _mono(11, _orange, height: 1.35)),
            ),
          if (r.status == SaveStatus.saved ||
              r.status == SaveStatus.committed) ...[
            const SizedBox(height: 8),
            Wrap(spacing: 6, runSpacing: 5, children: [
              if (r.facts != null) _chip(t, '${r.facts} facts'),
              if (r.entities != null) _chip(t, '${r.entities} entities'),
              if (r.cost != null)
                _chip(t, '\$${r.cost!.toStringAsFixed(2)}'),
            ]),
          ],
          if (r.status == SaveStatus.saved && _remaining > 0) ...[
            const SizedBox(height: 10),
            ClipRRect(
              borderRadius: BorderRadius.circular(2),
              child: LinearProgressIndicator(
                value: _remaining / undoTotal,
                minHeight: 3,
                backgroundColor: t.hairline,
                valueColor: AlwaysStoppedAnimation(
                    t.selectionAccent.withValues(alpha: 0.6)),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
