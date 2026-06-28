import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/hud_settings.dart';
import '../services/settings_service.dart';

/// Resolves the HUD's surface palette for the current presentation style.
///
/// Two visual languages live in the app: the original *see-through* HUD
/// (translucent black over a transparent macOS window) and the *solid* design
/// system already shipping in the native ROI card (RegionEyePool.swift) and the
/// Flutter agent selector (`agent_selector_panel.dart`). [HudStyle] selects
/// between them; every panel reads its colors/opacities/shadows from here so the
/// toggle flips the whole HUD from one source of truth.
///
/// This is a plain value object — no new state machinery. Construct it from the
/// existing [SettingsService] via [HudTheme.of] inside a `build`; widgets that
/// already `context.watch<SettingsService>()` rebuild on style changes for free.
class HudTheme {
  const HudTheme({required this.style, required this.accent});

  final HudStyle style;
  final Color accent;

  /// Reads the live style + accent from settings. Uses `watch` so a style change
  /// rebuilds the calling widget. Call inside `build`.
  factory HudTheme.of(BuildContext context) {
    final s = context.watch<SettingsService>().settings;
    return HudTheme(style: s.hudStyle, accent: Color(s.accentColor));
  }

  bool get isSolid => style == HudStyle.solid;

  // ── Solid design-system tokens (mirrors agent_selector_panel.dart) ──────────
  static const Color _solidPanel = Color(0xFF1E1F22);
  static const Color _solidElevated = Color(0xFF2B2D30);
  static const Color _solidBubbleLow = Color(0xFF26282B);
  static const Color _solidStroke = Color(0x24FFFFFF); // rgba(255,255,255,.14)
  static const Color _solidHairline = Color(0x14FFFFFF); // rgba(255,255,255,.08)
  static const Color _solidMuted = Color(0xFFA8ADBD);
  static const Color _solidDim = Color(0xFF6C707E);
  static const Color _designGreen = Color(0xFF1F8039);

  /// Main panel background (chat panel, handoff popover).
  Color get panelBg =>
      isSolid ? _solidPanel : Colors.black.withValues(alpha: 0.85);

  /// Denser panel background (settings popover).
  Color get panelBgStrong =>
      isSolid ? _solidPanel : Colors.black.withValues(alpha: 0.95);

  /// Header / toolbar strip background.
  Color get headerBg =>
      isSolid ? _solidElevated : Colors.white.withValues(alpha: 0.03);

  /// Chat message bubble background (flyer `surfaceContainer`).
  Color get bubbleBg =>
      isSolid ? _solidElevated : Colors.white.withValues(alpha: 0.06);

  /// Lower-emphasis bubble background (flyer `surfaceContainerLow`).
  Color get bubbleBgLow =>
      isSolid ? _solidBubbleLow : Colors.white.withValues(alpha: 0.04);

  /// Strong border / stroke around panels.
  Color get border =>
      isSolid ? _solidStroke : Colors.white.withValues(alpha: 0.12);

  /// Subtle divider hairline.
  Color get hairline =>
      isSolid ? _solidHairline : Colors.white.withValues(alpha: 0.08);

  /// Accent used for selected affordances. Solid mode prefers the design green
  /// so selected pills/borders match the ROI card; transparent keeps the user's
  /// accent color.
  Color get selectionAccent => isSolid ? _designGreen : accent;

  Color get textPrimary => Colors.white.withValues(alpha: 0.92);
  Color get textMuted =>
      isSolid ? _solidMuted : Colors.white.withValues(alpha: 0.55);
  Color get textDim =>
      isSolid ? _solidDim : Colors.white.withValues(alpha: 0.35);

  /// Corner radius for panels/cards.
  double get radius => isSolid ? 12 : 8;

  /// Drop shadow under floating panels (none in transparent mode).
  List<BoxShadow> get shadow => isSolid
      ? const [
          BoxShadow(
              color: Color(0x33000000), blurRadius: 24, offset: Offset(0, 4)),
          BoxShadow(
              color: Color(0x1A000000), blurRadius: 6, offset: Offset(0, 2)),
        ]
      : const [];

  /// Composer (chat input) surfaces.
  Color get composerBg =>
      isSolid ? _solidPanel : Colors.black.withValues(alpha: 0.85);
  Color get inputFill =>
      isSolid ? _solidElevated : Colors.black.withValues(alpha: 0.6);
}
