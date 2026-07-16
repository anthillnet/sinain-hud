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

  /// Sources in a duration — each {name, kind, minutes} renders as one
  /// checkbox row so the user picks WHICH apps the gesture covers ("COVERS ·
  /// CLICK TO EXCLUDE", design v2 §3). Cached per duration.
  final Future<List<Map<String, dynamic>>?> Function(int minutes)? sourcesAt;

  /// Adjust-an-offer prefill (DESIGN-SAVE-OFFER §4): only these sources start
  /// ticked — everything else (incl. mic) begins excluded. Null = all ticked.
  final List<String>? preselectedApps;

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
    this.preselectedApps,
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
  // exclusion set survives duration changes while the card is open —
  // unticking Slack at 30 min keeps Slack unticked when the slider moves to
  // 60 — but never outlives the card: the next act starts from everything.
  final Map<int, List<Map<String, dynamic>>> _sourcesCache = {};
  final Set<String> _excluded = {};

  @override
  void initState() {
    super.initState();
    _fetchPreview(_minutes);
    _fetchSources(_minutes);
  }

  bool _preselectionApplied = false;

  void _fetchSources(int n) {
    if (widget.sourcesAt == null) return;
    if (_sourcesCache.containsKey(n)) return; // cached — no call
    widget.sourcesAt!(n).then((list) {
      if (!mounted || list == null) return;
      setState(() {
        _sourcesCache[n] = list;
        // Offer prefill: the first source list arriving seeds the exclusion
        // set — proposed apps ticked, everything else (incl. mic) unticked.
        final pre = widget.preselectedApps;
        if (pre != null && !_preselectionApplied) {
          _preselectionApplied = true;
          _excluded.addAll(list
              .map((s) => s['name'] as String? ?? '')
              .where((name) => name.isNotEmpty && !pre.contains(name)));
        }
      });
    });
  }

  List<String> _sourceNames(int n) =>
      (_sourcesCache[n] ?? const []).map((s) => s['name'] as String).toList();

  /// Selected sources for the confirmed duration — null when nothing was
  /// deselected (no scope: the range is used whole). With [preselectedApps]
  /// (adjusting an offer) the list is always explicit: re-ticking everything
  /// must not read as "no scope" — core would fall back to the proposal.
  List<String>? get _selectedApps {
    final names = _sourceNames(_minutes);
    if (names.isEmpty) return widget.preselectedApps;
    final picked = names.where((s) => !_excluded.contains(s)).toList();
    if (picked.length == names.length) {
      return widget.preselectedApps != null ? picked : null;
    }
    return picked;
  }

  /// Fraction of the range's sources still ticked — cost/latency estimates
  /// follow the selection (design: "Cost follows the selection").
  double get _selectedFrac {
    final names = _sourceNames(_minutes);
    if (names.isEmpty) return 1;
    final on = names.where((s) => !_excluded.contains(s)).length;
    return on / names.length;
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
        ChooserKind.save => 'Save context…',
        ChooserKind.call => 'Call AI on…',
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
  String get _latency =>
      '~${(0.75 + _minutes * 0.026 * (0.2 + 0.8 * _selectedFrac)).toStringAsFixed(1)}s';
  String get _cost =>
      '~\$${((0.004 + _minutes * 0.00075) * _selectedFrac).toStringAsFixed(2)}';

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
                width: 10,
                height: 10,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(color: _accent, width: 2),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                  child: Text(_title,
                      style:
                          _mono(12, t.textPrimary, weight: FontWeight.w600))),
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
                            style: _mono(10,
                                n == _minutes ? Colors.white : t.textMuted)),
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
                thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 7),
                overlayShape: const RoundSliderOverlayShape(overlayRadius: 12),
                tickMarkShape: SliderTickMarkShape.noTickMark,
              ),
              child: Slider(
                min: 5,
                max: 120,
                divisions: 23,
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
                if ((_sourcesCache[_minutes] ?? const []).isNotEmpty) ...[
                  // Source checklist (design v2 §3): every app the range
                  // covers is a checkbox — one click excludes it from THIS
                  // save/call only. What's unticked never reaches the LLM.
                  Row(children: [
                    Flexible(
                      child: Text('$_consentLabel · CLICK TO EXCLUDE',
                          overflow: TextOverflow.ellipsis,
                          style: _mono(9, t.textDim, weight: FontWeight.w600)),
                    ),
                    const SizedBox(width: 8),
                    const Spacer(),
                    Text(_sourceCount, style: _mono(9, t.textDim)),
                  ]),
                  const SizedBox(height: 4),
                  for (final src in _sourcesCache[_minutes]!)
                    _sourceRow(t, src),
                ] else ...[
                  Text(_consentLabel,
                      style: _mono(9, t.textDim, weight: FontWeight.w600)),
                  const SizedBox(height: 4),
                  Text(_coversText,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: _mono(11, t.textMuted, height: 1.35)),
                ],
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
                    Flexible(
                      child: Text('⚠ splits into 2 calls',
                          overflow: TextOverflow.ellipsis,
                          style: _mono(10, _orange)),
                    ),
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

  String get _sourceCount {
    final names = _sourceNames(_minutes);
    final on = names.where((s) => !_excluded.contains(s)).length;
    return '$on of ${names.length} sources';
  }

  Widget _sourceRow(HudTheme t, Map<String, dynamic> src) {
    final name = src['name'] as String;
    final mins = (src['minutes'] as num?)?.toInt() ?? 0;
    final off = _excluded.contains(name);
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () =>
            setState(() => off ? _excluded.remove(name) : _excluded.add(name)),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: Row(children: [
            Container(
              width: 12,
              height: 12,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: off ? Colors.transparent : _accent,
                border: Border.all(
                    color:
                        off ? Colors.white.withValues(alpha: 0.25) : _accent),
                borderRadius: BorderRadius.circular(3),
              ),
              child: off
                  ? null
                  : const Text('✓',
                      style: TextStyle(
                          fontSize: 8, height: 1, color: Colors.white)),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(name,
                  overflow: TextOverflow.ellipsis,
                  style: _mono(11, off ? t.textDim : const Color(0xFFD6DAE3))),
            ),
            if (mins > 0) Text('$mins min', style: _mono(9, t.textDim)),
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
                                math.sin(
                                    (_wave.value * 2 * math.pi) - i * 0.9)),
                child: Container(
                  width: 3,
                  height: 14,
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
                width: 10,
                height: 10,
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
              child: Text(s.error ?? 'unknown',
                  style: _mono(11, _orange, height: 1.35)),
            ),
          if (s.message != null && !err)
            Padding(
              padding: const EdgeInsets.only(top: 7),
              child:
                  Text(s.message!, style: _mono(11, t.textMuted, height: 1.35)),
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
  const _CardShell({required this.child, this.borderColor, this.width = 340});

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
    {bool primary = false, Color? accent}) {
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
          color: primary ? (accent ?? t.selectionAccent) : Colors.transparent,
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
      // Cap the card and scroll the brief body: a long timeline/problems
      // list otherwise grows past the window edge, clipping the bottom
      // sections AND the action buttons. Header + buttons stay pinned;
      // MediaQuery bounds are needed because the capture-cards Column lays
      // its children out with unbounded height.
      child: ConstrainedBox(
        constraints: BoxConstraints(
            maxHeight: MediaQuery.of(context).size.height * 0.72),
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
                    style: _mono(13, t.textPrimary, weight: FontWeight.w600)),
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
              Flexible(
                child: SingleChildScrollView(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
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
                                        style: _mono(11, t.textMuted,
                                            height: 1.3))),
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
                                    style: TextStyle(
                                        color: _orange, fontSize: 11)),
                                Expanded(
                                    child: Text(p,
                                        style: _mono(11, t.textMuted,
                                            height: 1.3))),
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
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 12),
              Row(children: [
                Expanded(
                    child: _cardButton(
                        t,
                        destLabel.isNotEmpty
                            ? 'Handoff to $destLabel'
                            : (dest == 'term'
                                ? 'Open terminal'
                                : 'Ask follow-up'),
                        onAskFollowUp,
                        primary: true)),
                const SizedBox(width: 7),
                _cardButton(t, 'Save this range', onSaveRange),
              ]),
            ],
          ],
        ),
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
    this.title = 'Context from clipboard',
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
              Text(
                  '${(card.latencyMs! / 1000).toStringAsFixed(2)}s · last 10 min',
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
            Text(card.context, style: _mono(11, t.textPrimary, height: 1.35)),
            const SizedBox(height: 12),
            Row(children: [
              if (onCallAi != null)
                Expanded(
                    child:
                        _cardButton(t, handoffLabel, onCallAi!, primary: true)),
              if (onCallAi != null && onCopy != null) const SizedBox(width: 7),
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
              if (r.cost != null) _chip(t, '\$${r.cost!.toStringAsFixed(2)}'),
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

// ── Save offer (DESIGN-SAVE-OFFER.md, wireframes: "Save Offer.dc.html") ─────
//
// Breakpoint nudge (arrival A — the card just appears): evidence and actions
// visible at once, zero extra gestures. Accept morphs into the shipped
// receipt; Adjust opens the chooser pre-filled; ✕ or a silent ~45 s fade
// dismisses. Every response is a training label.

/// The offer card: evidence-first claim (duration · sources · recency — every
/// token checkable), optional confident context line, verb-carrying actions.
/// No "Not now" button: the ✕ and the fade both mean it.
class SaveOfferCard extends StatelessWidget {
  final SaveOffer offer;
  final VoidCallback onAccept;
  final VoidCallback onAdjust;
  final VoidCallback onDismiss;

  const SaveOfferCard({
    super.key,
    required this.offer,
    required this.onAccept,
    required this.onAdjust,
    required this.onDismiss,
  });

  String get _recency {
    final idle = offer.idleTailMinutes;
    if (idle != null) return '$idle min idle at the end';
    final ago =
        (DateTime.now().millisecondsSinceEpoch - offer.endedTs) ~/ 60000;
    return ago < 2 ? 'ended just now' : 'ended $ago min ago';
  }

  @override
  Widget build(BuildContext context) {
    final t = HudTheme.of(context);
    // Honest idle tail: the duration turns amber when part of the range was
    // idle — the claim names it instead of hiding it.
    final durColor = offer.idleTailMinutes != null ? _amber : t.selectionAccent;
    return _CardShell(
      width: 300,
      borderColor: t.selectionAccent.withValues(alpha: 0.35),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(children: [
            Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(
                color: t.selectionAccent,
                shape: BoxShape.circle,
                boxShadow: [
                  BoxShadow(
                      color: t.selectionAccent.withValues(alpha: 0.3),
                      spreadRadius: 2),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Text('Save this session?',
                style: _mono(12, t.textPrimary, weight: FontWeight.w600)),
            const Spacer(),
            MouseRegion(
              cursor: SystemMouseCursors.click,
              child: GestureDetector(
                  onTap: onDismiss,
                  child: Text('✕', style: _mono(12, t.textDim))),
            ),
          ]),
          const SizedBox(height: 8),
          Text.rich(
            TextSpan(children: [
              TextSpan(
                  text: '${offer.minutes} min',
                  style: _mono(11, durColor, weight: FontWeight.w600)),
              TextSpan(
                  text: ' · ${offer.coverage} · $_recency',
                  style: _mono(11, t.textMuted)),
            ]),
          ),
          if (offer.threadLabel != null) ...[
            const SizedBox(height: 5),
            Text('mostly: ${offer.threadLabel}',
                style: _mono(10, t.textDim),
                maxLines: 1,
                overflow: TextOverflow.ellipsis),
          ],
          const SizedBox(height: 10),
          Row(children: [
            _cardButton(t, 'Save ${offer.minutes} min', onAccept,
                primary: true),
            const SizedBox(width: 6),
            _cardButton(t, 'Adjust…', onAdjust),
          ]),
        ],
      ),
    );
  }
}

// ── Session Sense (DESIGN-SESSION-SENSE.md, "Session Sense.dc.html") ────────
//
// The track accent (violet) marks everything session-scoped — distinct from
// Save green and Call blue, because tracking is a state, not an act.

const _track = Color(0xFF7A56D6);

String _clock(int ts) {
  final d = DateTime.fromMillisecondsSinceEpoch(ts);
  return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}

/// The credit-led nudge card (wireframes §1, chosen variant): claim ·
/// retroactive-credit sliver · Track · Wrong? · ✕. The backfill is visible
/// before the tap, and the verb states the span ("Track from 11:02").
class SessionNudgeCard extends StatefulWidget {
  final SessionNudge nudge;
  final VoidCallback onTrack;

  /// "Wrong?" pick: a corrected label, or "" for "Just work — no label".
  final ValueChanged<String> onCorrect;
  final VoidCallback onDismiss;

  const SessionNudgeCard({
    super.key,
    required this.nudge,
    required this.onTrack,
    required this.onCorrect,
    required this.onDismiss,
  });

  @override
  State<SessionNudgeCard> createState() => _SessionNudgeCardState();
}

class _SessionNudgeCardState extends State<SessionNudgeCard> {
  bool _wrongOpen = false;

  String get _header {
    final n = widget.nudge;
    // Bookmark return (§9): the promise is the user's own.
    if (n.resume) return 'Resume this session?';
    return switch (n.grade) {
      'personal' => 'Back on: ${n.label ?? ''}',
      'stock' => 'Looks like: ${n.label ?? ''}',
      // Medium confidence / category floor: a statement, never a hedge (§2).
      _ => 'Session in progress',
    };
  }

  @override
  Widget build(BuildContext context) {
    final t = HudTheme.of(context);
    final n = widget.nudge;
    final from = _clock(n.candidateStartTs);
    return _CardShell(
      width: 300,
      borderColor: _track.withValues(alpha: 0.35),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(children: [
            Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(
                color: _track,
                shape: BoxShape.circle,
                boxShadow: [
                  BoxShadow(
                      color: _track.withValues(alpha: 0.3), spreadRadius: 2),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(_header,
                  style: _mono(12, t.textPrimary, weight: FontWeight.w600),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis),
            ),
            MouseRegion(
              cursor: SystemMouseCursors.click,
              child: GestureDetector(
                  onTap: widget.onDismiss,
                  child: Text('✕', style: _mono(12, t.textDim))),
            ),
          ]),
          const SizedBox(height: 8),
          if (n.resume) ...[
            // The claim: ⚑ label + cumulative history — your promise, not
            // the classifier's guess.
            Text.rich(
              TextSpan(children: [
                TextSpan(text: '⚑ ', style: _mono(12, _track)),
                TextSpan(
                    text: n.label ?? 'session',
                    style: _mono(12, t.textPrimary, weight: FontWeight.w500)),
              ]),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            if (n.resumeMeta != null) ...[
              const SizedBox(height: 4),
              Text(n.resumeMeta!, style: _mono(10, t.textMuted)),
            ],
            const SizedBox(height: 10),
          ] else ...[
            // Evidence: elapsed + source chips — every token checkable.
            Row(children: [
              Text('${n.elapsedMinutes} min in', style: _mono(10, t.textMuted)),
              const SizedBox(width: 6),
              for (final app in n.apps.take(3)) ...[
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                  decoration: BoxDecoration(
                    border: Border.all(color: t.border),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(app,
                      style: _mono(10, t.textMuted),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis),
                ),
                const SizedBox(width: 4),
              ],
            ]),
            const SizedBox(height: 8),
            // The retroactive-credit sliver — the feature's whole magic,
            // visible before the tap. Not scrubbable (no thumb, no hover
            // cursor).
            _CreditSliver(from: from),
            const SizedBox(height: 10),
          ],
          // Help-forward variant A (§8): the nudge arrives with goal + next
          // steps already composed. Absent sections simply don't render —
          // the card degrades to the bare claim, never apologizes.
          if (n.goal.isNotEmpty || n.steps.isNotEmpty) ...[
            Container(height: 1, color: t.border),
            const SizedBox(height: 8),
            if (n.goal.isNotEmpty) ...[
              Text('GOAL · AS READ',
                  style: _mono(9, t.textDim, weight: FontWeight.w600)),
              const SizedBox(height: 3),
              Text(n.goal,
                  style: _mono(11, t.textPrimary, height: 1.35),
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis),
              const SizedBox(height: 7),
            ],
            if (n.steps.isNotEmpty) ...[
              Text('NEXT STEPS',
                  style: _mono(9, t.textDim, weight: FontWeight.w600)),
              const SizedBox(height: 3),
              for (final step in n.steps)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 2),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Padding(
                        padding: const EdgeInsets.only(top: 5),
                        child: Container(
                          width: 5,
                          height: 5,
                          decoration: BoxDecoration(
                            color: _track.withValues(alpha: 0.7),
                            shape: BoxShape.circle,
                          ),
                        ),
                      ),
                      const SizedBox(width: 7),
                      Expanded(
                          child: Text(step,
                              style: _mono(11, t.textPrimary, height: 1.35))),
                    ],
                  ),
                ),
              const SizedBox(height: 8),
            ],
          ],
          if (_wrongOpen) ...[
            Text('WHAT IS IT?', style: _mono(9, t.textDim, weight: FontWeight.w600)),
            const SizedBox(height: 5),
            for (final alt in widget.nudge.alternates)
              _altRow(t, alt, () => widget.onCorrect(alt)),
            _altRow(t, 'Just work — no label', () => widget.onCorrect('')),
            const SizedBox(height: 8),
          ],
          Row(children: [
            _cardButton(t, n.resume ? '▶ Resume' : 'Track from $from',
                widget.onTrack,
                primary: true, accent: _track),
            if (n.resume) ...[
              const SizedBox(width: 10),
              MouseRegion(
                cursor: SystemMouseCursors.click,
                child: GestureDetector(
                  onTap: widget.onDismiss,
                  child: Text('Not this', style: _mono(11, t.textDim)),
                ),
              ),
            ],
            const Spacer(),
            if (n.alternates.isNotEmpty && !_wrongOpen)
              MouseRegion(
                cursor: SystemMouseCursors.click,
                child: GestureDetector(
                  onTap: () => setState(() => _wrongOpen = true),
                  child: Text('Wrong?',
                      style: _mono(11, t.textDim).copyWith(
                        decoration: TextDecoration.underline,
                        decorationColor: t.textDim.withValues(alpha: 0.4),
                      )),
                ),
              ),
            if (_wrongOpen)
              MouseRegion(
                cursor: SystemMouseCursors.click,
                child: GestureDetector(
                  onTap: () => setState(() => _wrongOpen = false),
                  child: Text('Never mind', style: _mono(11, t.textDim)),
                ),
              ),
          ]),
        ],
      ),
    );
  }

  Widget _altRow(HudTheme t, String label, VoidCallback onTap) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Container(
          margin: const EdgeInsets.only(bottom: 4),
          padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
          decoration: BoxDecoration(
            color: t.textPrimary.withValues(alpha: 0.04),
            border: Border.all(color: t.border),
            borderRadius: BorderRadius.circular(7),
          ),
          child: Text(label, style: _mono(11, t.textPrimary)),
        ),
      ),
    );
  }
}

