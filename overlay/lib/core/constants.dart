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
}
