enum DisplayMode { feed, alert, minimal, hidden }

enum HudTab { stream, agent }

class HudSettings {
  DisplayMode displayMode;
  HudTab activeTab;
  bool clickThrough;
  bool privacyMode;
  String wsUrl;

  HudSettings({
    this.displayMode = DisplayMode.feed,
    this.activeTab = HudTab.stream,
    this.clickThrough = true,
    this.privacyMode = true,
    this.wsUrl = 'ws://localhost:9500',
  });

  DisplayMode get nextDisplayMode {
    const modes = DisplayMode.values;
    final idx = modes.indexOf(displayMode);
    return modes[(idx + 1) % modes.length];
  }

  HudTab get nextTab {
    const tabs = HudTab.values;
    final idx = tabs.indexOf(activeTab);
    return tabs[(idx + 1) % tabs.length];
  }

  HudSettings copyWith({
    DisplayMode? displayMode,
    HudTab? activeTab,
    bool? clickThrough,
    bool? privacyMode,
    String? wsUrl,
  }) {
    return HudSettings(
      displayMode: displayMode ?? this.displayMode,
      activeTab: activeTab ?? this.activeTab,
      clickThrough: clickThrough ?? this.clickThrough,
      privacyMode: privacyMode ?? this.privacyMode,
      wsUrl: wsUrl ?? this.wsUrl,
    );
  }
}
