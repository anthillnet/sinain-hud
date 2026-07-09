import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/services/feature_tour_service.dart';
import '../../core/services/settings_service.dart';
import '../../core/services/window_service.dart';

/// Post-install feature walkthrough — the Claude Design "first-run flow" (v3),
/// nine designed scenes plus two Sinain additions (knowledge browser + share).
///
/// A short centered window: each scene is one visual, a line of copy, and a
/// single primary action. Gated by [FeatureTourService.needsTour]; mounted by
/// `main.dart` after the first-run wizard and provisioning, before the HUD.
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

// ── Design palette (from Onboarding.dc.html) ─────────────────────────────────
const _cardBg = Color(0xFF1E1F22);
const _visualDark = Color(0xFF171819);
const _visualDarker = Color(0xFF15161A);
const _panel = Color(0xFF2B2D30);
const _green = Color(0xFF1F8039);
const _blue = Color(0xFF3369D6);
const _red = Color(0xFFCC3645);
const _orange = Color(0xFFE56D17);
const _purple = Color(0xFF834DF0);
const _textMuted = Color(0xFFA8ADBD);
const _textDim = Color(0xFF6C707E);
const _dotInactive = Color(0xFF3A3D42);
const _lightBg = Color(0xFFF7F8FA);
const _shimmer1 = Color(0xFFDFE1E5);
const _shimmer2 = Color(0xFFEBECF0);
const _hairline = Color(0x14FFFFFF); // rgba(255,255,255,.08)

// Knowledge web-UI "day theme" tokens — copied from the :root vars in
// sinain-core/src/server.ts so scenes 7–8 render the real browser UI, not a
// dark stand-in.
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
    this.action,
  });
  final String title;
  final String body;
  final Widget visual;
  final _LiveAction? action;
}

class _LiveAction {
  const _LiveAction(this.label, this.path, {this.icon});
  final String label;

  /// Path appended to the derived sinain-core http origin (e.g. /knowledge/ui).
  final String path;

  /// Leading glyph — the real HUD control the user taps for this destination.
  final IconData? icon;
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
                      if (scene.action != null) ...[
                        const SizedBox(height: 12),
                        _SecondaryAction(
                          label: scene.action!.label,
                          icon: scene.action!.icon,
                          onTap: () => _openPath(scene.action!.path),
                        ),
                      ],
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

