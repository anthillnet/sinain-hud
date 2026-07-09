import 'dart:async';
import 'dart:math' as math;

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

// ── Range chooser (v2: presets + slider + live estimates) ──────────────────

const _blue = Color(0xFF3369D6);
const _amber = Color(0xFFD9A21B);
const _endRed = Color(0xFFB3361C);

/// Which gesture the chooser confirms — sets accent, consent label, and verb.
/// `call` carries BOTH destinations (Call AI / Call sinain) as two buttons on
/// the one card — one menu entry, the choice happens at confirm time.
enum ChooserKind { save, call }

class RangeChooser extends StatefulWidget {
  final ChooserKind kind;
  final List<RangeOption> options;
  final int defaultMinutes;

  /// Confirm with the picked range and source scope: `apps` is the selected
  /// subset of the range's sources (app names + "mic"), or null when nothing
  /// was deselected (= everything, no scope).
  final void Function(int minutes, List<String>? apps) onConfirm;

  /// Second confirm for [ChooserKind.call]: "Call sinain" (live voice call),
  /// next to the primary "Call AI" (text handoff). Null hides the button.
  final void Function(int minutes, List<String>? apps)? onConfirmAlt;
  final VoidCallback onClose;

  /// Context-card lookup: {covers, summary} for a duration. Results are
  /// cached per duration widget-side, so scrubbing the slider never re-asks.
  final Future<Map<String, dynamic>?> Function(int minutes)? previewAt;

  /// Sources (app names + "mic") in a duration — rendered as toggle chips so
  /// the user picks WHICH apps the gesture covers. Cached per duration.
  final Future<List<String>?> Function(int minutes)? sourcesAt;

  const RangeChooser({
    super.key,
    required this.kind,
    required this.options,
    required this.onConfirm,
    required this.onClose,
    this.onConfirmAlt,
    this.defaultMinutes = 30,
    this.previewAt,
    this.sourcesAt,
  });

  @override
  State<RangeChooser> createState() => _RangeChooserState();
}

class _RangeChooserState extends State<RangeChooser> {
  static const _presets = [5, 15, 30, 60];
  late int _minutes = widget.defaultMinutes;
  String? _covers;
  Timer? _debounce;
  // Per-duration context-card cache — slider scrubbing hits this, not the LLM.
  final Map<int, String> _summaryCache = {};
  final Map<int, String> _coversCache = {};
  bool _previewLoading = false;
  // Per-duration source list (apps + mic) + the user's deselections. The
  // exclusion set survives duration changes: unticking Slack at 30 min keeps
  // Slack unticked when the slider moves to 60.
  final Map<int, List<String>> _sourcesCache = {};
  final Set<String> _excluded = {};

  @override
  void initState() {
    super.initState();
    _fetchPreview(_minutes);
    _fetchSources(_minutes);
  }

  void _fetchSources(int n) {
    if (widget.sourcesAt == null) return;
    if (_sourcesCache.containsKey(n)) return; // cached — no call
    widget.sourcesAt!(n).then((list) {
      if (!mounted || list == null) return;
      setState(() => _sourcesCache[n] = list);
    });
  }

  /// Selected sources for the confirmed duration — null when nothing was
  /// deselected (no scope: the range is used whole).
  List<String>? get _selectedApps {
    final sources = _sourcesCache[_minutes];
    if (sources == null || _excluded.isEmpty) return null;
    final picked = sources.where((s) => !_excluded.contains(s)).toList();
    return picked.length == sources.length ? null : picked;
  }

  void _fetchPreview(int n) {
    if (widget.previewAt == null) return;
    if (_summaryCache.containsKey(n)) return; // cached — no call
    setState(() => _previewLoading = true);
    widget.previewAt!(n).then((p) {
      if (!mounted) return;
      setState(() {
        _previewLoading = false;
        if (p != null) {
          _summaryCache[n] = p['summary'] as String? ?? '';
          _coversCache[n] = p['covers'] as String? ?? '';
        }
      });
    });
  }

  Color get _accent => switch (widget.kind) {
        ChooserKind.call => _blue,
        ChooserKind.save => const Color(0xFF1F8039),
      };

