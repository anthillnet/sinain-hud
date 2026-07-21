import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/services/feature_tour_service.dart';
import '../../core/services/settings_service.dart';
import '../../core/services/window_service.dart';

/// Post-install feature walkthrough — the "default journey" from the Claude
/// Design "Sinain Sessions Tab v2" blueprint, told as one day with Sinain:
/// Track a session → rooms change freely → agent lanes attach → approve from
/// the corner → step away → select-then-verb → save.
///
/// A short centered window: each scene is one visual, a line of copy, and a
/// single primary action. Every button drawn in a scene is live — the user
/// tries the journey's taps (Track, Allow, jump, ▶, enrich, Save) inside the
/// tour, with the first button of each scene highlighted until touched.
/// Gated by [FeatureTourService.needsTour]; mounted by `main.dart` after the
/// first-run wizard and provisioning, before the HUD.
///
/// The palette is the design's, not the HUD's brighter `0xFF00FF88` accent —
/// this is a distinct, self-contained surface meant to match the mockups.
class OnboardingTour extends StatefulWidget {
  const OnboardingTour({
    super.key,
    required this.service,
    required this.settings,
    required this.onComplete,
  });

  final FeatureTourService service;
  final SettingsService settings;
  final VoidCallback onComplete;

  @override
  State<OnboardingTour> createState() => _OnboardingTourState();
}

// ── Design palette (from Sinain Sessions Tab v2.dc.html) ─────────────────────
const _cardBg = Color(0xFF1E1F22);
const _visualDark = Color(0xFF171819);
const _visualDarker = Color(0xFF15161A);
const _panel = Color(0xFF2B2D30);
const _evidence = Color(0xFF232427);
const _green = Color(0xFF1F8039);
const _greenBright = Color(0xFF4CAF6E);
const _blue = Color(0xFF3369D6); // agent accent — agent-scoped liveness
const _red = Color(0xFFCC3645);
const _denyRed = Color(0xFFB3361C);
const _amber = Color(0xFFD9A21B); // waiting — the only state that wants a tap
const _amberText = Color(0xFFE8DCC0);
const _violet = Color(0xFF7A56D6); // tracking — the working session itself
const _saveMint = Color(0xFFCDE8D4);
const _textMuted = Color(0xFFA8ADBD);
const _textDim = Color(0xFF6C707E);
const _dotInactive = Color(0xFF3A3D42);
const _lightBg = Color(0xFFF7F8FA);
const _shimmer1 = Color(0xFFDFE1E5);
const _shimmer2 = Color(0xFFEBECF0);
const _hairline = Color(0x14FFFFFF); // rgba(255,255,255,.08)

// Knowledge web-UI "day theme" tokens — copied from the :root vars in
// sinain-core/src/server.ts so the memory scene renders the real browser UI,
// not a dark stand-in.
const _webBg = Color(0xFFFFFFFF);
const _webElev = Color(0xFFF8FAFC);
const _webFg = Color(0xFF0F172A);
const _webFgDim = Color(0xFF475569);
const _webFgFaint = Color(0xFF94A3B8);
const _webAccent = Color(0xFF2563EB);
const _webBorder = Color(0xFFE2E8F0);

class _Scene {
  const _Scene({
    required this.title,
    required this.body,
    required this.visual,
  });
  final String title;
  final String body;
  final Widget visual;
}

class _OnboardingTourState extends State<OnboardingTour> {
  static final bool _isMacOS = Platform.isMacOS;
  int _i = 0;
  late final List<_Scene> _scenes = _buildScenes();

  // Window drag — mirror the HUD (overlay_shell._onDragStart/Update). On macOS,
  // hand off to a native OS-level drag (smooth); only fall back to per-delta
  // moveWindowBy off-macOS, which is the laggy path.
  void _onDragStart(DragStartDetails _) {
    if (_isMacOS) context.read<WindowService>().beginNativeDrag();
  }

  void _onDragUpdate(DragUpdateDetails d) {
    if (_isMacOS) return; // native handles it
    context.read<WindowService>().moveWindowBy(d.delta.dx, -d.delta.dy);
  }