  List<_Scene> _buildScenes() => [
        // 1 · Welcome
        const _Scene(
          title: 'Meet Sinain',
          body: "Sinain watches what's on your screen and offers help exactly "
              'where you need it — without getting in your way.',
          visual: _WelcomeVisual(),
        ),
        // (markers scene sunset for now — auto-ROI markers aren't the
        // headline; the four deliberate-capture modes are)
        // 2 · Save context (deliberate capture mode 1)
        const _Scene(
          title: 'Save what just happened',
          body: 'Right-click the eye → Save Context. Pick how far back — and '
              'which apps — and Sinain distills those minutes into memory. '
              '30 seconds to undo; nothing is saved without you asking.',
          visual: _SaveContextVisual(),
        ),
        // 4 · Call AI on a range (mode 2)
        const _Scene(
          title: 'Call AI on your last minutes',
          body: 'The same range can go to an AI instead: Call AI hands a '
              'brief to your agent as text, Call sinain starts a live voice '
              'call seeded with it. You always see what it will know.',
          visual: _CallAiVisual(),
        ),
        // 5 · Context from screen (mode 3)
        const _Scene(
          title: 'Context from your screen',
          body: 'Pick Context from Screen — or double-tap the eye — then drag '
              'a box around any part of your screen. Sinain enriches the '
              'selection with your recent activity and hands it to your AI.',
          visual: _RegionVisual(),
        ),
        // 6 · Context from clipboard (mode 4)
        const _Scene(
          title: 'Context from your clipboard',
          body: 'Copy anything — an error, a link, a paragraph — then Context '
              'from Clipboard. Sinain wraps it with what you were doing, so '
              'any AI gets the full picture instead of a bare snippet.',
          visual: _ClipboardVisual(),
        ),
        // · Where chat lands
        const _Scene(
          title: 'Chat, your way',
          body: 'A thread can stay in the Sinain HUD, pop out into an app you '
              'already use — ChatGPT, Claude, anything — or become a live '
              'voice call with sinain. Either way the context rides along.',
          visual: _WhereChatLandsVisual(),
        ),
        // 5 · Pick your agents
        const _Scene(
          title: 'Chat or terminal',
          body:
              'Every context — a saved range, a screen region, a clipboard — '
              'opens a thread. Reply in built-in chat, or hand it to a '
              'terminal agent you already use. We listed the ones found on '
              'your machine — change them anytime.',
          visual: _AgentsVisual(),
        ),
        // 6 · Move a thread (handoff)
        const _Scene(
          title: 'Move it to any agent',
          body:
              'Start in Sinain chat, then hand the whole thread — its context '
              'and your messages — to another agent like claude code. Tap the '
              'branch button by the message box. Nothing is lost.',
          visual: _HandoffVisual(),
        ),
        // 7 · Memory & knowledge browser (NEW)
        const _Scene(
          title: 'Sinain remembers',
          body: 'Everything Sinain learns becomes searchable memory — facts, '
              'people, decisions — across every session. Open the knowledge '
              'browser to explore or search it.',
          visual: _KnowledgeVisual(),
          action: _LiveAction('Open knowledge browser  ↗', '/knowledge/ui',
              icon: Icons.psychology_outlined),
        ),
        // 8 · Share a concept (NEW)
        const _Scene(
          title: 'Share what it knows',
          body:
              'Turn any concept into a private link. The page renders on your '
              'Mac; whoever you send it to sees the knowledge, never your '
              'screen — and the host only ever logs a generic page view.',
          visual: _ShareVisual(),
          action:
              _LiveAction('Open your share links  ↗', '/knowledge/ui/shares'),
        ),
        // 9 · Screen & audio
        const _Scene(
          title: 'Screen and audio',
          body: 'Sinain reads your screen and can capture video and audio for '
              'richer context. Flip either one on or off from the controls '
              'whenever you like.',
          visual: _CaptureVisual(),
        ),
        // 10 · Private by design
        const _Scene(
          title: 'Private by design',
          body: 'When you share your screen, others see only your apps — never '
              'Sinain. In demo mode the eye turns red and Sinain sees itself, '
              'which can cause vision artifacts.',
          visual: _PrivacyVisual(),
        ),
        // 11 · You're set
        const _Scene(
          title: "You're all set",
          body:
              'Sinain is running and ready. Markers will start appearing as it '
              'learns what you’re working on.',
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

class _SecondaryAction extends StatelessWidget {
  const _SecondaryAction({required this.label, required this.onTap, this.icon});
  final String label;
  final VoidCallback onTap;
  final IconData? icon;
  @override
  Widget build(BuildContext context) => GestureDetector(
        onTap: onTap,
        child: Align(
          alignment: Alignment.centerLeft,
          child: Container(
            height: 32,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: const Color(0x281F8039), // rgba(31,128,57,.16)
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: _green),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (icon != null) ...[
                  Icon(icon, size: 15, color: const Color(0xFF4CC56A)),
                  const SizedBox(width: 7),
                ],
                Text(label,
                    style: const TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w500,
                        color: Color(0xFF4CC56A))),
              ],
            ),
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
          padding: const EdgeInsets.all(20),
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

Widget _chatTermChips() => Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          height: 22,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          alignment: Alignment.center,
          decoration: BoxDecoration(
              color: _blue, borderRadius: BorderRadius.circular(3)),
          child: const Text('Chat',
              style: TextStyle(fontSize: 11, color: Colors.white)),
        ),
        const SizedBox(width: 4),
        Container(
          height: 22,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(3),
            border: Border.all(color: const Color(0x2EFFFFFF)),
          ),
          child: const Text('Term',
              style: TextStyle(
                  fontSize: 11, color: Colors.white, fontFamily: 'monospace')),
        ),
      ],
    );

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

