/// HUD-wide constants
class HudConstants {
  HudConstants._();

  /// Monospace font — JetBrains Mono if bundled, falls back to system mono
  static const String monoFont = 'JetBrainsMono';

  /// Fallback monospace fonts for the theme
  static const List<String> monoFontFallbacks = [
    'SF Mono',
    'Menlo',
    'Monaco',
    'Courier New',
    'monospace',
  ];

  static const int maxFeedItems = 50;
  static const double feedFontSize = 12.0;
  static const double tickerHeight = 24.0;
  static const double statusBarHeight = 20.0;
  static const double backgroundOpacity = 0.85;

  /// Experience survey (GitHub discussion) — the one-time "Was that helpful?"
  /// poll links here.
  static const String feedbackSurveyUrl =
      'https://github.com/anthillnet/sinain-hud/discussions/231';

  /// Report an issue (GitHub) — the always-available "Send feedback" entries
  /// in the eye menu and Display settings link here.
  static const String feedbackIssueUrl =
      'https://github.com/anthillnet/sinain-hud/issues/new';
}