  @override
  void initState() {
    super.initState();
    // Size the window for the card (the card *is* the window, per the design).
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<WindowService>().setWindowFrame(120, 120, 460, 504);
    });
  }

  void _next() {
    if (_i >= _scenes.length - 1) {
      _finish();
    } else {
      setState(() => _i++);
    }
  }

  void _back() {
    if (_i > 0) setState(() => _i--);
  }

  Future<void> _finish() async {
    await widget.service.complete();
    widget.onComplete();
  }

  /// Derive the sinain-core http origin from the ws URL and open [path].
  /// Mirrors OverlayShell._openKnowledgeUI.
  Future<void> _openPath(String path) async {
    final ws = widget.settings.settings.wsUrl;
    final String origin;
    if (ws.startsWith('wss://')) {
      origin = 'https://${ws.substring(6)}';
    } else if (ws.startsWith('ws://')) {
      origin = 'http://${ws.substring(5)}';
    } else {
      origin = ws;
    }
    final uri = Uri.parse('$origin$path');
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scene = _scenes[_i];
    final isLast = _i == _scenes.length - 1;

    // Drag anywhere to move the frameless window (mirrors FirstRunWizard).
    return GestureDetector(
      behavior: HitTestBehavior.translucent,
      onPanStart: _onDragStart,
      onPanUpdate: _onDragUpdate,
      child: Center(
        // Scrollable so a transient too-small window constraint degrades to a
        // scroll instead of a RenderFlex overflow (the window is sized to fit).
        child: SingleChildScrollView(
          child: Container(
            width: 460,
            decoration: BoxDecoration(
              color: _cardBg,
              borderRadius: BorderRadius.circular(12),
              boxShadow: const [
                BoxShadow(
                    color: Color(0x2E001C36),
                    blurRadius: 24,
                    offset: Offset(0, 4)),
                BoxShadow(
                    color: Color(0x1A001C36),
                    blurRadius: 6,
                    offset: Offset(0, 2)),
              ],
            ),
            clipBehavior: Clip.antiAlias,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SizedBox(height: 200, child: scene.visual),
                Padding(
                  padding: const EdgeInsets.fromLTRB(28, 28, 28, 22),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        scene.title,
                        style: const TextStyle(
                          fontSize: 20,
                          height: 1.2,
                          fontWeight: FontWeight.w600,
                          color: Colors.white,
                        ),
                      ),
                      const SizedBox(height: 8),
                      ConstrainedBox(
                        constraints: const BoxConstraints(minHeight: 60),
                        child: Text(
                          scene.body,
                          style: const TextStyle(
                            fontSize: 14,
                            height: 1.43,
                            color: _textMuted,
                          ),
                        ),
                      ),
                      const SizedBox(height: 20),
                      _footer(isLast),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _footer(bool isLast) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        // Progress dots — scale down when the scene count + a wide primary
        // button ("Start using Sinain") would otherwise overflow the row.
        Flexible(
          child: FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Row(
              children: [
                for (var d = 0; d < _scenes.length; d++) ...[
                  if (d > 0) const SizedBox(width: 6),
                  AnimatedContainer(
                    duration: const Duration(milliseconds: 180),
                    width: d == _i ? 18 : 6,
                    height: 6,
                    decoration: BoxDecoration(
                      color: d == _i ? _green : _dotInactive,
                      borderRadius: BorderRadius.circular(3),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
        const SizedBox(width: 10),
        Row(
          children: [
            if (_i > 0)
              _TextButton(label: 'Back', onTap: _back, color: _textMuted),
            if (_i > 0) const SizedBox(width: 8),
            _PrimaryButton(
              label: isLast ? 'Start using Sinain' : 'Next',
              onTap: _next,
            ),
          ],
        ),
      ],
    );
  }

  // ── Scenes ─────────────────────────────────────────────────────────────────
  //
  // Ordered as the design's §4 "default journey": one session, five hours,
  // six taps — every button drawn in a scene is live.

  List<_Scene> _buildScenes() => [
        // 1 · Welcome
        const _Scene(
          title: 'Meet Sinain',
          body: 'Sinain sits at your notch and watches quietly — your work, '
              'your agents, your memory. Everything reads at a glance; '
              'nothing interrupts unless it truly needs you.',
          visual: _WelcomeVisual(),
        ),
        // 2 · Track (tap 1 of the journey — live)
        const _Scene(
          title: 'It notices when work starts',
          body: 'Focus for a few minutes and Sinain recognizes the thread. '
              'One nudge — Track — and a context card is born: goal, done, '
              'next. Nothing is tracked without your tap. Try it on the card.',
          visual: _TrackNudgeVisual(),
        ),
        // 3 · Rooms
        const _Scene(
          title: 'The session follows your work',
          body: 'Browser, documents, email, spreadsheets — to Sinain they’re '
              'rooms of one thread. Switch apps freely: the session and its '
              'card come along, and nothing ever re-asks.',
          visual: _RoomsVisual(),
        ),
        // 4 · Agent lanes
        const _Scene(
          title: 'Your agents ride along',
          body: 'Hand work to your AIs — Claude, ChatGPT, any of them — and '
              'each run attaches to your session as a lane, live progress '
              'included. Connected agents get your context injected '
              'automatically: zero taps.',
          visual: _LanesVisual(),
        ),
        // 5 · Approve from the corner (tap 2 — live)
        const _Scene(
          title: 'Approve from the corner',
          body: 'When an agent needs a go-ahead, the card comes to you — '
              'invisible to screen share. Allow once, Always to never be '
              'asked again, or Deny. Try all three.',
          visual: _ApprovalVisual(),
        ),
        // 6 · Away & back
        const _Scene(
          title: 'Step away — nothing stops',
          body: "Lunch, a call, hours away: your attention pauses, your "
              "agents don't. The island keeps the count honest, and coming "
              'back raises one card — what changed, what’s next.',
          visual: _AwayVisual(),
        ),
        // 7 · Select, then verb
        const _Scene(
          title: 'Select, then verb',
          body: 'Drag any region of your screen — or tap the eye to select '
              'the last minutes. The same row appears: ▶ send to a lane, '
              '📞 call, ⤓ save. The seed carries your context card, so '
              '“this” needs no explaining.',
          visual: _VerbRowVisual(),
        ),
        // 8 · Enrich chip
        const _Scene(
          title: 'Copy, paste smarter',
          body: '⌘C anything and a quiet chip slides out by the island: '
              'Enrich? One optional tap wraps the snippet with your '
              'session’s frame — which build, which step — so any AI gets '
              'the full picture.',
          visual: _EnrichChipVisual(),
        ),
        // 9 · Save (tap 3 — live)
        const _Scene(
          title: 'One tap saves the session',
          body: 'When the thread winds down Sinain offers a preview of '
              'exactly what’s kept — facts, decisions, agent runs. Save it, '
              'undo it, or walk away; nothing is saved without you. Try it.',
          visual: _SaveOfferVisual(),
        ),
        // 10 · Memory & knowledge browser
        _Scene(
          title: 'Sinain remembers',
          body: 'Everything Sinain learns becomes searchable memory — facts, '
              'people, decisions — across every session. Open the knowledge '
              'browser to explore or search it.',
          visual: _KnowledgeVisual(onOpen: () => _openPath('/knowledge/ui')),
        ),
        // 11 · Private by design
        const _Scene(
          title: 'Private by design',
          body: 'When you share your screen, others see only your apps — '
              'never Sinain or its cards. Screen and audio capture flip on '
              'or off from the controls, and nothing leaves your Mac '
              'without a gesture.',
          visual: _PrivacyVisual(),
        ),
        // 12 · You're set
        const _Scene(
          title: "You're all set",
          body: 'The eye is parked at your notch: glance for the counts, '
              'click for the stack. Sinain will nudge when your next '
              'session starts.',
          visual: _DoneVisual(),
        ),
      ];
}

// ── Shared building blocks ───────────────────────────────────────────────────

/// The Sinain eye: a stroked circle with a vertical lens. Scaled from the 30×30
/// viewBox used throughout the design.
class _EyeGlyph extends StatelessWidget {
  const _EyeGlyph({
    required this.size,
    this.strokeWidth = 3,
  });
  final double size;
  final double strokeWidth;

  @override
  Widget build(BuildContext context) => CustomPaint(
      size: Size.square(size), painter: _EyePainter(_green, strokeWidth));
}

class _EyePainter extends CustomPainter {
  _EyePainter(this.color, this.strokeWidth);
  final Color color;
  final double strokeWidth;

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.width / 30.0; // viewBox 30×30
    final c = Offset(15 * s, 15 * s);
    canvas.drawCircle(
      c,
      13.5 * s,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = strokeWidth * s
        ..color = color,
    );
    // Lens: M15 7.5 C 17.6 11.5,17.6 18.5,15 22.5 C 12.4 18.5,12.4 11.5,15 7.5 Z
    final p = Path()
      ..moveTo(15 * s, 7.5 * s)
      ..cubicTo(17.6 * s, 11.5 * s, 17.6 * s, 18.5 * s, 15 * s, 22.5 * s)
      ..cubicTo(12.4 * s, 18.5 * s, 12.4 * s, 11.5 * s, 15 * s, 7.5 * s)
      ..close();
    canvas.drawPath(p, Paint()..color = color);
  }

  @override
  bool shouldRepaint(_EyePainter old) =>
      old.color != color || old.strokeWidth != strokeWidth;
}

class _PrimaryButton extends StatelessWidget {
  const _PrimaryButton({required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => GestureDetector(
        onTap: onTap,
        child: Container(
          height: 32,
          padding: const EdgeInsets.symmetric(horizontal: 18),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: _green,
            borderRadius: BorderRadius.circular(4),
          ),
          child: Text(label,
              style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w500,
                  color: Colors.white)),
        ),
      );
}

class _TextButton extends StatelessWidget {
  const _TextButton(
      {required this.label, required this.onTap, required this.color});
  final String label;
  final VoidCallback onTap;
  final Color color;
  @override
  Widget build(BuildContext context) => GestureDetector(
        onTap: onTap,
        child: SizedBox(
          height: 32,
          child: Center(
            child: Text(label, style: TextStyle(fontSize: 14, color: color)),
          ),
        ),
      );
}

/// A faint "page behind the overlay" — grey shimmer lines on a light surface.
class _MockPage extends StatelessWidget {
  const _MockPage({this.opacity = 0.55});
  final double opacity;
  @override
  Widget build(BuildContext context) => Opacity(
        opacity: opacity,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 40, 20, 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(width: 150, height: 10, decoration: _bar(_shimmer1)),
              const SizedBox(height: 14),
              FractionallySizedBox(
                  widthFactor: 0.8,
                  child: Container(height: 8, decoration: _bar(_shimmer2))),
              const SizedBox(height: 9),
              FractionallySizedBox(
                  widthFactor: 0.66,
                  child: Container(height: 8, decoration: _bar(_shimmer2))),
            ],
          ),
        ),
      );
  static BoxDecoration _bar(Color c) =>
      BoxDecoration(color: c, borderRadius: BorderRadius.circular(3));
}

/// Looping opacity pulse — the design's `ssPulse` (waiting states, live dots).
class _Pulse extends StatefulWidget {
  const _Pulse({required this.child});
  final Widget child;
  @override
  State<_Pulse> createState() => _PulseState();
}

class _PulseState extends State<_Pulse> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
      vsync: this, duration: const Duration(milliseconds: 1000))
    ..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(
        opacity: Tween(begin: 1.0, end: 0.35)
            .animate(CurvedAnimation(parent: _c, curve: Curves.easeInOut)),
        child: widget.child,
      );
}

/// A working dot with an expanding, fading ring — the design's `ssHalo`.
class _HaloDot extends StatefulWidget {
  const _HaloDot({required this.color, this.size = 14, this.dotSize = 7});
  final Color color;
  final double size;
  final double dotSize;
  @override
  State<_HaloDot> createState() => _HaloDotState();
}

class _HaloDotState extends State<_HaloDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
      vsync: this, duration: const Duration(milliseconds: 2400))
    ..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SizedBox(
        width: widget.size,
        height: widget.size,
        child: AnimatedBuilder(
          animation: _c,
          builder: (_, __) {
            final t = _c.value;
            final scale = 0.6 + 1.6 * t;
            final opacity = t < 0.7 ? 0.5 * (1 - t / 0.7) : 0.0;
            return Stack(
              alignment: Alignment.center,
              children: [
                Transform.scale(
                  scale: scale,
                  child: Opacity(
                    opacity: opacity,
                    child: Container(
                      width: widget.size,
                      height: widget.size,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        border: Border.all(
                            color: widget.color.withValues(alpha: 0.5)),
                      ),
                    ),
                  ),
                ),
                Container(
                  width: widget.dotSize,
                  height: widget.dotSize,
                  decoration: BoxDecoration(
                      color: widget.color, shape: BoxShape.circle),
                ),
              ],
            );
          },
        ),
      );
}

