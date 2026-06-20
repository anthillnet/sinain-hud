// Shared design language for the first-run setup wizard and provisioning
// banner, recreated from the Claude Design handoff (`Setup Wizard.dc.html`) so
// both surfaces match the post-install feature tour exactly. These are the same
// tokens `ui/tour/onboarding_tour.dart` uses (Ring UI green on a dark card),
// promoted to public so the wizard can share them without reaching into the
// tour's library-private members.
import 'package:flutter/material.dart';

// ── Palette (from the design's inline styles) ────────────────────────────────
const Color kWizardCardBg = Color(0xFF1E1F22); // panel background
const Color kWizardPanel = Color(0xFF2B2D30); // inset rows / inputs
const Color kWizardCodeBg = Color(0xFF15161A); // code block / dark inset
const Color kWizardGreen = Color(0xFF1F8039); // Ring UI green (accent)
const Color kWizardOrange = Color(0xFFE56D17); // warning accent
const Color kWizardTextMuted = Color(0xFFA8ADBD); // body copy
const Color kWizardTextDim = Color(0xFF6C707E); // secondary / hints
const Color kWizardCodeText = Color(0xFFD6DAE3); // monospace command text
const Color kWizardDotInactive = Color(0xFF3A3D42); // progress dot, inactive
const Color kWizardHairline = Color(0x14FFFFFF); // rgba(255,255,255,.08)

/// The wizard card shadow — `0 4px 24px rgba(0,28,54,.18)` + `0 2px 6px …`.
const List<BoxShadow> kWizardCardShadow = [
  BoxShadow(color: Color(0x2E001C36), blurRadius: 24, offset: Offset(0, 4)),
  BoxShadow(color: Color(0x1A001C36), blurRadius: 6, offset: Offset(0, 2)),
];

/// The "SINAIN" wordmark shown at the top of every wizard card — green, bold,
/// wide letter-spacing, centered.
class WizardWordmark extends StatelessWidget {
  const WizardWordmark({super.key});

  @override
  Widget build(BuildContext context) => const Text(
        'SINAIN',
        textAlign: TextAlign.center,
        style: TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w700,
          color: kWizardGreen,
          letterSpacing: 2.6, // .2em on 13px
        ),
      );
}

/// Five-step progress dots; the active step is a 16px green pill, the rest are
/// 6px grey dots. Matches the `mk(active)` renderer in the design.
class WizardProgressDots extends StatelessWidget {
  const WizardProgressDots({
    super.key,
    required this.active,
    this.total = 5,
  });

  final int active;
  final int total;

  @override
  Widget build(BuildContext context) => Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          for (var i = 0; i < total; i++) ...[
            if (i > 0) const SizedBox(width: 6),
            AnimatedContainer(
              duration: const Duration(milliseconds: 180),
              width: i == active ? 16 : 6,
              height: 6,
              decoration: BoxDecoration(
                color: i == active ? kWizardGreen : kWizardDotInactive,
                borderRadius: BorderRadius.circular(3),
              ),
            ),
          ],
        ],
      );
}

/// Full-width, 36px, solid-green primary button (the design's `<button>`).
/// Dims to a faint grey when [onTap] is null.
class WizardButton extends StatelessWidget {
  const WizardButton({super.key, required this.label, required this.onTap});

  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: 36,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: enabled ? kWizardGreen : Colors.white.withValues(alpha: 0.06),
          borderRadius: BorderRadius.circular(4),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w500,
            color: enabled ? Colors.white : Colors.white.withValues(alpha: 0.3),
          ),
        ),
      ),
    );
  }
}

/// A centered, dim text link — the "Quit" / "Do this later" affordances.
class WizardTextLink extends StatelessWidget {
  const WizardTextLink({super.key, required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => GestureDetector(
        onTap: onTap,
        child: Text(
          label,
          style: const TextStyle(fontSize: 12, color: kWizardTextDim),
        ),
      );
}

/// The Sinain eye: a stroked circle with a vertical lens, scaled from the 30×30
/// viewBox used throughout the design. Mirrors the tour's `_EyeGlyph`.
class WizardEyeGlyph extends StatelessWidget {
  const WizardEyeGlyph({
    super.key,
    required this.size,
    this.strokeWidth = 2.4,
    this.circleFill = kWizardCardBg,
  });

  final double size;
  final double strokeWidth;
  final Color? circleFill;

  @override
  Widget build(BuildContext context) => CustomPaint(
        size: Size.square(size),
        painter: _WizardEyePainter(kWizardGreen, strokeWidth, circleFill),
      );
}

class _WizardEyePainter extends CustomPainter {
  _WizardEyePainter(this.color, this.strokeWidth, this.circleFill);

  final Color color;
  final double strokeWidth;
  final Color? circleFill;

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.width / 30.0; // viewBox 30×30
    final c = Offset(15 * s, 15 * s);
    if (circleFill != null) {
      canvas.drawCircle(c, 13.5 * s, Paint()..color = circleFill!);
    }
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
  bool shouldRepaint(_WizardEyePainter old) =>
      old.color != color ||
      old.strokeWidth != strokeWidth ||
      old.circleFill != circleFill;
}

/// A small green check inside a rounded-square stroke, matching the SVG check
/// used for the selected tier and the "All set" confirmation.
class WizardCheck extends StatelessWidget {
  const WizardCheck({super.key, this.size = 13, this.color = kWizardGreen});

  final double size;
  final Color color;

  @override
  Widget build(BuildContext context) =>
      Icon(Icons.check, size: size, color: color);
}