class _RegionVisual extends StatelessWidget {
  const _RegionVisual();
  @override
  Widget build(BuildContext context) => Container(
        color: _lightBg,
        child: Stack(
          children: [
            const Positioned.fill(child: _MockPage(opacity: 0.5)),
            const Positioned.fill(child: ColoredBox(color: Color(0x4D1E1F22))),
            // selection box
            Positioned(
              left: 70,
              top: 54,
              child: SizedBox(
                width: 240,
                height: 104,
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
                        child: const Text('240 × 104',
                            style: TextStyle(
                                fontSize: 10,
                                color: Colors.white,
                                fontFamily: 'monospace')),
                      ),
                    ),
                    // bottom toolbar (Chat / Term)
                    Positioned(
                      left: 0,
                      right: 0,
                      bottom: -36,
                      child: Center(
                        child: Container(
                          padding: const EdgeInsets.all(4),
                          decoration: BoxDecoration(
                            color: _panel,
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: const Color(0x24FFFFFF)),
                          ),
                          child: _chatTermChips(),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            // gesture pill, top-right
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
                    Text('Double-tap the eye',
                        style: TextStyle(fontSize: 11, color: Colors.white)),
                  ],
                ),
              ),
            ),
          ],
        ),
      );
}

class _WhereChatLandsVisual extends StatelessWidget {
  const _WhereChatLandsVisual();
  @override
  Widget build(BuildContext context) => Container(
        color: _visualDark,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        child: Center(
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Row(
              children: [
                // Sinain HUD card (selected, green border + check)
                _appCard(
                  borderColor: _green,
                  header: const Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      _EyeGlyph(size: 14, strokeWidth: 3),
                      SizedBox(width: 6),
                      Text('Sinain HUD',
                          style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w500,
                              color: Colors.white)),
                    ],
                  ),
                  footerColor: Colors.white,
                  check: true,
                ),
                const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 12),
                  child: Text('or',
                      style: TextStyle(fontSize: 12, color: _textDim)),
                ),
                // External app card (ChatGPT)
                _appCard(
                  borderColor: const Color(0x1FFFFFFF),
                  titleBar: true,
                  header: const Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.open_in_new, size: 14, color: _textMuted),
                      SizedBox(width: 6),
                      Text('Your app',
                          style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w500,
                              color: _textMuted)),
                    ],
                  ),
                  footerColor: _textMuted,
                ),
                const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 12),
                  child: Text('or',
                      style: TextStyle(fontSize: 12, color: _textDim)),
                ),
                _voiceCard(),
              ],
            ),
          ),
        ),
      );

  /// Third destination: a live voice call with sinain — the call chip.
  Widget _voiceCard() => Container(
        width: 150,
        decoration: BoxDecoration(
          color: _cardBg,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: const Color(0x733369D6)),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              color: _visualDarker,
              height: 80,
              alignment: Alignment.center,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  for (final h in const [8.0, 18.0, 12.0, 22.0, 10.0]) ...[
                    Container(
                        width: 4,
                        height: h,
                        decoration: BoxDecoration(
                            color: _blue,
                            borderRadius: BorderRadius.circular(2))),
                    const SizedBox(width: 3),
                  ],
                  const SizedBox(width: 7),
                  Container(
                    height: 18,
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                        color: const Color(0xFFB3361C),
                        borderRadius: BorderRadius.circular(4)),
                    child: const Text('End',
                        style: TextStyle(fontSize: 9, color: Colors.white)),
                  ),
                ],
              ),
            ),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              decoration: const BoxDecoration(
                  border: Border(top: BorderSide(color: _hairline))),
              child: const Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.graphic_eq, size: 14, color: _blue),
                  SizedBox(width: 6),
                  Text('Sinain voice',
                      style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w500,
                          color: _textMuted)),
                ],
              ),
            ),
          ],
        ),
      );

  Widget _appCard({
    required Color borderColor,
    required Widget header,
    required Color footerColor,
    bool check = false,
    bool titleBar = false,
  }) {
    return Container(
      width: 150,
      decoration: BoxDecoration(
        color: _cardBg,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: borderColor),
      ),
      clipBehavior: Clip.antiAlias,
      child: Stack(
        children: [
          Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (titleBar)
                Container(
                  height: 22,
                  color: _panel,
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  child: Row(
                    children: [
                      _dot(_red),
                      const SizedBox(width: 4),
                      _dot(_orange),
                      const SizedBox(width: 4),
                      _dot(_green),
                      const SizedBox(width: 6),
                      const Text('ChatGPT',
                          style: TextStyle(fontSize: 10, color: _textMuted)),
                    ],
                  ),
                ),
              // message bubbles
              Container(
                color: titleBar ? null : _visualDarker,
                height: titleBar ? 58 : 80,
                padding: const EdgeInsets.all(10),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.end,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Align(
                      alignment: Alignment.centerRight,
                      child: Container(
                          width: 54,
                          height: 13,
                          decoration: BoxDecoration(
                              color: titleBar ? _blue : _green,
                              borderRadius: BorderRadius.circular(7))),
                    ),
                    const SizedBox(height: 5),
                    Align(
                      alignment: Alignment.centerLeft,
                      child: Container(
                          width: 70,
                          height: 13,
                          decoration: BoxDecoration(
                              color: _panel,
                              borderRadius: BorderRadius.circular(7),
                              border:
                                  Border.all(color: const Color(0x1AFFFFFF)))),
                    ),
                  ],
                ),
              ),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                decoration: const BoxDecoration(
                    border: Border(top: BorderSide(color: _hairline))),
                child: header,
              ),
            ],
          ),
          if (check)
            Positioned(
              top: 6,
              right: 6,
              child: Container(
                width: 16,
                height: 16,
                decoration:
                    const BoxDecoration(color: _green, shape: BoxShape.circle),
                child: const Icon(Icons.check, size: 10, color: Colors.white),
              ),
            ),
        ],
      ),
    );
  }

  Widget _dot(Color c) => Container(
      width: 7,
      height: 7,
      decoration: BoxDecoration(color: c, shape: BoxShape.circle));
}

