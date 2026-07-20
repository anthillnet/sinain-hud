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

/// Lifecycle of the one-time "Was that helpful?" feedback prompt.
///
/// [pending] — never shown; eligible to fire at the first value-proof moment.
/// [snoozed] — user tapped "Later"; re-arms once [feedbackSnoozeUntilMs] passes.
/// [retired] — answered or dismissed for good; never shows again.
enum FeedbackPromptStatus { pending, snoozed, retired }

class HudSettings {
  HudState overlayState;
  HudTab activeTab;
  bool privacyMode;
  String wsUrl;

  /// Persisted eye position (screen coordinates, bottom-left origin on macOS).
  double eyeX;
  double eyeY;

  /// Whether the eye was last parked at the display notch.
  /// Vestigial since the always-park invariant (eye state ⇒ notch): kept so a
  /// downgrade still restores sensibly. [eyeX]/[eyeY] now mean the detached
  /// eye's position.
  bool notchParked;

  /// Whether the user dragged a free-floating eye out of the notch — the
  /// detached eye lives at [eyeX]/[eyeY] while the island stays parked.
  bool detachedEyeVisible;

  /// Persisted chat panel size.
  double chatWidth;
  double chatHeight;

  /// Display settings.
  double fontSize;
  int accentColor;

  /// Grammarly mode: show clickable region eyes at actionable screen areas.
  bool autoDetectIssues;

  /// Add an LLM-composed Build-Context section when an agent session starts.
  bool agentLlmBrief;

  /// ChatGPT network harness: expose the local MCP server over a public tunnel
  /// so ChatGPT can pull ROI context. Off by default — security-sensitive.
  bool chatgptHarness;

  /// Show a Dock icon (and app menu bar). On by default; users who want the
  /// ambient/invisible feel can opt out, dropping the app back to an accessory
  /// (NSApplicationActivationPolicy.accessory — the LSUIElement behavior).
  bool showInDock;

  /// Panel presentation style (solid cards vs see-through). Defaults to solid.
  HudStyle hudStyle;

  /// Auto-update: check for new releases daily and download them in the
  /// background (the swap still waits for an explicit restart). Off = never
  /// phone home for updates; paranoid/full-local modes imply off.
  bool autoUpdateCheck;

  /// One-time feedback prompt state (see [FeedbackPromptStatus]).
  FeedbackPromptStatus feedbackStatus;

  /// Epoch ms after which a [FeedbackPromptStatus.snoozed] prompt re-arms.
  int feedbackSnoozeUntilMs;

  /// How many times the prompt has been shown. Capped at 2.
  int feedbackAskCount;

  HudSettings({
    this.overlayState = HudState.chat,
    this.activeTab = HudTab.agent,
    this.privacyMode = true,
    this.wsUrl = 'ws://localhost:9500',
    this.eyeX = -1, // -1 means "use default position"
    this.eyeY = -1,
    this.notchParked = false,
    this.detachedEyeVisible = false,
    this.chatWidth = 427,
    this.chatHeight = 293,
    this.fontSize = 12.0,
    this.accentColor = 0xFF00FF88,
    this.autoDetectIssues = false,
    this.agentLlmBrief = true,
    this.chatgptHarness = false,
    this.showInDock = true,
    this.hudStyle = HudStyle.solid,
    this.autoUpdateCheck = true,
    this.feedbackStatus = FeedbackPromptStatus.pending,
    this.feedbackSnoozeUntilMs = 0,
    this.feedbackAskCount = 0,
  });

  /// Max times the prompt is ever shown.
  static const int feedbackMaxAsks = 2;

  /// Whether the feedback prompt may fire right now. True when it hasn't been
  /// retired, is under the ask cap, and is either fresh ([pending]) or a
  /// [snoozed] prompt whose re-arm time ([feedbackSnoozeUntilMs]) has passed.
  bool feedbackEligible(int nowMs) {
    if (feedbackStatus == FeedbackPromptStatus.retired) return false;
    if (feedbackAskCount >= feedbackMaxAsks) return false;
    if (feedbackStatus == FeedbackPromptStatus.snoozed) {
      return nowMs >= feedbackSnoozeUntilMs;
    }
    return true; // pending
  }

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
    bool? notchParked,
    bool? detachedEyeVisible,
    double? chatWidth,
    double? chatHeight,
    double? fontSize,
    int? accentColor,
    bool? autoDetectIssues,
    bool? agentLlmBrief,
    bool? chatgptHarness,
    bool? showInDock,
    HudStyle? hudStyle,
    bool? autoUpdateCheck,
    FeedbackPromptStatus? feedbackStatus,
    int? feedbackSnoozeUntilMs,
    int? feedbackAskCount,
  }) {
    return HudSettings(
      overlayState: overlayState ?? this.overlayState,
      activeTab: activeTab ?? this.activeTab,
      privacyMode: privacyMode ?? this.privacyMode,
      wsUrl: wsUrl ?? this.wsUrl,
      eyeX: eyeX ?? this.eyeX,
      eyeY: eyeY ?? this.eyeY,
      notchParked: notchParked ?? this.notchParked,
      detachedEyeVisible: detachedEyeVisible ?? this.detachedEyeVisible,
      chatWidth: chatWidth ?? this.chatWidth,
      chatHeight: chatHeight ?? this.chatHeight,
      fontSize: fontSize ?? this.fontSize,
      accentColor: accentColor ?? this.accentColor,
      autoDetectIssues: autoDetectIssues ?? this.autoDetectIssues,
      agentLlmBrief: agentLlmBrief ?? this.agentLlmBrief,
      chatgptHarness: chatgptHarness ?? this.chatgptHarness,
      showInDock: showInDock ?? this.showInDock,
      hudStyle: hudStyle ?? this.hudStyle,
      autoUpdateCheck: autoUpdateCheck ?? this.autoUpdateCheck,
      feedbackStatus: feedbackStatus ?? this.feedbackStatus,
      feedbackSnoozeUntilMs:
          feedbackSnoozeUntilMs ?? this.feedbackSnoozeUntilMs,
      feedbackAskCount: feedbackAskCount ?? this.feedbackAskCount,
    );
  }
}