Widget _plainDot(Color c, [double size = 7]) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(color: c, shape: BoxShape.circle));

Text _mono(String t,
        {double size = 9, Color color = _textMuted, FontWeight? weight}) =>
    Text(t,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
            fontSize: size,
            fontFamily: 'monospace',
            fontWeight: weight,
            color: color));

/// The collapsed notch island: the parked eye, a divider, then status content.
/// Rounded only at the bottom — it hangs from the notch.
class _IslandBar extends StatelessWidget {
  const _IslandBar({required this.children});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.fromLTRB(8, 5, 12, 5),
        decoration: const BoxDecoration(
          color: _cardBg,
          border: Border(
            left: BorderSide(color: Color(0x1AFFFFFF)),
            right: BorderSide(color: Color(0x1AFFFFFF)),
            bottom: BorderSide(color: Color(0x1AFFFFFF)),
          ),
          borderRadius: BorderRadius.vertical(bottom: Radius.circular(10)),
          boxShadow: [
            BoxShadow(
                color: Color(0x47001C36), blurRadius: 20, offset: Offset(0, 6)),
          ],
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const _EyeGlyph(size: 14, strokeWidth: 3),
            const SizedBox(width: 8),
            Container(width: 1, height: 10, color: const Color(0x1FFFFFFF)),
            const SizedBox(width: 8),
            ...children,
          ],
        ),
      );
}

/// "TRY IT" — a steady bright badge next to the live element so the
/// invitation is unmissable. Shown only until the scene is first touched.
class _TryIt extends StatelessWidget {
  const _TryIt();
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(
          color: _greenBright,
          borderRadius: BorderRadius.circular(12),
        ),
        child: const Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.touch_app, size: 12, color: Colors.white),
            SizedBox(width: 5),
            Text('TRY IT',
                style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 0.8,
                    color: Colors.white)),
          ],
        ),
      );
}

/// A pulsing glow behind a scene's first button — "this is the one to try".
/// Turns off (and stops animating) once the scene has been touched.
class _Highlight extends StatefulWidget {
  const _Highlight(
      {required this.child,
      this.on = true,
      this.color = _greenBright,
      this.radius = 6});
  final Widget child;
  final bool on;
  final Color color;
  final double radius;
  @override
  State<_Highlight> createState() => _HighlightState();
}

class _HighlightState extends State<_Highlight>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
      vsync: this, duration: const Duration(milliseconds: 900))
    ..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.on) return widget.child;
    return AnimatedBuilder(
      animation: _c,
      builder: (_, child) => Container(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(widget.radius),
          boxShadow: [
            BoxShadow(
              color:
                  widget.color.withValues(alpha: 0.25 + 0.35 * _c.value),
              blurRadius: 6 + 6 * _c.value,
              spreadRadius: 1 + 1.5 * _c.value,
            ),
          ],
        ),
        child: child,
      ),
      child: widget.child,
    );
  }
}

/// "replay" affordance for the live scenes, bottom-right of the visual.
class _Replay extends StatelessWidget {
  const _Replay(this.onTap);
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => GestureDetector(
        onTap: onTap,
        child: const Text('replay',
            style: TextStyle(
                fontSize: 10,
                color: _textDim,
                decoration: TextDecoration.underline,
                decorationColor: Color(0x33FFFFFF))),
      );
}

/// Card verbs — the design's three weights: filled commits an action,
/// outline is the secondary path, quiet is the ignorable one.
enum _VerbStyle { filled, outline, quiet }

class _CardVerb extends StatelessWidget {
  const _CardVerb(this.label, {this.style = _VerbStyle.outline, this.onTap});
  final String label;
  final _VerbStyle style;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final filled = style == _VerbStyle.filled;
    final quiet = style == _VerbStyle.quiet;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: 22,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: filled ? _green : Colors.transparent,
          border: quiet
              ? null
              : Border.all(
                  color: filled ? _green : const Color(0x2EFFFFFF)),
          borderRadius: BorderRadius.circular(5),
        ),
        child: Text(label,
            style: TextStyle(
              fontSize: 10,
              fontWeight: filled ? FontWeight.w600 : FontWeight.w400,
              color: filled
                  ? Colors.white
                  : quiet
                      ? _textDim
                      : _textMuted,
              decoration: quiet ? TextDecoration.underline : null,
              decorationColor: const Color(0x33FFFFFF),
            )),
      ),
    );
  }
}

/// Card close (✕) — always live: closing is the quiet way out everywhere.
class _CardClose extends StatelessWidget {
  const _CardClose(this.onTap);
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: const Padding(
          padding: EdgeInsets.all(2),
          child: Text('✕', style: TextStyle(fontSize: 10, color: _textDim)),
        ),
      );
}

// ── Scene visuals ────────────────────────────────────────────────────────────

class _WelcomeVisual extends StatelessWidget {
  const _WelcomeVisual();
  @override
  Widget build(BuildContext context) => Container(
        // Match the animation's baked-in background (#0d0d12) so the looping
        // WebP blends seamlessly into the scene area.
        color: const Color(0xFF0D0D12),
        alignment: Alignment.center,
        child: Image.asset(
          'assets/sinain_eye.webp',
          height: 200,
          fit: BoxFit.contain,
          gaplessPlayback: true,
        ),
      );
}

// ── 2 · Track (live) ─────────────────────────────────────────────────────────

enum _NudgeState { pending, tracked, declined }

/// The "Looks like…" nudge — the one ask Sinain ever initiates. Tapping Track
/// turns the guess into a context card (goal · done · next); "not now" (or ✕)
/// shows that declining is quiet and free.
class _TrackNudgeVisual extends StatefulWidget {
  const _TrackNudgeVisual();
  @override
  State<_TrackNudgeVisual> createState() => _TrackNudgeVisualState();
}

class _TrackNudgeVisualState extends State<_TrackNudgeVisual> {
  _NudgeState _s = _NudgeState.pending;