class _AgentsVisual extends StatelessWidget {
  const _AgentsVisual();
  @override
  Widget build(BuildContext context) => Container(
        color: _visualDark,
        child: Center(
          child: SizedBox(
            width: 300,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('Chat opens with',
                    style: TextStyle(fontSize: 11, color: _textMuted)),
                const SizedBox(height: 5),
                _row(_green, 'S', 'Sinain', 'Built in', isMono: false),
                const SizedBox(height: 12),
                const Text('Terminal runs',
                    style: TextStyle(fontSize: 11, color: _textMuted)),
                const SizedBox(height: 5),
                _row(_blue, 'O', 'openclaude', null, isMono: true),
              ],
            ),
          ),
        ),
      );

  Widget _row(Color badge, String letter, String name, String? tag,
      {bool isMono = false}) {
    return Container(
      height: 34,
      padding: const EdgeInsets.symmetric(horizontal: 10),
      decoration: BoxDecoration(
        color: _panel,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: const Color(0x24FFFFFF)),
      ),
      child: Row(
        children: [
          Container(
            width: 18,
            height: 18,
            alignment: Alignment.center,
            decoration: BoxDecoration(
                color: badge, borderRadius: BorderRadius.circular(4)),
            child: Text(letter,
                style: const TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                    color: Colors.white)),
          ),
          const SizedBox(width: 8),
          Text(name,
              style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                  color: Colors.white,
                  fontFamily: isMono ? 'monospace' : null)),
          if (tag != null) ...[
            const SizedBox(width: 8),
            Text(tag, style: const TextStyle(fontSize: 11, color: _textDim)),
          ],
          const Spacer(),
          const Icon(Icons.keyboard_arrow_down, size: 16, color: _textMuted),
        ],
      ),
    );
  }
}