  String get _title => switch (widget.kind) {
        ChooserKind.save => 'Save last…',
        ChooserKind.call => 'Call on last…',
      };

  String get _consentLabel => switch (widget.kind) {
        ChooserKind.save => 'COVERS',
        ChooserKind.call => 'AI WILL KNOW',
      };

  String get _verb => switch (widget.kind) {
        ChooserKind.save => 'Save $_minutes min',
        // Two destinations on one card — minutes live in the readout above.
        ChooserKind.call => 'Call AI',
      };

  /// Past ~90 min the readout warns; past 100 the range splits into two burst
  /// calls (quota edge) — information, never a wall.
  Color get _readoutColor =>
      _minutes > 100 ? _orange : (_minutes > 90 ? _amber : _accent);

  String get _coversText {
    final o = widget.options.where((o) => o.minutes == _minutes).firstOrNull;
    final base = _coversCache[_minutes] ?? _covers ?? o?.covers ?? '';
    final avail = widget.options.firstOrNull?.availableMinutes ?? 0;
    if (avail > 0 && avail < _minutes) return 'only $avail min so far';
    return base.isEmpty ? '—' : base;
  }

  // Extrapolated from the measured benchmark curve — no LLM call to render.
  String get _latency => '~${(0.75 + _minutes * 0.026).toStringAsFixed(1)}s';
  String get _cost => '~\$${(0.004 + _minutes * 0.00075).toStringAsFixed(2)}';