  @override
  Widget build(BuildContext context) => Container(
        color: _lightBg,
        child: Stack(
          children: [
            const Positioned.fill(child: _MockPage(opacity: 0.5)),
            // island — amber "looks like…" while pending, violet once tracked
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: Center(
                child: _IslandBar(children: [
                  if (_s == _NudgeState.pending) ...[
                    _Pulse(child: _plainDot(_amber, 6)),
                    const SizedBox(width: 6),
                    _mono('looks like…', color: _amberText, size: 10),
                  ] else if (_s == _NudgeState.tracked) ...[
                    _plainDot(_violet, 6),
                    const SizedBox(width: 6),
                    _mono('visa · tracking', size: 10),
                  ] else ...[
                    _plainDot(_textDim, 6),
                    const SizedBox(width: 6),
                    _mono('eye · quiet', color: _textDim, size: 10),
                  ],
                ]),
              ),
            ),
            Center(
              child: Padding(
                padding: const EdgeInsets.only(top: 24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (_s == _NudgeState.pending) ...[
                      const _TryIt(),
                      const SizedBox(height: 8),
                    ],
                    AnimatedSwitcher(
                      duration: const Duration(milliseconds: 250),
                      child: switch (_s) {
                        _NudgeState.pending => _nudgeCard(),
                        _NudgeState.tracked => _contextCard(),
                        _NudgeState.declined => _declinedNote(),
                      },
                    ),
                  ],
                ),
              ),
            ),
            if (_s != _NudgeState.pending)
              Positioned(
                right: 12,
                bottom: 8,
                child: _Replay(() => setState(() => _s = _NudgeState.pending)),
              ),
          ],
        ),
      );

  Widget _nudgeCard() => Container(
        key: const ValueKey('nudge'),
        width: 244,
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: _cardBg,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: _amber.withValues(alpha: 0.45)),
          boxShadow: const [
            BoxShadow(
                color: Color(0x40000000), blurRadius: 20, offset: Offset(0, 6)),
          ],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(children: [
              _Pulse(child: _plainDot(_amber, 6)),
              const SizedBox(width: 7),
              const Expanded(
                child: Text('Looks like: preparing a visa application',
                    style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        color: Colors.white)),
              ),
              _CardClose(() => setState(() => _s = _NudgeState.declined)),
            ]),
            const SizedBox(height: 7),
            _mono('engaged 12 min · chrome'),
            const SizedBox(height: 3),
            _mono('credit starts at 9:40', color: _textDim),
            const SizedBox(height: 9),
            Row(children: [
              _Highlight(
                radius: 5,
                child: _CardVerb('Track',
                    style: _VerbStyle.filled,
                    onTap: () => setState(() => _s = _NudgeState.tracked)),
              ),
              const SizedBox(width: 8),
              _CardVerb('not now',
                  style: _VerbStyle.quiet,
                  onTap: () => setState(() => _s = _NudgeState.declined)),
            ]),
          ],
        ),
      );

  Widget _contextCard() => Container(
        key: const ValueKey('card'),
        width: 250,
        padding: const EdgeInsets.fromLTRB(11, 9, 11, 9),
        decoration: const BoxDecoration(
          color: _evidence,
          border: Border(left: BorderSide(color: _violet, width: 2)),
          borderRadius: BorderRadius.only(
              topRight: Radius.circular(8), bottomRight: Radius.circular(8)),
          boxShadow: [
            BoxShadow(
                color: Color(0x40000000), blurRadius: 20, offset: Offset(0, 6)),
          ],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _cardRow('goal', 'submit the visa application', Colors.white),
            const SizedBox(height: 5),
            _cardRow('done', 'requirements researched', _textMuted),
            const SizedBox(height: 5),
            _cardRow('next', 'draft the cover letter', Colors.white),
          ],
        ),
      );

  Widget _cardRow(String k, String v, Color vColor) => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 32, child: _mono(k, color: _textDim)),
          Expanded(
            child: Text(v,
                style: TextStyle(fontSize: 11, height: 1.25, color: vColor)),
          ),
        ],
      );

  Widget _declinedNote() => Container(
        key: const ValueKey('declined'),
        width: 244,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: _cardBg,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: _hairline),
        ),
        child: const Text(
          'Sinain goes quiet — no timer, no guilt. The day still ends with a '
          'save offer, and launching an agent re-seeds the same nudge.',
          style: TextStyle(fontSize: 11, height: 1.35, color: _textMuted),
        ),
      );
}

// ── 3 · Rooms ────────────────────────────────────────────────────────────────

/// One violet thread through four rooms — the active room cycles to show the
/// session following the work while the card stays constant.
class _RoomsVisual extends StatefulWidget {
  const _RoomsVisual();
  @override
  State<_RoomsVisual> createState() => _RoomsVisualState();
}

class _RoomsVisualState extends State<_RoomsVisual> {
  static const _rooms = [
    (Icons.language, 'Chrome'),
    (Icons.description_outlined, 'Docs'),
    (Icons.mail_outline, 'Mail'),
    (Icons.table_chart_outlined, 'Sheets'),
  ];
  int _active = 0;
  Timer? _t;

  @override
  void initState() {
    super.initState();
    _t = Timer.periodic(const Duration(milliseconds: 1400), (_) {
      if (mounted) setState(() => _active = (_active + 1) % _rooms.length);
    });
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Container(
        color: _visualDark,
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              // the session pill — never changes as rooms do
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(10),
                  border:
                      Border.all(color: _violet.withValues(alpha: 0.55)),
                ),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  _plainDot(_violet, 6),
                  const SizedBox(width: 6),
                  _mono('visa application · 2h 14m', size: 10),
                ]),
              ),
              const SizedBox(height: 18),
              SizedBox(
                width: 360,
                child: Stack(
                  alignment: Alignment.center,
                  children: [
                    // the thread
                    Container(
                        height: 2,
                        margin: const EdgeInsets.symmetric(horizontal: 30),
                        color: _violet.withValues(alpha: 0.35)),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                      children: [
                        for (var i = 0; i < _rooms.length; i++)
                          _room(_rooms[i].$1, _rooms[i].$2, i == _active),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              _mono('rooms change · the session doesn’t',
                  color: _textDim, size: 10),
            ],
          ),
        ),
      );

  Widget _room(IconData icon, String label, bool active) => AnimatedContainer(
        duration: const Duration(milliseconds: 300),
        width: 66,
        padding: const EdgeInsets.symmetric(vertical: 8),
        decoration: BoxDecoration(
          color: active ? _panel : _visualDarker,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(
              color: active ? _violet : const Color(0x1FFFFFFF)),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 16, color: active ? Colors.white : _textDim),
            const SizedBox(height: 4),
            Text(label,
                style: TextStyle(
                    fontSize: 9,
                    color: active ? Colors.white : _textDim)),
          ],
        ),
      );
}

// ── 4 · Agent lanes ──────────────────────────────────────────────────────────

/// The sessions-tab anatomy: a working-session group row wrapping agent lanes
/// with live tool lines (design §1).
class _LanesVisual extends StatelessWidget {
  const _LanesVisual();
  @override
  Widget build(BuildContext context) => Container(
        color: _visualDark,
        child: Center(
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: SizedBox(
              width: 300,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // group row — the working session wraps its agents
                  Row(children: [
                    _plainDot(_violet, 6),
                    const SizedBox(width: 7),
                    const Text('visa application',
                        style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                            color: Colors.white)),
                    const SizedBox(width: 7),
                    _mono('2 agents', color: _textDim),
                    const SizedBox(width: 8),
                    Expanded(
                        child: Container(height: 1, color: _hairline)),
                    const SizedBox(width: 8),
                    _mono('2h 14m', color: _textDim),
                  ]),
                  const SizedBox(height: 7),
                  _lane(
                    name: 'claude — paperwork',
                    tool: 'Draft · cover letter for the consulate',
                    chips: const ['claude', 'Docs'],
                    elapsed: '14m',
                  ),
                  const SizedBox(height: 6),
                  _lane(
                    name: 'chatgpt — research',
                    tool: 'Reading · embassy checklist & fees',
                    chips: const ['chatgpt', 'Chrome'],
                    elapsed: '26m',
                  ),
                  const SizedBox(height: 7),
                  Row(children: [
                    const Icon(Icons.bolt, size: 11, color: _blue),
                    const SizedBox(width: 5),
                    _mono('hooked: context injected · goal · done · next',
                        color: _textDim),
                  ]),
                ],
              ),
            ),
          ),
        ),
      );

  Widget _lane({
    required String name,
    required String tool,
    required List<String> chips,
    required String elapsed,
  }) =>
      Container(
        margin: const EdgeInsets.only(left: 13),
        padding: const EdgeInsets.fromLTRB(9, 8, 9, 8),
        decoration: BoxDecoration(
          color: _evidence,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: const Color(0x14FFFFFF)),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(children: [
              const _HaloDot(color: _blue, size: 12, dotSize: 6),
              const SizedBox(width: 7),
              Expanded(
                child: Text(name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        color: Colors.white)),
              ),
              _mono('working', color: _blue),
            ]),
            const SizedBox(height: 5),
            Padding(
              padding: const EdgeInsets.only(left: 19),
              child: _mono(tool),
            ),
            const SizedBox(height: 5),
            Padding(
              padding: const EdgeInsets.only(left: 19),
              child: Row(children: [
                for (final c in chips) ...[
                  Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 5, vertical: 1),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(4),
                      border: Border.all(color: const Color(0x1FFFFFFF)),
                    ),
                    child: Text(c,
                        style: const TextStyle(
                            fontSize: 8.5, color: _textMuted)),
                  ),
                  const SizedBox(width: 5),
                ],
                const Spacer(),
                _mono(elapsed, color: _textDim, size: 8.5),
              ]),
            ),
          ],
        ),
      );
}

