import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/hud_settings.dart';

/// Persists HUD settings using shared_preferences.
class SettingsService extends ChangeNotifier {
  static const _keyDisplayMode = 'display_mode';
  static const _keyActiveTab = 'active_tab';
  static const _keyClickThrough = 'click_through';
  static const _keyPrivacyMode = 'privacy_mode';
  static const _keyWsUrl = 'ws_url';

  late SharedPreferences _prefs;
  HudSettings _settings = HudSettings();

  HudSettings get settings => _settings;

  Future<void> init() async {
    _prefs = await SharedPreferences.getInstance();
    _settings = HudSettings(
      displayMode: _loadDisplayMode(),
      activeTab: _loadActiveTab(),
      clickThrough: _prefs.getBool(_keyClickThrough) ?? true,
      privacyMode: _prefs.getBool(_keyPrivacyMode) ?? true,
      wsUrl: _prefs.getString(_keyWsUrl) ?? 'ws://localhost:9500',
    );
    notifyListeners();
  }

  DisplayMode _loadDisplayMode() {
    final val = _prefs.getString(_keyDisplayMode);
    return DisplayMode.values.firstWhere(
      (m) => m.name == val,
      orElse: () => DisplayMode.feed,
    );
  }

  HudTab _loadActiveTab() {
    final val = _prefs.getString(_keyActiveTab);
    return HudTab.values.firstWhere(
      (t) => t.name == val,
      orElse: () => HudTab.stream,
    );
  }

  Future<void> setDisplayMode(DisplayMode mode) async {
    _settings.displayMode = mode;
    await _prefs.setString(_keyDisplayMode, mode.name);
    notifyListeners();
  }

  Future<void> cycleDisplayMode() async {
    await setDisplayMode(_settings.nextDisplayMode);
  }

  Future<void> setActiveTab(HudTab tab) async {
    _settings.activeTab = tab;
    await _prefs.setString(_keyActiveTab, tab.name);
    notifyListeners();
  }

  Future<void> cycleTab() async {
    await setActiveTab(_settings.nextTab);
  }

  Future<void> setClickThrough(bool value) async {
    _settings.clickThrough = value;
    await _prefs.setBool(_keyClickThrough, value);
    notifyListeners();
  }

  Future<void> toggleClickThrough() async {
    await setClickThrough(!_settings.clickThrough);
  }

  Future<void> setPrivacyMode(bool value) async {
    _settings.privacyMode = value;
    await _prefs.setBool(_keyPrivacyMode, value);
    notifyListeners();
  }

  Future<void> setWsUrl(String url) async {
    _settings.wsUrl = url;
    await _prefs.setString(_keyWsUrl, url);
    notifyListeners();
  }
}