  void _setMinutes(int n) {
    setState(() => _minutes = n);
    _debounce?.cancel();
    // Cached durations render instantly; only a settled, new duration asks.
    _debounce = Timer(const Duration(milliseconds: 350), () {
      _fetchPreview(n);
      _fetchSources(n);
    });
  }

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = HudTheme.of(context);
    return Container(
      width: 300,
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
          // Header: glyph dot · title · live N readout
          Padding(
            padding: const EdgeInsets.fromLTRB(10, 6, 10, 9),
            child: Row(children: [
              Container(
                width: 10, height: 10,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(color: _accent, width: 2),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                  child: Text(_title,
                      style: _mono(12, t.textPrimary, weight: FontWeight.w600))),
              Text('$_minutes min',
                  style: _mono(15, _readoutColor, weight: FontWeight.w600)),
            ]),
          ),
          // Preset chips — the fast path
          Padding(
            padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
            child: Row(children: [
              for (final n in _presets) ...[
                Expanded(
                  child: MouseRegion(
                    cursor: SystemMouseCursors.click,
                    child: GestureDetector(
                      onTap: () => _setMinutes(n),
                      child: Container(
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: n == _minutes
                              ? _accent.withValues(alpha: 0.25)
                              : t.bubbleBgLow,
                          borderRadius: BorderRadius.circular(5),
                          border: Border.all(
                              color: n == _minutes
                                  ? _accent.withValues(alpha: 0.55)
                                  : t.hairline),
                        ),
                        child: Text('${n}m',
                            style: _mono(
                                10, n == _minutes ? Colors.white : t.textMuted)),
                      ),
                    ),
                  ),
                ),
                if (n != _presets.last) const SizedBox(width: 5),
              ],
            ]),
          ),
          // Slider — 5-min steps, escape hatch past the presets
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: SliderTheme(
              data: SliderThemeData(
                trackHeight: 4,
                activeTrackColor: _readoutColor.withValues(alpha: 0.75),
                inactiveTrackColor: Colors.white.withValues(alpha: 0.09),
                thumbColor: Colors.white,
                thumbShape:
                    const RoundSliderThumbShape(enabledThumbRadius: 7),
                overlayShape:
                    const RoundSliderOverlayShape(overlayRadius: 12),
                tickMarkShape: SliderTickMarkShape.noTickMark,
              ),
              child: Slider(
                min: 5, max: 120, divisions: 23,
                value: _minutes.toDouble(),
                onChanged: (v) => _setMinutes(v.round()),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 6),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('5 min', style: _mono(9, t.textDim)),
                Text('quota edge', style: _mono(9, _orange)),
              ],
            ),
          ),
          // Consent box: coverage + live estimates
          Container(
            margin: const EdgeInsets.fromLTRB(10, 2, 10, 4),
            padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
            decoration: BoxDecoration(
              color: t.bubbleBgLow,
              borderRadius: BorderRadius.circular(7),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(_consentLabel,
                    style: _mono(9, t.textDim, weight: FontWeight.w600)),
                const SizedBox(height: 4),
                if ((_sourcesCache[_minutes] ?? const []).isNotEmpty)
                  // App-selection chips: tap to exclude a source from the
                  // gesture — what's unticked never reaches the LLM/agent.
                  Wrap(
                    spacing: 5,
                    runSpacing: 5,
                    children: [
                      for (final src in _sourcesCache[_minutes]!)
                        _sourceChip(t, src),
                    ],
                  )
                else
                  Text(_coversText,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: _mono(11, t.textMuted, height: 1.35)),
                if ((_summaryCache[_minutes] ?? '').isNotEmpty) ...[
                  const SizedBox(height: 6),
                  Text(_summaryCache[_minutes]!,
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: _mono(11, t.textPrimary, height: 1.35)),
                ] else if (_previewLoading) ...[
                  const SizedBox(height: 6),
                  Text('summarizing…', style: _mono(10, t.textDim)),
                ],
                const SizedBox(height: 8),
                Row(children: [
                  Text(_latency, style: _mono(10, t.textDim)),
                  const SizedBox(width: 14),
                  Text(_cost, style: _mono(10, t.textDim)),
                  if (_minutes > 100) ...[
                    const SizedBox(width: 14),
                    Text('⚠ splits into 2 calls', style: _mono(10, _orange)),
                  ],
                ]),
              ],
            ),
          ),
          // Verb button(s) + cancel — `call` puts both destinations side by
          // side: Call AI (text handoff, blue) / Call sinain (voice, green).
          Padding(
            padding: const EdgeInsets.fromLTRB(10, 6, 10, 8),
            child: Row(children: [
              Expanded(
                child: _verbButton(_verb, _accent,
                    () => widget.onConfirm(_minutes, _selectedApps)),
              ),
              if (widget.kind == ChooserKind.call &&
                  widget.onConfirmAlt != null) ...[
                const SizedBox(width: 7),
                Expanded(
                  child: _verbButton('Call sinain', const Color(0xFF1F8039),
                      () => widget.onConfirmAlt!(_minutes, _selectedApps)),
                ),
              ],
              const SizedBox(width: 7),
              _cardButton(t, 'Cancel', widget.onClose),
            ]),
          ),
        ],
      ),
    );
  }

  Widget _sourceChip(HudTheme t, String src) {
    final off = _excluded.contains(src);
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: () => setState(() => off ? _excluded.remove(src) : _excluded.add(src)),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          decoration: BoxDecoration(
            color: off ? Colors.transparent : _accent.withValues(alpha: 0.16),
            border: Border.all(
                color: off
                    ? Colors.white.withValues(alpha: 0.14)
                    : _accent.withValues(alpha: 0.5)),
            borderRadius: BorderRadius.circular(6),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Text(off ? '○' : '✓', style: _mono(9, off ? t.textDim : _accent)),
            const SizedBox(width: 5),
            Text(src,
                style: _mono(10, off ? t.textDim : t.textPrimary,
                    weight: off ? FontWeight.w400 : FontWeight.w500)),
          ]),
        ),
      ),
    );
  }

  Widget _verbButton(String label, Color color, VoidCallback onTap) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          height: 28,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: color,
            borderRadius: BorderRadius.circular(6),
          ),
          child: Text(label,
              style: _mono(12, Colors.white, weight: FontWeight.w500)),
        ),
      ),
    );
  }
}

// ── Live call chip ("Call sinain") ──────────────────────────────────────────

class VoiceCallChip extends StatefulWidget {
  final VoiceSession session;
  final VoidCallback onEnd;
  final VoidCallback onDismiss;

  /// Mic mute toggle (webview engine). Null hides the button.
  final ValueChanged<bool>? onMute;