// ── 5 · Approve from the corner (live) ───────────────────────────────────────

enum _ApprovalState { pending, allowed, always, denied, dismissed }

/// The design's §0 moment, interactive: a PermissionRequest raises the card in
/// the corner; Allow / Always / Deny resolve it, ✕ just closes it (the lane
/// keeps waiting in the stack), and the island count follows.
class _ApprovalVisual extends StatefulWidget {
  const _ApprovalVisual();
  @override
  State<_ApprovalVisual> createState() => _ApprovalVisualState();
}

class _ApprovalVisualState extends State<_ApprovalVisual> {
  _ApprovalState _s = _ApprovalState.pending;

  bool get _pending => _s == _ApprovalState.pending;
  bool get _stillWaiting => _pending || _s == _ApprovalState.dismissed;

  @override
  Widget build(BuildContext context) => Container(
        color: _lightBg,
        child: Stack(
          children: [
            const Positioned.fill(child: _MockPage(opacity: 0.5)),
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: Center(
                child: _IslandBar(children: [
                  _plainDot(_blue, 6),
                  const SizedBox(width: 6),
                  _mono(
                      _s == _ApprovalState.allowed ||
                              _s == _ApprovalState.always
                          ? '4 working'
                          : '3 working',
                      size: 10),
                  if (_stillWaiting) ...[
                    const SizedBox(width: 6),
                    _plainDot(_textDim, 2),
                    const SizedBox(width: 6),
                    _Pulse(
                        child: _mono('1 waiting',
                            color: _amberText, size: 10)),
                  ],
                ]),
              ),
            ),
            if (_pending)
              const Positioned(
                top: 34,
                left: 0,
                right: 0,
                child: Center(child: _TryIt()),
              ),
            Positioned(
              right: 10,
              bottom: 8,
              child: AnimatedSwitcher(
                duration: const Duration(milliseconds: 250),
                child: _pending ? _askCard() : _receipt(),
              ),
            ),
          ],
        ),
      );

  Widget _askCard() => Container(
        key: const ValueKey('ask'),
        width: 252,
        padding: const EdgeInsets.all(7),
        decoration: BoxDecoration(
          color: _cardBg,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: const Color(0x1AFFFFFF)),
          boxShadow: const [
            BoxShadow(
                color: Color(0x4D001C36), blurRadius: 32, offset: Offset(0, 8)),
          ],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 2, 4, 6),
              child: Row(children: [
                Container(
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(
                    color: _amber,
                    shape: BoxShape.circle,
                    boxShadow: [
                      BoxShadow(
                          color: _amber.withValues(alpha: 0.15),
                          spreadRadius: 3),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                const Expanded(
                  child: Text('Claude wants to send an email',
                      style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                          color: Colors.white)),
                ),
                _CardClose(
                    () => setState(() => _s = _ApprovalState.dismissed)),
              ]),
            ),
            // evidence panel — the raw command, glanceable, never required
            Container(
              padding: const EdgeInsets.fromLTRB(9, 7, 9, 7),
              decoration: BoxDecoration(
                color: _evidence,
                borderRadius: BorderRadius.circular(7),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  _mono('To: consulate visa desk — “Appointment request”',
                      size: 10, color: const Color(0xFFE8EAEE)),
                  const SizedBox(height: 6),
                  Row(children: [
                    _mono('paperwork · 14m in', size: 8.5),
                    const SizedBox(width: 6),
                    _metaChip('claude'),
                    const SizedBox(width: 4),
                    _metaChip('Mail'),
                  ]),
                ],
              ),
            ),
            const SizedBox(height: 7),
            Row(children: [
              _Highlight(
                radius: 5,
                child: _CardVerb('Allow',
                    style: _VerbStyle.filled,
                    onTap: () =>
                        setState(() => _s = _ApprovalState.allowed)),
              ),
              const SizedBox(width: 6),
              _CardVerb('Always',
                  onTap: () => setState(() => _s = _ApprovalState.always)),
              const Spacer(),
              _CardVerb('Deny',
                  style: _VerbStyle.quiet,
                  onTap: () => setState(() => _s = _ApprovalState.denied)),
            ]),
          ],
        ),
      );

  Widget _metaChip(String t) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(4),
          border: Border.all(color: const Color(0x1FFFFFFF)),
        ),
        child: Text(t,
            style: const TextStyle(fontSize: 8.5, color: _textMuted)),
      );

  Widget _receipt() {
    final (label, dot) = switch (_s) {
      _ApprovalState.allowed => ('Allowed — lane resumes', _green),
      _ApprovalState.always => ('Always — this ask now costs 0 taps', _green),
      _ApprovalState.denied => ('Denied — lane holds', _denyRed),
      _ApprovalState.dismissed => (
          'Closed — claude still waiting in the stack',
          _amber
        ),
      _ApprovalState.pending => ('', _green),
    };
    return Container(
      key: const ValueKey('receipt'),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: _cardBg,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: const Color(0x1AFFFFFF)),
        boxShadow: const [
          BoxShadow(
              color: Color(0x47001C36), blurRadius: 20, offset: Offset(0, 6)),
        ],
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _plainDot(dot, 7),
          const SizedBox(width: 7),
          Text(label,
              style: const TextStyle(fontSize: 10.5, color: Colors.white)),
          const SizedBox(width: 8),
          _mono('send email', size: 9, color: _textDim),
          const SizedBox(width: 8),
          _Replay(() => setState(() => _s = _ApprovalState.pending)),
        ],
      ),
    );
  }
}

// ── 6 · Away & back (live) ───────────────────────────────────────────────────

enum _AwayState { card, jumped, calling, dismissed }

/// Paused attention over live agents, and the single re-entry card the return
/// raises — its verbs are the real ones: ⏵ jump, 📞 call, ok.
class _AwayVisual extends StatefulWidget {
  const _AwayVisual();
  @override
  State<_AwayVisual> createState() => _AwayVisualState();
}

class _AwayVisualState extends State<_AwayVisual> {
  _AwayState _s = _AwayState.card;