class _HandoffVisual extends StatelessWidget {
  const _HandoffVisual();
  @override
  Widget build(BuildContext context) => Container(
        color: _visualDark,
        padding: const EdgeInsets.all(16),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.end,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              constraints: const BoxConstraints(maxWidth: 320),
              padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 8),
              decoration: BoxDecoration(
                color: _panel,
                borderRadius: const BorderRadius.only(
                  topLeft: Radius.circular(10),
                  topRight: Radius.circular(10),
                  bottomRight: Radius.circular(10),
                  bottomLeft: Radius.circular(2),
                ),
                border: Border.all(color: _hairline),
              ),
              child: const Text(
                "I can't run commands myself — want me to hand this to a "
                'terminal agent?',
                style: TextStyle(fontSize: 12, height: 1.33, color: _textMuted),
              ),
            ),
            const SizedBox(height: 12),
            // composer + popover
            Stack(
              clipBehavior: Clip.none,
              children: [
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                  decoration: BoxDecoration(
                    color: _cardBg,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: const Color(0x1AFFFFFF)),
                  ),
                  child: Row(
                    children: [
                      Container(
                        width: 28,
                        height: 28,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: const Color(0x281F8039),
                          borderRadius: BorderRadius.circular(6),
                          border: Border.all(color: _green),
                        ),
                        child: const Icon(Icons.account_tree_outlined,
                            size: 15, color: _green),
                      ),
                      const SizedBox(width: 8),
                      const Expanded(
                          child: Text('Type a message',
                              style: TextStyle(fontSize: 12, color: _textDim))),
                      const Icon(Icons.send, size: 16, color: _textDim),
                    ],
                  ),
                ),
                Positioned(
                  left: 0,
                  bottom: 40,
                  child: Container(
                    width: 180,
                    decoration: BoxDecoration(
                      color: _panel,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: const Color(0x24FFFFFF)),
                      boxShadow: const [
                        BoxShadow(
                            color: Color(0x73000000),
                            blurRadius: 16,
                            offset: Offset(0, 4))
                      ],
                    ),
                    clipBehavior: Clip.antiAlias,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const Padding(
                          padding:
                              EdgeInsets.symmetric(horizontal: 11, vertical: 7),
                          child: Text('Continue in',
                              style: TextStyle(fontSize: 11, color: _textDim)),
                        ),
                        _agentRow(_purple, 'C', 'claude code', selected: true),
                        _agentRow(_green, 'X', 'codex'),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      );

  Widget _agentRow(Color badge, String mono, String name,
          {bool selected = false}) =>
      Container(
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
        decoration: BoxDecoration(
          color: selected ? const Color(0x281F8039) : null,
          border: selected
              ? const Border(left: BorderSide(color: _green, width: 2))
              : null,
        ),
        child: Row(
          children: [
            Container(
              width: 16,
              height: 16,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                  color: badge, borderRadius: BorderRadius.circular(4)),
              child: Text(mono,
                  style: const TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.w700,
                      color: Colors.white)),
            ),
            const SizedBox(width: 8),
            Text(name,
                style: const TextStyle(
                    fontSize: 12,
                    color: Colors.white,
                    fontFamily: 'monospace')),
          ],
        ),
      );
}

