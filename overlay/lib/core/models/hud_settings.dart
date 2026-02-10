enum DisplayMode { feed, alert, minimal, hidden }

enum HudTab { stream, agent, tasks }

class HudSettings {
  DisplayMode displayMode;
  HudTab activeTab;
  bool clickThrough;
  bool privacyMode;
  bool topPosition;
  String wsUrl;

  HudSettings({
    this.displayMode = DisplayMode.feed,
    this.activeTab = HudTab.stream,
    this.clickThrough = true,
    this.privacyMode = true,
    this.topPosition = false,
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
    bool? topPosition,
    String? wsUrl,
  }) {
    return HudSettings(
      displayMode: displayMode ?? this.displayMode,
      activeTab: activeTab ?? this.activeTab,
      clickThrough: clickThrough ?? this.clickThrough,
      privacyMode: privacyMode ?? this.privacyMode,
      topPosition: topPosition ?? this.topPosition,
      wsUrl: wsUrl ?? this.wsUrl,
    );
  }
}