  @override
  Widget build(BuildContext context) => Container(
        color: _lightBg,
        child: Stack(
          children: [
            const Positioned.fill(child: _MockPage(opacity: 0.5)),
            // the away dim
            const Positioned.fill(
                child: ColoredBox(color: Color(0x3D1E1F22))),
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: Center(
                child: _IslandBar(children: [
                  _plainDot(_textDim, 6),
                  const SizedBox(width: 6),
                  _mono('paused · 2 working', size: 10),
                ]),
              ),
            ),
            Center(
              child: Padding(
                padding: const EdgeInsets.only(top: 24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (_s == _AwayState.card) ...[
                      const _TryIt(),
                      const SizedBox(height: 8),
                    ],
                    AnimatedSwitcher(
                      duration: const Duration(milliseconds: 250),
                      child: switch (_s) {
                        _AwayState.card => _returnCard(),
                        _AwayState.jumped => _resultPill(
                            'jumped',
                            _blue,
                            '⏵ claude — paperwork · straight to the chat'),
                        _AwayState.calling => _resultPill(
                            'calling',
                            _greenBright,
                            '📞 “where were we?” — the digest, spoken'),
                        _AwayState.dismissed => _dismissedNote(),
                      },
                    ),
                  ],
                ),
              ),
            ),
            if (_s != _AwayState.card)
              Positioned(
                right: 12,
                bottom: 8,
                child: _Replay(() => setState(() => _s = _AwayState.card)),
              ),
          ],
        ),
      );

  Widget _returnCard() => Container(
        key: const ValueKey('return'),
        width: 250,
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: _cardBg,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: _violet.withValues(alpha: 0.45)),
          boxShadow: const [
            BoxShadow(
                color: Color(0x40000000), blurRadius: 20, offset: Offset(0, 6)),
          ],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(children: [
              _plainDot(_violet, 6),
              const SizedBox(width: 7),
              const Expanded(
                child: Text('While you were away — 40m',
                    style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        color: Colors.white)),
              ),
              _CardClose(() => setState(() => _s = _AwayState.dismissed)),
            ]),
            const SizedBox(height: 7),
            _mono('claude ✓ drafted the cover letter', color: _saveMint),
            const SizedBox(height: 3),
            _mono('research still reading · next: book appointment'),
            const SizedBox(height: 9),
            Row(children: [
              _Highlight(
                radius: 5,
                child: _CardVerb('⏵ jump',
                    onTap: () => setState(() => _s = _AwayState.jumped)),
              ),
              const SizedBox(width: 6),
              _CardVerb('📞 call',
                  onTap: () => setState(() => _s = _AwayState.calling)),
              const Spacer(),
              _CardVerb('ok',
                  style: _VerbStyle.quiet,
                  onTap: () => setState(() => _s = _AwayState.dismissed)),
            ]),
          ],
        ),
      );

  Widget _resultPill(String key, Color dot, String text) => Container(
        key: ValueKey(key),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
        decoration: BoxDecoration(
          color: _cardBg,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: const Color(0x1AFFFFFF)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            _plainDot(dot, 7),
            const SizedBox(width: 7),
            Text(text,
                style: const TextStyle(fontSize: 10.5, color: Colors.white)),
          ],
        ),
      );

  Widget _dismissedNote() => Container(
        key: const ValueKey('dismissed'),
        width: 250,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: _cardBg,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: _hairline),
        ),
        child: const Text(
          'Also fine — the card never stacks up. The island keeps the counts '
          'honest until you look again.',
          style: TextStyle(fontSize: 11, height: 1.35, color: _textMuted),
        ),
      );
}

// ── 7 · Select, then verb (live) ─────────────────────────────────────────────

enum _VerbResult { none, sent, call, saved }

/// The unified verb row on a region selection: ▶ [lane] ▾ · 📞 · ⤓ — drag
/// selects space, the eye selects time, both get the same row (design §3).
/// ▶ wears the selected lane's name; ▾ switches it inline.
class _VerbRowVisual extends StatefulWidget {
  const _VerbRowVisual();
  @override
  State<_VerbRowVisual> createState() => _VerbRowVisualState();
}

class _VerbRowVisualState extends State<_VerbRowVisual> {
  static const _lanes = ['claude — paperwork', 'chatgpt', 'Sinain chat'];
  int _lane = 0;
  _VerbResult _r = _VerbResult.none;

  @override
  Widget build(BuildContext context) => Container(
        color: _lightBg,
        child: Stack(
          children: [
            const Positioned.fill(child: _MockPage(opacity: 0.5)),
            const Positioned.fill(child: ColoredBox(color: Color(0x4D1E1F22))),
            if (_r == _VerbResult.none)
              const Positioned(
                top: 12,
                left: 0,
                right: 0,
                child: Center(child: _TryIt()),
              ),
            // selection box
            Positioned(
              left: 70,
              top: 46,
              child: SizedBox(
                width: 240,
                height: 100,
                child: Stack(
                  clipBehavior: Clip.none,
                  children: [
                    Container(
                      decoration: BoxDecoration(
                        color: const Color(0x0F3369D6),
                        border: Border.all(color: _blue, width: 1.5),
                      ),
                    ),
                    Positioned(
                      left: 0,
                      top: -22,
                      child: Container(
                        height: 17,
                        padding: const EdgeInsets.symmetric(horizontal: 6),
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                            color: const Color(0xFF27282E),
                            borderRadius: BorderRadius.circular(3)),
                        child: const Text('240 × 100',
                            style: TextStyle(
                                fontSize: 10,
                                color: Colors.white,
                                fontFamily: 'monospace')),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            // the verb row — release the drag, the row is already there.
            // A sibling of the selection box (not a child positioned outside
            // its bounds): out-of-bounds Stack children paint but never
            // hit-test, which made these buttons dead.
            Positioned(
              left: 70,
              top: 154,
              child: AnimatedSwitcher(
                duration: const Duration(milliseconds: 250),
                child: _r == _VerbResult.none ? _verbRow() : _resultRow(),
              ),
            ),
            // gesture hint, top-right
            Positioned(
              right: 14,
              top: 14,
              child: Container(
                height: 24,
                padding: const EdgeInsets.symmetric(horizontal: 9),
                decoration: BoxDecoration(
                    color: const Color(0xEB2B2D30),
                    borderRadius: BorderRadius.circular(12)),
                child: const Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _EyeGlyph(size: 13, strokeWidth: 3),
                    SizedBox(width: 7),
                    Text('Drag a box — or tap the eye',
                        style: TextStyle(fontSize: 11, color: Colors.white)),
                  ],
                ),
              ),
            ),
          ],
        ),
      );

  Widget _verbRow() => Row(
        key: const ValueKey('verbs'),
        children: [
          // ▶ wears the selected lane's name; ▾ switches it inline
          _Highlight(
            child: Container(
              height: 24,
              decoration: BoxDecoration(
                color: _cardBg,
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: const Color(0x24FFFFFF)),
              ),
              clipBehavior: Clip.antiAlias,
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                GestureDetector(
                  onTap: () => setState(() => _r = _VerbResult.sent),
                  child: Container(
                    color: _green,
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    alignment: Alignment.center,
                    child: const Text('▶',
                        style:
                            TextStyle(fontSize: 10, color: Colors.white)),
                  ),
                ),
                GestureDetector(
                  onTap: () => setState(() => _r = _VerbResult.sent),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    child: _mono(_lanes[_lane],
                        size: 10, color: const Color(0xFFE8EAEE)),
                  ),
                ),
                GestureDetector(
                  onTap: () => setState(
                      () => _lane = (_lane + 1) % _lanes.length),
                  behavior: HitTestBehavior.opaque,
                  child: Container(
                    height: 24,
                    padding: const EdgeInsets.symmetric(horizontal: 6),
                    decoration: const BoxDecoration(
                      border: Border(
                          left: BorderSide(color: Color(0x24FFFFFF))),
                    ),
                    alignment: Alignment.center,
                    child: const Text('▾',
                        style: TextStyle(fontSize: 9, color: _textDim)),
                  ),
                ),
              ]),
            ),
          ),
          const SizedBox(width: 6),
          _pill('📞', () => setState(() => _r = _VerbResult.call)),
          const SizedBox(width: 6),
          _pill('⤓', () => setState(() => _r = _VerbResult.saved)),
        ],
      );

  Widget _resultRow() {
    final (dot, text) = switch (_r) {
      _VerbResult.sent => (
          _greenBright,
          'seed → ${_lanes[_lane]} · region + card'
        ),
      _VerbResult.call => (_greenBright, 'call open · agent sees this region'),
      _VerbResult.saved => (_greenBright, 'saved · receipt in memory · undo'),
      _VerbResult.none => (_greenBright, ''),
    };
    return Container(
      key: const ValueKey('result'),
      height: 24,
      padding: const EdgeInsets.symmetric(horizontal: 9),
      decoration: BoxDecoration(
        color: _cardBg,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: const Color(0x24FFFFFF)),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        _plainDot(dot, 6),
        const SizedBox(width: 6),
        _mono(text, size: 9.5, color: const Color(0xFFE8EAEE)),
        const SizedBox(width: 8),
        _Replay(() => setState(() => _r = _VerbResult.none)),
      ]),
    );
  }

  Widget _pill(String t, VoidCallback onTap) => GestureDetector(
        onTap: onTap,
        child: Container(
          height: 24,
          padding: const EdgeInsets.symmetric(horizontal: 8),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: _cardBg,
            borderRadius: BorderRadius.circular(6),
            border: Border.all(color: const Color(0x24FFFFFF)),
          ),
          child: Text(t,
              style: const TextStyle(fontSize: 10, color: _textMuted)),
        ),
      );
}

