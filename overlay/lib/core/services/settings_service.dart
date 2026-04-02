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
  static const _keyChatWidth = 'chat_width';
  static const _keyChatHeight = 'chat_height';
  static const _keyFontSize = 'font_size';
  static const _keyAccentColor = 'accent_color';

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
      chatWidth: _prefs.getDouble(_keyChatWidth) ?? 427,
      chatHeight: _prefs.getDouble(_keyChatHeight) ?? 293,
      fontSize: _prefs.getDouble(_keyFontSize) ?? 12.0,
      accentColor: _prefs.getInt(_keyAccentColor) ?? 0xFF00FF88,
    );
    notifyListeners();
  }

  HudState _loadHudState() {
    final val = _prefs.getString(_keyHudState);
    return HudState.values.firstWhere(
      (s) => s.name == val,
      orElse: () => HudState.eye,
    );
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
}
