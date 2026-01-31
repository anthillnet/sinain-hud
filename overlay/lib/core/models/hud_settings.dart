enum DisplayMode { feed, alert, minimal, hidden }

class HudSettings {
  DisplayMode displayMode;
  bool clickThrough;
  bool privacyMode;
  String wsUrl;

  HudSettings({
    this.displayMode = DisplayMode.feed,
    this.clickThrough = true,
    this.privacyMode = true,
    this.wsUrl = 'ws://localhost:9500',
  });

  DisplayMode get nextDisplayMode {
    const modes = DisplayMode.values;
    final idx = modes.indexOf(displayMode);
    return modes[(idx + 1) % modes.length];
  }

  HudSettings copyWith({
    DisplayMode? displayMode,
    bool? clickThrough,
    bool? privacyMode,
    String? wsUrl,
  }) {
    return HudSettings(
      displayMode: displayMode ?? this.displayMode,
      clickThrough: clickThrough ?? this.clickThrough,
      privacyMode: privacyMode ?? this.privacyMode,
      wsUrl: wsUrl ?? this.wsUrl,
    );
  }
}