/// Scene 7 — the actual knowledge web UI (day theme), shown as a browser window
/// floating in the dark scene area. Header (blue SINAIN logo + search + 📤
/// Shares), then bookmark cards — matching sinain-core/src/server.ts.
class _KnowledgeVisual extends StatelessWidget {
  const _KnowledgeVisual();
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
                  // bookmark cards
                  Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        _entityCard(
                            'Email style', 'concise · ask-first · warm tone'),
                        const SizedBox(height: 8),
                        _entityCard(
                            'Follow-ups', 'nudge after 2 business days'),
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

/// Scene 8 — the real entity page (day theme) with the 📤 Share icon button
/// (server.ts #actShare). Clicking it mints the privacy-preserving share link.
class _ShareVisual extends StatelessWidget {
  const _ShareVisual();
  @override
  Widget build(BuildContext context) => Container(
        color: _visualDark,
        child: Center(
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Container(
              width: 320,
              padding: const EdgeInsets.all(14),
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
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // page-header: title + page-actions (📤 share icon button)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Row(
                      children: [
                        const Expanded(
                          child: Text('Email writing style',
                              style: TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w700,
                                  color: _webFg)),
                        ),
                        const SizedBox(width: 8),
                        Container(
                          height: 28,
                          padding: const EdgeInsets.symmetric(horizontal: 9),
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: _webElev,
                            borderRadius: BorderRadius.circular(6),
                            border: Border.all(color: _webBorder),
                          ),
                          child:
                              const Text('📤', style: TextStyle(fontSize: 14)),
                        ),
                      ],
                    ),
                  ),
                  // minted share link
                  Container(
                    height: 32,
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    decoration: BoxDecoration(
                      color: _webElev,
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: _webBorder),
                    ),
                    child: const Row(
                      children: [
                        Icon(Icons.link, size: 14, color: _webFgDim),
                        SizedBox(width: 8),
                        Expanded(
                          child: Text('sinain.com/share.html#…',
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                  fontSize: 11,
                                  color: _webFgDim,
                                  fontFamily: 'monospace')),
                        ),
                        Text('📋', style: TextStyle(fontSize: 12)),
                      ],
                    ),
                  ),
                  const SizedBox(height: 8),
                  const Row(
                    children: [
                      Icon(Icons.lock_outline, size: 12, color: _webAccent),
                      SizedBox(width: 6),
                      Expanded(
                        child: Text(
                            'Host logs only “GET /share.html” — never the concept',
                            style: TextStyle(fontSize: 10, color: _webFgFaint)),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      );
}

// ── Deliberate-capture scene visuals (tour modes 1/2/4) ─────────────────────

/// Mini chooser-card mock shared by the Save/Call scenes: header + presets +
/// source checklist + verb buttons, in the tour palette.
class _MiniChooser extends StatelessWidget {
  const _MiniChooser({
    required this.title,
    required this.accent,
    required this.consentLabel,
    required this.buttons,
  });
  final String title;
  final Color accent;
  final String consentLabel;
  final Widget buttons;

  @override
  Widget build(BuildContext context) => Container(
        width: 250,
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: _cardBg,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: accent.withValues(alpha: 0.45)),
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
              const _EyeGlyph(size: 13, strokeWidth: 3),
              const SizedBox(width: 7),
              Text(title,
                  style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: Colors.white)),
              const Spacer(),
              Text('30 min',
                  style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      fontFamily: 'monospace',
                      color: accent)),
            ]),
            const SizedBox(height: 8),
            Row(children: [
              for (final n in const ['5m', '15m', '30m', '60m']) ...[
                Expanded(
                  child: Container(
                    height: 18,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: n == '30m'
                          ? accent.withValues(alpha: 0.25)
                          : _panel,
                      borderRadius: BorderRadius.circular(4),
                      border: Border.all(
                          color: n == '30m'
                              ? accent.withValues(alpha: 0.55)
                              : _hairline),
                    ),
                    child: Text(n,
                        style: TextStyle(
                            fontSize: 9,
                            fontFamily: 'monospace',
                            color: n == '30m' ? Colors.white : _textMuted)),
                  ),
                ),
                if (n != '60m') const SizedBox(width: 4),
              ],
            ]),
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: _visualDarker,
                borderRadius: BorderRadius.circular(6),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(children: [
                    Flexible(
                      child: Text(consentLabel,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                              fontSize: 8,
                              fontWeight: FontWeight.w600,
                              letterSpacing: 0.4,
                              color: _textDim)),
                    ),
                    const SizedBox(width: 6),
                    const Spacer(),
                    const Text('2 of 3 sources',
                        style: TextStyle(
                            fontSize: 8,
                            fontFamily: 'monospace',
                            color: _textDim)),
                  ]),
                  const SizedBox(height: 5),
                  _srcRow(accent, 'IntelliJ IDEA', '26 min', on: true),
                  _srcRow(accent, 'Chrome', '12 min', on: true),
                  _srcRow(accent, 'Slack', '4 min', on: false),
                ],
              ),
            ),
            const SizedBox(height: 8),
            buttons,
          ],
        ),
      );

  static Widget _srcRow(Color accent, String name, String mins,
          {required bool on}) =>
      Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(children: [
          Container(
            width: 10,
            height: 10,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: on ? accent : Colors.transparent,
              border:
                  Border.all(color: on ? accent : const Color(0x40FFFFFF)),
              borderRadius: BorderRadius.circular(2),
            ),
            child: on
                ? const Text('✓',
                    style: TextStyle(
                        fontSize: 7, height: 1, color: Colors.white))
                : null,
          ),
          const SizedBox(width: 7),
          Expanded(
            child: Text(name,
                style: TextStyle(
                    fontSize: 10,
                    fontFamily: 'monospace',
                    color: on ? const Color(0xFFD6DAE3) : _textDim)),
          ),
          Text(mins,
              style: const TextStyle(
                  fontSize: 8, fontFamily: 'monospace', color: _textDim)),
        ]),
      );

  static Widget verb(String label, Color color, {bool outline = false}) =>
      Expanded(
        child: Container(
          height: 24,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: outline ? Colors.transparent : color,
            border: outline ? Border.all(color: const Color(0x2EFFFFFF)) : null,
            borderRadius: BorderRadius.circular(5),
          ),
          child: Text(label,
              style: TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.w500,
                  color: outline ? _textMuted : Colors.white)),
        ),
      );
}