/// "11:02 — credited from here ▸ now": the span bar with the credit portion
/// filled in track violet.
class _CreditSliver extends StatelessWidget {
  final String from;
  const _CreditSliver({required this.from});

  @override
  Widget build(BuildContext context) {
    final t = HudTheme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          height: 10,
          child: LayoutBuilder(builder: (context, box) {
            final w = box.maxWidth;
            return Stack(children: [
              Positioned(
                left: 0,
                right: 0,
                top: 4,
                child: Container(height: 2, color: t.border),
              ),
              Positioned(
                left: w * 0.32,
                right: 0,
                top: 3,
                child: Container(
                  height: 4,
                  decoration: BoxDecoration(
                    color: _track.withValues(alpha: 0.8),
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              Positioned(
                left: w * 0.32,
                top: 0,
                child: Container(width: 2, height: 10, color: _track),
              ),
            ]);
          }),
        ),
        const SizedBox(height: 4),
        Row(children: [
          Text('$from — credited from here', style: _mono(9, HudTheme.of(context).textDim)),
          const Spacer(),
          Text('now', style: _mono(9, HudTheme.of(context).textMuted)),
        ]),
      ],
    );
  }
}

/// The symmetric "End workout?" prompt (§6): confirm teaches the boundary,
/// "Keep going" corrects a too-eager decay model, ignoring costs nothing —
/// the grace-period auto-wrap produces the same receipt.
class SessionWrapCard extends StatelessWidget {
  final SessionWrap wrap;
  final VoidCallback onWrapUp;