// ── 8 · Enrich chip (live) ───────────────────────────────────────────────────

/// A ⌘C mid-session: the quiet "enrich?" chip rides the island's edge — one
/// message point, never at the cursor. Tap it and the clipboard gains the
/// session's frame; ignored, it melts.
class _EnrichChipVisual extends StatefulWidget {
  const _EnrichChipVisual();
  @override
  State<_EnrichChipVisual> createState() => _EnrichChipVisualState();
}

class _EnrichChipVisualState extends State<_EnrichChipVisual> {
  bool _enriched = false;

  @override
  Widget build(BuildContext context) => Container(
        color: _lightBg,
        child: Stack(
          children: [
            const Positioned.fill(child: _MockPage(opacity: 0.5)),
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: Center(
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _IslandBar(children: [
                      _plainDot(_blue, 6),
                      const SizedBox(width: 6),
                      _mono('2 working', size: 10),
                    ]),
                    const SizedBox(width: 4),
                    // the chip — slides out from the island's edge
                    _Highlight(
                      on: !_enriched,
                      radius: 7,
                      child: GestureDetector(
                        onTap: () => setState(() => _enriched = true),
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 8, vertical: 4),
                          decoration: const BoxDecoration(
                            color: _cardBg,
                            border: Border(
                              left: BorderSide(color: Color(0x24FFFFFF)),
                              right: BorderSide(color: Color(0x24FFFFFF)),
                              bottom: BorderSide(color: Color(0x24FFFFFF)),
                            ),
                            borderRadius: BorderRadius.vertical(
                                bottom: Radius.circular(7)),
                          ),
                          child: _enriched
                              ? _mono('enriched ✓',
                                  color: _saveMint, size: 9.5)
                              : _Pulse(
                                  child: _mono('enrich? · visa',
                                      color: _saveMint, size: 9.5)),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            Center(
              child: Padding(
                padding: const EdgeInsets.only(top: 24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (!_enriched) ...[
                      const _TryIt(),
                      const SizedBox(height: 8),
                    ],
                    Container(
                      width: 250,
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: _cardBg,
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: const Color(0x731F8039)),
                        boxShadow: const [
                          BoxShadow(
                              color: Color(0x40000000),
                              blurRadius: 20,
                              offset: Offset(0, 6)),
                        ],
                      ),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Row(children: [
                            const Icon(Icons.copy,
                                size: 11, color: _textDim),
                            const SizedBox(width: 6),
                            _mono('copied', color: _textDim),
                          ]),
                          const SizedBox(height: 6),
                          Container(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 8, vertical: 6),
                            decoration: BoxDecoration(
                              color: _visualDarker,
                              borderRadius: BorderRadius.circular(5),
                            ),
                            child: _mono('"DS-160 confirmation: AA004TX…"',
                                size: 10, color: const Color(0xFFD6DAE3)),
                          ),
                          const SizedBox(height: 7),
                          AnimatedSwitcher(
                            duration: const Duration(milliseconds: 250),
                            child: _enriched
                                ? Container(
                                    key: const ValueKey('frame'),
                                    padding: const EdgeInsets.symmetric(
                                        horizontal: 8, vertical: 6),
                                    decoration: BoxDecoration(
                                      borderRadius:
                                          BorderRadius.circular(5),
                                      border: Border.all(
                                          color: _green.withValues(
                                              alpha: 0.55)),
                                    ),
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        _mono(
                                            '+ goal: submit the visa application',
                                            color: _saveMint),
                                        const SizedBox(height: 3),
                                        _mono(
                                            '+ step: book appointment · source: Chrome',
                                            color: _saveMint),
                                      ],
                                    ),
                                  )
                                : Row(
                                    key: const ValueKey('hint'),
                                    children: [
                                      const Icon(Icons.add,
                                          size: 11, color: _greenBright),
                                      const SizedBox(width: 6),
                                      Expanded(
                                        child: _mono(
                                            'which task · which step · source app',
                                            color: _textMuted),
                                      ),
                                    ],
                                  ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
            if (_enriched)
              Positioned(
                right: 12,
                bottom: 8,
                child: _Replay(() => setState(() => _enriched = false)),
              ),
          ],
        ),
      );
}

// ── 9 · Save the session (live) ──────────────────────────────────────────────

enum _SaveState { offer, saved, later }

/// The save offer previews WHAT is kept before the tap; the receipt is
/// editable and undo-able. Walking away is free — the tap is offered, never
/// owed.
class _SaveOfferVisual extends StatefulWidget {
  const _SaveOfferVisual();
  @override
  State<_SaveOfferVisual> createState() => _SaveOfferVisualState();
}

class _SaveOfferVisualState extends State<_SaveOfferVisual> {
  _SaveState _s = _SaveState.offer;

  @override
  Widget build(BuildContext context) => Container(
        color: _visualDark,
        child: Stack(
          children: [
            Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (_s == _SaveState.offer) ...[
                    const _TryIt(),
                    const SizedBox(height: 8),
                  ],
                  AnimatedSwitcher(
                    duration: const Duration(milliseconds: 250),
                    child: switch (_s) {
                      _SaveState.offer => _offerCard(),
                      _SaveState.saved => _receiptCard(),
                      _SaveState.later => _laterNote(),
                    },
                  ),
                ],
              ),
            ),
            if (_s != _SaveState.offer)
              Positioned(
                right: 12,
                bottom: 8,
                child: _Replay(() => setState(() => _s = _SaveState.offer)),
              ),
          ],
        ),
      );

  Widget _offerCard() => Container(
        key: const ValueKey('offer'),
        width: 254,
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: _cardBg,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: _green.withValues(alpha: 0.5)),
          boxShadow: const [
            BoxShadow(
                color: Color(0x40000000), blurRadius: 20, offset: Offset(0, 6)),
          ],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(children: [
              _plainDot(_greenBright, 6),
              const SizedBox(width: 7),
              const Expanded(
                child: Text('Save this session?',
                    style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        color: Colors.white)),
              ),
              _mono('4h 50m', color: _textDim),
            ]),
            const SizedBox(height: 7),
            _mono('goal met · 6 facts · 3 agent runs', color: _saveMint),
            const SizedBox(height: 3),
            _mono('cover letter · appointment ✓ · undo after',
                color: _textMuted),
            const SizedBox(height: 9),
            Row(children: [
              _Highlight(
                radius: 5,
                child: _CardVerb('⤓ Save',
                    style: _VerbStyle.filled,
                    onTap: () => setState(() => _s = _SaveState.saved)),
              ),
              const SizedBox(width: 8),
              _CardVerb('later',
                  style: _VerbStyle.quiet,
                  onTap: () => setState(() => _s = _SaveState.later)),
            ]),
          ],
        ),
      );

  Widget _receiptCard() => Container(
        key: const ValueKey('saved'),
        width: 254,
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: _cardBg,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: _hairline),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(children: [
              Container(
                width: 14,
                height: 14,
                decoration: const BoxDecoration(
                    color: _green, shape: BoxShape.circle),
                child:
                    const Icon(Icons.check, size: 9, color: Colors.white),
              ),
              const SizedBox(width: 7),
              const Expanded(
                child: Text('Saved to memory',
                    style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        color: Colors.white)),
              ),
            ]),
            const SizedBox(height: 7),
            _mono('6 facts · 3 agent runs · the cover letter'),
            const SizedBox(height: 3),
            _mono('“next” seeds tomorrow’s re-entry', color: _textDim),
            const SizedBox(height: 9),
            Row(children: [
              _CardVerb('Undo',
                  onTap: () => setState(() => _s = _SaveState.offer)),
              const SizedBox(width: 8),
              _mono('30s to change your mind', color: _textDim, size: 8.5),
            ]),
          ],
        ),
      );

  Widget _laterNote() => Container(
        key: const ValueKey('later'),
        width: 254,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: _cardBg,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: _hairline),
        ),
        child: const Text(
          'Also fine — walk away and the grace period saves the same '
          'preview. The tap is offered, never owed.',
          style: TextStyle(fontSize: 11, height: 1.35, color: _textMuted),
        ),
      );
}