class _SaveContextVisual extends StatelessWidget {
  const _SaveContextVisual();
  @override
  Widget build(BuildContext context) => Container(
        color: _visualDark,
        child: Center(
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: _MiniChooser(
              title: 'Save context…',
              accent: _green,
              consentLabel: 'COVERS · CLICK TO EXCLUDE',
              buttons: Row(children: [
                _MiniChooser.verb('Save 30 min', _green),
                const SizedBox(width: 6),
                _MiniChooser.verb('Cancel', _green, outline: true),
              ]),
            ),
          ),
        ),
      );
}

class _CallAiVisual extends StatelessWidget {
  const _CallAiVisual();
  @override
  Widget build(BuildContext context) => Container(
        color: _visualDark,
        child: Center(
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: _MiniChooser(
              title: 'Call AI on…',
              accent: _blue,
              consentLabel: 'AI WILL KNOW · CLICK TO EXCLUDE',
              buttons: Row(children: [
                _MiniChooser.verb('Call AI', _blue),
                const SizedBox(width: 6),
                _MiniChooser.verb('Call sinain', _green),
              ]),
            ),
          ),
        ),
      );
}

/// Mode 4 — the enrich card: clipboard snippet + composed CONTEXT + handoff.
class _ClipboardVisual extends StatelessWidget {
  const _ClipboardVisual();
  @override
  Widget build(BuildContext context) => Container(
        color: _visualDark,
        child: Center(
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Container(
              width: 260,
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
                  const Row(children: [
                    _EyeGlyph(size: 13, strokeWidth: 3),
                    SizedBox(width: 7),
                    Text('Context from clipboard',
                        style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                            color: Colors.white)),
                  ]),
                  const SizedBox(height: 8),
                  Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 8, vertical: 6),
                    decoration: BoxDecoration(
                      color: _visualDarker,
                      borderRadius: BorderRadius.circular(5),
                    ),
                    child: const Text('"x-ratelimit-remaining-tokens"',
                        style: TextStyle(
                            fontSize: 10,
                            fontFamily: 'monospace',
                            color: Color(0xFFD6DAE3))),
                  ),
                  const SizedBox(height: 8),
                  const Text('CONTEXT',
                      style: TextStyle(
                          fontSize: 8,
                          fontWeight: FontWeight.w600,
                          letterSpacing: 0.4,
                          color: _textDim)),
                  const SizedBox(height: 5),
                  Container(height: 8, decoration: _bar(_panel)),
                  const SizedBox(height: 5),
                  FractionallySizedBox(
                      alignment: Alignment.centerLeft,
                      widthFactor: 0.72,
                      child: Container(height: 8, decoration: _bar(_panel))),
                  const SizedBox(height: 10),
                  Row(children: [
                    _MiniChooser.verb('Handoff to Claude Code', _blue),
                    const SizedBox(width: 6),
                    _MiniChooser.verb('Copy for agent', _blue, outline: true),
                  ]),
                ],
              ),
            ),
          ),
        ),
      );

  static BoxDecoration _bar(Color c) =>
      BoxDecoration(color: c, borderRadius: BorderRadius.circular(3));
}