  /// "⚑ Later" (§9): Wrap up + a promise — same receipt, same undo; the
  /// thread gains a bookmark flag. Always an explicit act.
  final VoidCallback onLater;
  final VoidCallback onKeepGoing;
  final VoidCallback onDismiss;

  const SessionWrapCard({
    super.key,
    required this.wrap,
    required this.onWrapUp,
    required this.onLater,
    required this.onKeepGoing,
    required this.onDismiss,
  });

  @override
  Widget build(BuildContext context) {
    final t = HudTheme.of(context);
    return _CardShell(
      width: 300,
      borderColor: _track.withValues(alpha: 0.35),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(children: [
            Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(
                color: _track,
                shape: BoxShape.circle,
                boxShadow: [
                  BoxShadow(
                      color: _track.withValues(alpha: 0.3), spreadRadius: 2),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Text('Wrap up this session?',
                style: _mono(12, t.textPrimary, weight: FontWeight.w600)),
            const Spacer(),
            MouseRegion(
              cursor: SystemMouseCursors.click,
              child: GestureDetector(
                  onTap: onDismiss,
                  child: Text('✕', style: _mono(12, t.textDim))),
            ),
          ]),
          const SizedBox(height: 8),
          Text('${wrap.label} · ${wrap.activeMinutes} min',
              style: _mono(12, t.textPrimary, weight: FontWeight.w500),
              maxLines: 1,
              overflow: TextOverflow.ellipsis),
          const SizedBox(height: 4),
          Text(
              'quiet for ${wrap.quietMinutes} min · auto-wraps in ${wrap.graceMinutes}',
              style: _mono(10, t.textMuted)),
          const SizedBox(height: 10),
          Row(children: [
            _cardButton(t, 'Wrap up', onWrapUp, primary: true, accent: _track),
            const SizedBox(width: 6),
            _cardButton(t, '⚑ Later', onLater),
            const SizedBox(width: 10),
            MouseRegion(
              cursor: SystemMouseCursors.click,
              child: GestureDetector(
                  onTap: onKeepGoing,
                  child: Text('Keep going', style: _mono(11, t.textDim))),
            ),
          ]),
        ],
      ),
    );
  }
}

