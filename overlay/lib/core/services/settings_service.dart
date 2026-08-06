import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/hud_settings.dart';

/// Persists HUD settings using shared_preferences.
class SettingsService extends ChangeNotifier {
  static const _keyHudState = 'overlay_state';
  static const _keyActiveTab = 'active_tab';
  static const _keyPrivacyMode = 'privacy_mode';
  static const _keyWsUrl = 'ws_url';
  static const _keyEyeX = 'eye_x';
  static const _keyEyeY = 'eye_y';
  static const _keyNotchParked = 'notch_parked';
  static const _keyDetachedEye = 'detached_eye_visible';
  static const _keyChatWidth = 'chat_width';
  static const _keyChatHeight = 'chat_height';
  static const _keyFontSize = 'font_size';
  static const _keyAccentColor = 'accent_color';
  static const _keyAutoDetectIssues = 'auto_detect_issues';
  static const _keyAgentLlmBrief = 'agent_llm_brief';
  static const _keyChatgptHarness = 'chatgpt_harness';
  // NB: shared_preferences stores this under UserDefaults key
  // "flutter.show_in_dock" — AppDelegate reads it natively at launch to set the
  // activation policy with no Dock-icon flash. Keep the string in sync.
  static const _keyShowInDock = 'show_in_dock';
  static const _keyHudStyle = 'hud_style';
  static const _keyAutoUpdateCheck = 'auto_update_check';
  static const _keyFeedbackStatus = 'feedback_status';
  static const _keyFeedbackSnoozeUntil = 'feedback_snooze_until';
  static const _keyFeedbackAskCount = 'feedback_ask_count';

  late SharedPreferences _prefs;
  HudSettings _settings = HudSettings();

  HudSettings get settings => _settings;

  Future<void> init() async {
    _prefs = await SharedPreferences.getInstance();
    _settings = HudSettings(
      overlayState: _loadHudState(),
      activeTab: _loadActiveTab(),
      privacyMode: _prefs.getBool(_keyPrivacyMode) ?? true,
      wsUrl: _prefs.getString(_keyWsUrl) ?? 'ws://localhost:9500',
      eyeX: _prefs.getDouble(_keyEyeX) ?? -1,
      eyeY: _prefs.getDouble(_keyEyeY) ?? -1,
      notchParked: _prefs.getBool(_keyNotchParked) ?? false,
      detachedEyeVisible: _prefs.getBool(_keyDetachedEye) ?? false,
      chatWidth: _prefs.getDouble(_keyChatWidth) ?? 427,
      chatHeight: _prefs.getDouble(_keyChatHeight) ?? 220,
      fontSize: _prefs.getDouble(_keyFontSize) ?? 12.0,
      accentColor: _prefs.getInt(_keyAccentColor) ?? 0xFF00FF88,
      autoDetectIssues: _prefs.getBool(_keyAutoDetectIssues) ?? false,
      agentLlmBrief: _prefs.getBool(_keyAgentLlmBrief) ?? true,
      chatgptHarness: _prefs.getBool(_keyChatgptHarness) ?? false,
      showInDock: _prefs.getBool(_keyShowInDock) ?? true,
      hudStyle: _loadHudStyle(),
      autoUpdateCheck: _prefs.getBool(_keyAutoUpdateCheck) ?? true,
      feedbackStatus: _loadFeedbackStatus(),
      feedbackSnoozeUntilMs: _prefs.getInt(_keyFeedbackSnoozeUntil) ?? 0,
      feedbackAskCount: _prefs.getInt(_keyFeedbackAskCount) ?? 0,
    );
    notifyListeners();
  }

  HudStyle _loadHudStyle() {
    final val = _prefs.getString(_keyHudStyle);
    return HudStyle.values.firstWhere(
      (s) => s.name == val,
      orElse: () => HudStyle.solid,
    );
  }

  FeedbackPromptStatus _loadFeedbackStatus() {
    final val = _prefs.getString(_keyFeedbackStatus);
    return FeedbackPromptStatus.values.firstWhere(
      (s) => s.name == val,
      orElse: () => FeedbackPromptStatus.pending,
    );
  }

  HudState _loadHudState() {
    final val = _prefs.getString(_keyHudState);
    // Removed/disabled modes coerce so an upgrading user never boots into a
    // state that no longer has a path back out:
    //  - 'hidden' (removed 2026-07-31) → eye, which on macOS always parks in
    //    the notch. Old installs persisted it via the retired ⌘⇧Space toggle
    //    and then booted fully invisible.
    //  - 'controls' (middle mode, disabled) → chat.
    final state = HudState.values.firstWhere(
      (s) => s.name == val,
      orElse: () => HudState.eye,
    );
    return state == HudState.controls ? HudState.chat : state;
  }