  /// "Save call" — promote the call's range (seed + elapsed) to memory via
  /// the normal save/undo lifecycle. Null hides the button.
  final ValueChanged<int>? onSaveCall;

  const VoiceCallChip({
    super.key,
    required this.session,
    required this.onEnd,
    required this.onDismiss,
    this.onMute,
    this.onSaveCall,
  });

  @override
  State<VoiceCallChip> createState() => _VoiceCallChipState();
}

class _VoiceCallChipState extends State<VoiceCallChip>
    with SingleTickerProviderStateMixin {
  late final AnimationController _wave = AnimationController(
      vsync: this, duration: const Duration(milliseconds: 900))
    ..repeat();
  DateTime? _liveSince;
  Timer? _ticker;
  bool _muted = false;

  @override
  void initState() {
    super.initState();
    _syncTimer();
  }

  @override
  void didUpdateWidget(VoiceCallChip old) {
    super.didUpdateWidget(old);
    if (old.session.status != widget.session.status) _syncTimer();
  }

  void _syncTimer() {
    if (widget.session.status == VoiceStatus.live &&
        widget.session.mode != VoiceMode.meet) {
      _liveSince ??= DateTime.now();
      _ticker ??= Timer.periodic(
          const Duration(seconds: 1), (_) => mounted ? setState(() {}) : null);
    } else {
      _ticker?.cancel();
      _ticker = null;
    }
  }

  @override
  void dispose() {
    _wave.dispose();
    _ticker?.cancel();
    super.dispose();
  }

  String get _elapsed {
    final s = DateTime.now().difference(_liveSince ?? DateTime.now()).inSeconds;
    return '${(s ~/ 60).toString().padLeft(2, '0')}:${(s % 60).toString().padLeft(2, '0')}';
  }

  Widget _chipButton(HudTheme t, String label, VoidCallback onTap,
      {bool active = false}) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          height: 24,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: active ? _blue.withValues(alpha: 0.22) : Colors.transparent,
            border: Border.all(
                color: active
                    ? _blue.withValues(alpha: 0.55)
                    : Colors.white.withValues(alpha: 0.18)),
            borderRadius: BorderRadius.circular(5),
          ),
          child: Text(label,
              style: _mono(11, active ? Colors.white : t.textMuted)),
        ),
      ),
    );
  }

  Widget _waveform() => AnimatedBuilder(
        animation: _wave,
        builder: (_, __) => Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            for (var i = 0; i < 4; i++) ...[
              Transform.scale(
                scaleY: 0.35 +
                    0.65 *
                        (0.5 +
                            0.5 *
                                math.sin((_wave.value * 2 * math.pi) -
                                    i * 0.9)),
                child: Container(
                  width: 3, height: 14,
                  decoration: BoxDecoration(
                    color: _blue,
                    borderRadius: BorderRadius.circular(1),
                  ),
                ),
              ),
              if (i < 3) const SizedBox(width: 2),
            ],
          ],
        ),
      );

  @override
  Widget build(BuildContext context) {
    final t = HudTheme.of(context);
    final s = widget.session;
    final live = s.status == VoiceStatus.live;
    final err = s.status == VoiceStatus.error;
    return Container(
      width: 300,
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: t.panelBg,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
            color: err
                ? _orange.withValues(alpha: 0.4)
                : _blue.withValues(alpha: 0.45)),
        boxShadow: t.shadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(children: [
            if (live && s.mode != VoiceMode.meet) _waveform(),
            if (!(live && s.mode != VoiceMode.meet))
              Container(
                width: 10, height: 10,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(color: err ? _orange : _blue, width: 2),
                ),
              ),
            const SizedBox(width: 9),
            Expanded(
              child: Text(
                switch (s.status) {
                  VoiceStatus.starting =>
                    'Calling sinain · ${s.minutes} min of context',
                  VoiceStatus.live => s.mode == VoiceMode.meet
                      ? 'Sinain is joining the call'
                      : 'In call with sinain',
                  VoiceStatus.ended => 'Call ended',
                  VoiceStatus.error => 'Call failed',
                },
                style: _mono(12, t.textPrimary, weight: FontWeight.w600),
              ),
            ),
            if (live && s.mode != VoiceMode.meet)
              Text(_elapsed, style: _mono(10, t.textMuted)),
            if (!live || s.mode == VoiceMode.meet) ...[
              const SizedBox(width: 8),
              MouseRegion(
                cursor: SystemMouseCursors.click,
                child: GestureDetector(
                    onTap: widget.onDismiss,
                    child: Text('✕', style: _mono(12, t.textDim))),
              ),
            ],
          ]),
          if (err)
            Padding(
              padding: const EdgeInsets.only(top: 7),
              child:
                  Text(s.error ?? 'unknown', style: _mono(11, _orange, height: 1.35)),
            ),
          if (s.message != null && !err)
            Padding(
              padding: const EdgeInsets.only(top: 7),
              child: Text(s.message!,
                  style: _mono(11, t.textMuted, height: 1.35)),
            ),
          if (s.coverage.isNotEmpty && s.status == VoiceStatus.starting)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(s.coverage, style: _mono(10, t.textDim)),
            ),
          if (live && s.mode != VoiceMode.meet) ...[
            const SizedBox(height: 9),
            Row(children: [
              if (widget.onMute != null) ...[
                _chipButton(t, _muted ? 'Unmute' : 'Mute', () {
                  setState(() => _muted = !_muted);
                  widget.onMute!(_muted);
                }, active: _muted),
                const SizedBox(width: 6),
              ],
              if (widget.onSaveCall != null)
                _chipButton(t, 'Save call', () {
                  final elapsed = DateTime.now()
                      .difference(_liveSince ?? DateTime.now())
                      .inMinutes;
                  widget.onSaveCall!(s.minutes + elapsed + 1);
                }),
              const Spacer(),
              MouseRegion(
                cursor: SystemMouseCursors.click,
                child: GestureDetector(
                  onTap: widget.onEnd,
                  child: Container(
                    height: 24,
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: _endRed,
                      borderRadius: BorderRadius.circular(5),
                    ),
                    child: Text('End',
                        style:
                            _mono(11, Colors.white, weight: FontWeight.w500)),
                  ),
                ),
              ),
            ]),
          ],
        ],
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

  /// Display name of the agent the selected destination hands off to
  /// (e.g. "Sinain Chat", "Claude Code") — we know where it will open.
  final String destLabel;

  const BriefCard({
    super.key,
    required this.brief,
    required this.onDismiss,
    required this.onSaveRange,
    required this.onAskFollowUp,
    this.dest = 'chat',
    this.onDestChanged,
    this.destLabel = '',
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
          // Metadata line: coverage left, chat/term destination right — kept
          // out of the action row, which stays two buttons wide.
          Padding(
            padding: const EdgeInsets.only(top: 3),
            child: Row(children: [
              Expanded(
                child: Text(brief.coverage,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: _mono(10, t.textDim)),
              ),
              if (onDestChanged != null && brief.status == CardStatus.ready)
                _destToggle(t),
            ]),
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
              Expanded(
                  child: _cardButton(
                      t,
                      destLabel.isNotEmpty
                          ? 'Handoff to $destLabel'
                          : (dest == 'term' ? 'Open terminal' : 'Ask follow-up'),
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

  /// Header title — "Build context" for clipboard, "Region context" for a
  /// selected screen region: one card experience, different selections.
  final String title;

  /// Handoff button label naming the destination agent
  /// (e.g. "Handoff to Sinain Chat").
  final String handoffLabel;

  const EnrichCardWidget({
    super.key,
    required this.card,
    required this.onDismiss,
    this.onCallAi,
    this.onCopy,
    this.title = 'Build context',
    this.handoffLabel = 'Call AI',
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
                child: Text(title,
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
            const _SectionHead('CONTEXT'),
            Text(card.context,
                style: _mono(11, t.textPrimary, height: 1.35)),
            const SizedBox(height: 12),
            Row(children: [
              if (onCallAi != null)
                Expanded(
                    child:
                        _cardButton(t, handoffLabel, onCallAi!, primary: true)),
              if (onCallAi != null && onCopy != null)
                const SizedBox(width: 7),
              if (onCopy != null) _cardButton(t, 'Copy for agent', onCopy!),
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