/// The running-session chip (§5 option A): label · elapsed · pause state.
/// Warmth decay pauses it automatically; return resumes. Tapping the body
/// ends the session early — a boundary correction the decay model learns
/// from. Elapsed ticks locally between chip broadcasts: it's the retroactive
/// credit growing in real time, not a stopwatch.
class SessionChip extends StatefulWidget {
  final SessionChipState session;
  final VoidCallback onEnd;

  /// "✦ next steps" (§8 C): present once the assist is composed — help
  /// offered on a label the user just confirmed. Null hides the affordance.
  final VoidCallback? onAssist;

  const SessionChip(
      {super.key, required this.session, required this.onEnd, this.onAssist});

  @override
  State<SessionChip> createState() => _SessionChipState();
}

class _SessionChipState extends State<SessionChip> {
  Timer? _ticker;
  late DateTime _receivedAt = DateTime.now();

  @override
  void initState() {
    super.initState();
    _syncTicker();
  }

  @override
  void didUpdateWidget(SessionChip old) {
    super.didUpdateWidget(old);
    if (old.session != widget.session) {
      _receivedAt = DateTime.now();
      _syncTicker();
    }
  }

  void _syncTicker() {
    _ticker?.cancel();
    if (!widget.session.paused) {
      _ticker = Timer.periodic(
          const Duration(seconds: 1), (_) => setState(() {}));
    }
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  String get _elapsed {
    var ms = widget.session.activeMs;
    if (!widget.session.paused) {
      ms += DateTime.now().difference(_receivedAt).inMilliseconds;
    }
    final s = ms ~/ 1000;
    final mm = s ~/ 60, ss = s % 60;
    return '$mm:${ss.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final t = HudTheme.of(context);
    final paused = widget.session.paused;
    final dot = paused ? _amber : _track;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onEnd,
        child: Container(
          padding: const EdgeInsets.fromLTRB(8, 6, 10, 6),
          decoration: BoxDecoration(
            color: t.panelBg,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(
                color: paused
                    ? _amber.withValues(alpha: 0.4)
                    : _track.withValues(alpha: 0.5)),
            boxShadow: t.shadow,
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(
                color: dot,
                shape: BoxShape.circle,
                boxShadow: [
                  BoxShadow(color: dot.withValues(alpha: 0.3), spreadRadius: 2),
                ],
              ),
            ),
            const SizedBox(width: 8),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 140),
              child: Text(widget.session.label,
                  style: _mono(11, t.textPrimary, weight: FontWeight.w500),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis),
            ),
            const SizedBox(width: 8),
            Text(_elapsed, style: _mono(10, paused ? _amber : t.textMuted)),
            if (paused) ...[
              const SizedBox(width: 6),
              Text('paused', style: _mono(9, _amber)),
            ],
            if (widget.onAssist != null) ...[
              const SizedBox(width: 8),
              Container(width: 1, height: 12, color: t.border),
              const SizedBox(width: 8),
              GestureDetector(
                onTap: widget.onAssist,
                child: Text('✦ next steps', style: _mono(10, _track)),
              ),
            ],
          ]),
        ),
      ),
    );
  }
}

