/// The 3 visible states of the overlay widget (plus hidden).
enum HudState { eye, controls, chat, hidden }

enum HudTab { agent, tasks }

/// Presentation style for the HUD's panels.
///
/// [solid] (the default) renders panels as opaque dark cards, matching the
/// design system already used by the native ROI card and the agent selector.
/// [transparent] is the original see-through HUD (translucent black over the
/// transparent macOS window). The eye stays see-through regardless. See
/// `core/theme/hud_theme.dart`.
enum HudStyle { transparent, solid }

class HudSettings {
  HudState overlayState;
  HudTab activeTab;
  bool privacyMode;
  String wsUrl;

  /// Persisted eye position (screen coordinates, bottom-left origin on macOS).
  double eyeX;
  double eyeY;

  /// Persisted chat panel size.
  double chatWidth;
  double chatHeight;

  /// Display settings.
  double fontSize;
  int accentColor;

  /// Grammarly mode: show clickable region eyes at actionable screen areas.
  bool autoDetectIssues;

  /// ChatGPT network harness: expose the local MCP server over a public tunnel
  /// so ChatGPT can pull ROI context. Off by default — security-sensitive.
  bool chatgptHarness;

  /// Show a Dock icon (and app menu bar). On by default; users who want the
  /// ambient/invisible feel can opt out, dropping the app back to an accessory
  /// (NSApplicationActivationPolicy.accessory — the LSUIElement behavior).
  bool showInDock;

  /// Panel presentation style (solid cards vs see-through). Defaults to solid.
  HudStyle hudStyle;

  HudSettings({
    this.overlayState = HudState.chat,
    this.activeTab = HudTab.agent,
    this.privacyMode = true,
    this.wsUrl = 'ws://localhost:9500',
    this.eyeX = -1, // -1 means "use default position"
    this.eyeY = -1,
    this.chatWidth = 427,
    this.chatHeight = 293,
    this.fontSize = 12.0,
    this.accentColor = 0xFF00FF88,
    this.autoDetectIssues = false,
    this.chatgptHarness = false,
    this.showInDock = true,
    this.hudStyle = HudStyle.solid,
  });

  HudTab get nextTab {
    const tabs = HudTab.values;
    final idx = tabs.indexOf(activeTab);
    return tabs[(idx + 1) % tabs.length];
  }

  HudSettings copyWith({
    HudState? overlayState,
    HudTab? activeTab,
    bool? privacyMode,
    String? wsUrl,
    double? eyeX,
    double? eyeY,
    double? chatWidth,
    double? chatHeight,
    double? fontSize,
    int? accentColor,
    bool? autoDetectIssues,
    bool? chatgptHarness,
    bool? showInDock,
    HudStyle? hudStyle,
  }) {
    return HudSettings(
      overlayState: overlayState ?? this.overlayState,
      activeTab: activeTab ?? this.activeTab,
      privacyMode: privacyMode ?? this.privacyMode,
      wsUrl: wsUrl ?? this.wsUrl,
      eyeX: eyeX ?? this.eyeX,
      eyeY: eyeY ?? this.eyeY,
      chatWidth: chatWidth ?? this.chatWidth,
      chatHeight: chatHeight ?? this.chatHeight,
      fontSize: fontSize ?? this.fontSize,
      accentColor: accentColor ?? this.accentColor,
      autoDetectIssues: autoDetectIssues ?? this.autoDetectIssues,
      chatgptHarness: chatgptHarness ?? this.chatgptHarness,
      showInDock: showInDock ?? this.showInDock,
      hudStyle: hudStyle ?? this.hudStyle,
    );
  }
}