class _CaptureVisual extends StatelessWidget {
  const _CaptureVisual();
  @override
  Widget build(BuildContext context) => Container(
        color: _visualDark,
        child: Center(
          child: SizedBox(
            width: 300,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                // Real in-app control glyphs (overlay_shell.dart): screen =
                // desktop_windows, audio = volume_up_rounded.
                _toggleRow(Icons.desktop_windows, 'Screen & video',
                    "What's on your display"),
                const SizedBox(height: 10),
                _toggleRow(
                    Icons.volume_up_rounded, 'Audio', 'Mic and system sound'),
              ],
            ),
          ),
        ),
      );

  Widget _toggleRow(IconData icon, String title, String sub) => Container(
        height: 42,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          color: _panel,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: const Color(0x1FFFFFFF)),
        ),
        child: Row(
          children: [
            Icon(icon, size: 20, color: _green),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(title,
                      style: const TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w500,
                          color: Colors.white)),
                  Text(sub,
                      style: const TextStyle(fontSize: 11, color: _textDim)),
                ],
              ),
            ),
            // on toggle
            Container(
              width: 36,
              height: 20,
              decoration: BoxDecoration(
                  color: _green, borderRadius: BorderRadius.circular(10)),
              child: Stack(children: [
                Positioned(
                  top: 2,
                  left: 18,
                  child: Container(
                    width: 16,
                    height: 16,
                    decoration: const BoxDecoration(
                        color: Colors.white, shape: BoxShape.circle),
                  ),
                ),
              ]),
            ),
          ],
        ),
      );
}

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

class _DoneVisual extends StatelessWidget {
  const _DoneVisual();
  @override
  Widget build(BuildContext context) => Container(
        color: _visualDark,
        child: Stack(
          children: [
            // top menu-bar strip with the eye anchored top-right
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: Container(
                height: 30,
                color: _panel,
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    const Icon(Icons.circle_outlined,
                        size: 14, color: _textDim),
                    const SizedBox(width: 10),
                    const Icon(Icons.settings, size: 14, color: _textDim),
                    const SizedBox(width: 10),
                    Container(
                      width: 24,
                      height: 24,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: _cardBg,
                        border: Border.all(color: const Color(0x991F8039)),
                      ),
                      child: const _EyeGlyph(size: 16, strokeWidth: 3),
                    ),
                  ],
                ),
              ),
            ),
            const Center(
              child: Padding(
                padding: EdgeInsets.only(top: 18),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.keyboard_arrow_up, size: 22, color: _green),
                    SizedBox(height: 8),
                    SizedBox(
                      width: 200,
                      child: Text(
                        'Sinain lives up here. Tap the eye to collapse the HUD, anytime.',
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