/// Help-forward assist card (§8 variant C): goal + next steps, composed on
/// the tap — zero contract spent, help offered on a fact, not a guess.
class SessionAssistCard extends StatelessWidget {
  final SessionAssist assist;
  final VoidCallback onDismiss;

  const SessionAssistCard(
      {super.key, required this.assist, required this.onDismiss});

  @override
  Widget build(BuildContext context) {
    final t = HudTheme.of(context);
    return _CardShell(
      width: 300,
      borderColor: _track.withValues(alpha: 0.35),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(children: [
            Text('THIS SESSION · COMPOSED ON TAP',
                style: _mono(9, t.textDim, weight: FontWeight.w600)),
            const Spacer(),
            MouseRegion(
              cursor: SystemMouseCursors.click,
              child: GestureDetector(
                  onTap: onDismiss,
                  child: Text('✕', style: _mono(12, t.textDim))),
            ),
          ]),
          const SizedBox(height: 7),
          if (assist.goal.isNotEmpty) ...[
            Text(assist.goal,
                style: _mono(11, t.textPrimary, height: 1.35),
                maxLines: 3,
                overflow: TextOverflow.ellipsis),
            const SizedBox(height: 7),
          ],
          if (assist.steps.isNotEmpty) ...[
            Text('NEXT STEPS',
                style: _mono(9, t.textDim, weight: FontWeight.w600)),
            const SizedBox(height: 4),
            for (final step in assist.steps)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(top: 5),
                      child: Container(
                        width: 5,
                        height: 5,
                        decoration: BoxDecoration(
                          color: _track.withValues(alpha: 0.7),
                          shape: BoxShape.circle,
                        ),
                      ),
                    ),
                    const SizedBox(width: 7),
                    Expanded(
                      child: Text(step,
                          style: _mono(11, t.textPrimary, height: 1.35))),
                  ],
                ),
              ),
          ],
        ],
      ),
    );
  }
}

