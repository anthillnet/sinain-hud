/// The 3 visible states of the overlay widget (plus hidden).
enum HudState { eye, controls, chat, hidden }

enum HudTab { agent, tasks }

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

  HudSettings({
    this.overlayState = HudState.chat,
    this.activeTab = HudTab.agent,
    this.privacyMode = true,
    this.wsUrl = 'ws://localhost:9500',
    this.eyeX = -1, // -1 means "use default position"
    this.eyeY = -1,
    this.chatWidth = 427,
    this.chatHeight = 293,
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
    );
  }
}