  HudTab _loadActiveTab() {
    final val = _prefs.getString(_keyActiveTab);
    return HudTab.values.firstWhere(
      (t) => t.name == val,
      orElse: () => HudTab.agent,
    );
  }

  Future<void> setHudState(HudState state) async {
    _settings.overlayState = state;
    await _prefs.setString(_keyHudState, state.name);
    notifyListeners();
  }

  Future<void> setActiveTab(HudTab tab) async {
    _settings.activeTab = tab;
    await _prefs.setString(_keyActiveTab, tab.name);
    notifyListeners();
  }

  Future<void> cycleTab() async {
    await setActiveTab(_settings.nextTab);
  }

  Future<void> setPrivacyMode(bool value) async {
    _settings.privacyMode = value;
    await _prefs.setBool(_keyPrivacyMode, value);
    notifyListeners();
  }

  void setPrivacyModeTransient(bool value) {
    _settings.privacyMode = value;
    notifyListeners();
  }

  Future<void> setEyePosition(double x, double y) async {
    _settings.eyeX = x;
    _settings.eyeY = y;
    await _prefs.setDouble(_keyEyeX, x);
    await _prefs.setDouble(_keyEyeY, y);
    // Don't notify — position updates are high frequency during drag
  }

  Future<void> setNotchParked(bool value) async {
    _settings.notchParked = value;
    await _prefs.setBool(_keyNotchParked, value);
  }

  Future<void> setDetachedEyeVisible(bool value) async {
    _settings.detachedEyeVisible = value;
    await _prefs.setBool(_keyDetachedEye, value);
  }

  Future<void> setChatSize(double w, double h) async {
    _settings.chatWidth = w;
    _settings.chatHeight = h;
    await _prefs.setDouble(_keyChatWidth, w);
    await _prefs.setDouble(_keyChatHeight, h);
  }

  Future<void> setWsUrl(String url) async {
    _settings.wsUrl = url;
    await _prefs.setString(_keyWsUrl, url);
    notifyListeners();
  }

  Future<void> setFontSize(double size) async {
    _settings.fontSize = size.clamp(8.0, 24.0);
    await _prefs.setDouble(_keyFontSize, _settings.fontSize);
    notifyListeners();
  }

  Future<void> setAccentColor(int argb) async {
    _settings.accentColor = argb;
    await _prefs.setInt(_keyAccentColor, argb);
    notifyListeners();
  }

  Future<void> setAutoDetectIssues(bool value) async {
    _settings.autoDetectIssues = value;
    await _prefs.setBool(_keyAutoDetectIssues, value);
    notifyListeners();
  }

  Future<void> setAgentLlmBrief(bool value) async {
    _settings.agentLlmBrief = value;
    await _prefs.setBool(_keyAgentLlmBrief, value);
    notifyListeners();
  }

  Future<void> setChatgptHarness(bool value) async {
    _settings.chatgptHarness = value;
    await _prefs.setBool(_keyChatgptHarness, value);
    notifyListeners();
  }

  Future<void> setShowInDock(bool value) async {
    _settings.showInDock = value;
    await _prefs.setBool(_keyShowInDock, value);
    notifyListeners();
  }

  Future<void> setAutoUpdateCheck(bool value) async {
    _settings.autoUpdateCheck = value;
    await _prefs.setBool(_keyAutoUpdateCheck, value);
    notifyListeners();
  }

  Future<void> setHudStyle(HudStyle style) async {
    _settings.hudStyle = style;
    await _prefs.setString(_keyHudStyle, style.name);
    notifyListeners();
  }

  /// Persist the feedback prompt lifecycle. [snoozeUntilMs] and [askCount] are
  /// optional — pass them when "Later" advances the re-arm time / ask count.
  Future<void> setFeedbackState(
    FeedbackPromptStatus status, {
    int? snoozeUntilMs,
    int? askCount,
  }) async {
    _settings.feedbackStatus = status;
    await _prefs.setString(_keyFeedbackStatus, status.name);
    if (snoozeUntilMs != null) {
      _settings.feedbackSnoozeUntilMs = snoozeUntilMs;
      await _prefs.setInt(_keyFeedbackSnoozeUntil, snoozeUntilMs);
    }
    if (askCount != null) {
      _settings.feedbackAskCount = askCount;
      await _prefs.setInt(_keyFeedbackAskCount, askCount);
    }
    notifyListeners();
  }
}