/// The bookmarked-sessions shelf (§9): ⚑ rows with cumulative history.
/// ▶ resumes (a fresh session on the same thread, immediately — no detection
/// wait); ↗ opens the session's KG view (the existing share mechanic lives
/// there); ✕ releases the promise.
class SessionShelfCard extends StatelessWidget {
  final List<SessionBookmark> bookmarks;
  final ValueChanged<SessionBookmark> onResume;
  final ValueChanged<SessionBookmark> onShare;
  final ValueChanged<SessionBookmark> onRemove;
  final VoidCallback onDismiss;

  const SessionShelfCard({
    super.key,
    required this.bookmarks,
    required this.onResume,
    required this.onShare,
    required this.onRemove,
    required this.onDismiss,
  });

  @override
  Widget build(BuildContext context) {
    final t = HudTheme.of(context);
    return _CardShell(
      width: 320,
      borderColor: _track.withValues(alpha: 0.35),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(children: [
            Text('Bookmarked sessions',
                style: _mono(12, t.textPrimary, weight: FontWeight.w600)),
            const Spacer(),
            Text('${bookmarks.length}', style: _mono(9, t.textDim)),
            const SizedBox(width: 10),
            MouseRegion(
              cursor: SystemMouseCursors.click,
              child: GestureDetector(
                  onTap: onDismiss,
                  child: Text('✕', style: _mono(12, t.textDim))),
            ),
          ]),
          const SizedBox(height: 6),
          if (bookmarks.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 10),
              child: Text('nothing flagged — "⚑ Later" on a wrap card lands here',
                  style: _mono(10, t.textDim)),
            ),
          for (final b in bookmarks)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(children: [
                Text('⚑ ', style: _mono(11, _track)),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(b.label,
                          style: _mono(11, t.textPrimary,
                              weight: FontWeight.w500),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis),
                      Text(b.meta, style: _mono(9, t.textDim)),
                    ],
                  ),
                ),
                _shelfAction(t, '▶', 'Resume', () => onResume(b),
                    accent: _track),
                const SizedBox(width: 5),
                _shelfAction(t, '↗', 'Share session', () => onShare(b)),
                const SizedBox(width: 5),
                _shelfAction(t, '✕', 'Release', () => onRemove(b)),
              ]),
            ),
        ],
      ),
    );
  }

  Widget _shelfAction(HudTheme t, String glyph, String tooltip,
      VoidCallback onTap, {Color? accent}) {
    return Tooltip(
      message: tooltip,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          onTap: onTap,
          child: Container(
            width: 22,
            height: 22,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(
                  color: accent?.withValues(alpha: 0.5) ?? t.border),
            ),
            child: Text(glyph, style: _mono(9, accent ?? t.textMuted)),
          ),
        ),
      ),
    );
  }
}