// ── 10 · Knowledge browser (live) ────────────────────────────────────────────

/// The actual knowledge web UI (day theme), shown as a browser window floating
/// in the dark scene area — with the real "open" action as a button inside the
/// window, so the live control lives in the slide's own UI.
class _KnowledgeVisual extends StatefulWidget {
  const _KnowledgeVisual({required this.onOpen});
  final VoidCallback onOpen;
  @override
  State<_KnowledgeVisual> createState() => _KnowledgeVisualState();
}

class _KnowledgeVisualState extends State<_KnowledgeVisual> {
  bool _opened = false;

  @override
  Widget build(BuildContext context) => Container(
        color: _visualDark,
        // FittedBox so the (taller) browser window scales to fit the 200px
        // scene area instead of overflowing it.
        child: Center(
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Container(
              width: 320,
              decoration: BoxDecoration(
                color: _webBg,
                borderRadius: BorderRadius.circular(8),
                boxShadow: const [
                  BoxShadow(
                      color: Color(0x40000000),
                      blurRadius: 20,
                      offset: Offset(0, 6)),
                ],
              ),
              clipBehavior: Clip.antiAlias,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // sticky header: logo · search · Shares
                  Container(
                    decoration: const BoxDecoration(
                      color: _webBg,
                      border: Border(bottom: BorderSide(color: _webBorder)),
                    ),
                    padding:
                        const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
                    child: Row(
                      children: [
                        const Text('SINAIN',
                            style: TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.w700,
                                color: _webAccent)),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Container(
                            height: 26,
                            padding: const EdgeInsets.symmetric(horizontal: 10),
                            alignment: Alignment.centerLeft,
                            decoration: BoxDecoration(
                              color: _webElev,
                              borderRadius: BorderRadius.circular(6),
                              border: Border.all(color: _webBorder),
                            ),
                            child: const Text('Search memory…',
                                style: TextStyle(
                                    fontSize: 11, color: _webFgFaint)),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Container(
                          height: 26,
                          padding: const EdgeInsets.symmetric(horizontal: 8),
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: _webElev,
                            borderRadius: BorderRadius.circular(6),
                            border: Border.all(color: _webBorder),
                          ),
                          child: const Text('📤 Shares',
                              style: TextStyle(fontSize: 11, color: _webFg)),
                        ),
                      ],
                    ),
                  ),
                  // bookmark cards + the live open button
                  Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _entityCard('visa application',
                            'goal met · 6 facts · appointment ✓'),
                        const SizedBox(height: 8),
                        _entityCard('Consulate — visa desk',
                            'appointment booked · docs checklist'),
                        const SizedBox(height: 10),
                        _Highlight(
                          on: !_opened,
                          color: _webAccent,
                          child: GestureDetector(
                            onTap: () {
                              setState(() => _opened = true);
                              widget.onOpen();
                            },
                            child: Container(
                              height: 30,
                              alignment: Alignment.center,
                              decoration: BoxDecoration(
                                color: _webAccent,
                                borderRadius: BorderRadius.circular(6),
                              ),
                              child: const Text(
                                  'Open knowledge browser  ↗',
                                  style: TextStyle(
                                      fontSize: 11,
                                      fontWeight: FontWeight.w600,
                                      color: Colors.white)),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      );

  Widget _entityCard(String entity, String meta) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: _webElev,
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: _webBorder),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(entity,
                style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: _webAccent)),
            const SizedBox(height: 4),
            Text(meta, style: const TextStyle(fontSize: 11, color: _webFgDim)),
          ],
        ),
      );
}

// ── 11 · Privacy ─────────────────────────────────────────────────────────────

class _PrivacyVisual extends StatelessWidget {
  const _PrivacyVisual();
  @override
  Widget build(BuildContext context) => Container(
        color: _visualDark,
        child: Center(
          child: Row(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              _screenEye(_green,
                  struck: true,
                  caption: 'Hidden from capture · vision stays clean'),
              Container(
                  width: 1,
                  height: 90,
                  color: _hairline,
                  margin: const EdgeInsets.symmetric(horizontal: 30)),
              _screenEye(_red,
                  struck: false, caption: 'Demo mode · Sinain is visible'),
            ],
          ),
        ),
      );

  Widget _screenEye(Color c, {required bool struck, required String caption}) =>
      SizedBox(
        width: 130,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CustomPaint(
                size: const Size(70, 49),
                painter: _ScreenEyePainter(c, struck)),
            const SizedBox(height: 12),
            Text(caption,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 11, color: _textMuted)),
          ],
        ),
      );
}

class _ScreenEyePainter extends CustomPainter {
  _ScreenEyePainter(this.color, this.struck);
  final Color color;
  final bool struck;
  @override
  void paint(Canvas canvas, Size size) {
    final stroke = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2
      ..color = color;
    // monitor frame
    canvas.drawRRect(
        RRect.fromRectAndRadius(
            const Rect.fromLTWH(3, 3, 64, 43), const Radius.circular(4)),
        stroke);
    // eye circle
    canvas.drawCircle(const Offset(35, 24.5), 9, stroke);
    // lens
    final lens = Path()
      ..moveTo(35, 19.5)
      ..cubicTo(36.7, 22, 36.7, 27, 35, 29.5)
      ..cubicTo(33.3, 27, 33.3, 22, 35, 19.5)
      ..close();
    canvas.drawPath(lens, Paint()..color = color);
    if (struck) {
      canvas.drawLine(
        const Offset(7, 43),
        const Offset(63, 6),
        Paint()
          ..color = color
          ..strokeWidth = 2.6
          ..strokeCap = StrokeCap.round,
      );
    }
  }

  @override
  bool shouldRepaint(_ScreenEyePainter old) =>
      old.color != color || old.struck != struck;
}

// ── 12 · Done ────────────────────────────────────────────────────────────────

/// The parked island at the notch — where Sinain lives from here on.
class _DoneVisual extends StatelessWidget {
  const _DoneVisual();
  @override
  Widget build(BuildContext context) => Container(
        color: _visualDark,
        child: Stack(
          children: [
            // top menu-bar strip with the island hanging from the notch
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: Container(height: 22, color: _panel),
            ),
            Positioned(
              top: 22,
              left: 0,
              right: 0,
              child: Center(
                child: _IslandBar(children: [
                  const _HaloDot(color: _blue, size: 12, dotSize: 6),
                  const SizedBox(width: 6),
                  _mono('3 working', size: 10),
                ]),
              ),
            ),
            const Center(
              child: Padding(
                padding: EdgeInsets.only(top: 34),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.keyboard_arrow_up, size: 22, color: _green),
                    SizedBox(height: 8),
                    SizedBox(
                      width: 220,
                      child: Text(
                        'Sinain lives up here. Glance for the counts — '
                        'click for the stack.',
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: 12, color: _textMuted),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      );
}
