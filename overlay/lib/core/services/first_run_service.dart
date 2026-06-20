import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../ui/first_run/install_tier.dart';

/// SEED-001 Stage 5 — first-run setup for the packaged DMG build.
///
/// In a bundled .app the overlay is the entry point and there is no CLI
/// `sinain onboard` to write `~/.sinain/.env`. This service detects the
/// first-run condition (bundled app + no env file), writes the env from the
/// wizard's choices, and restarts the bundled backend so it picks up the config.
///
/// In development (`flutter run`) `isBundled` is false, so [needsSetup] is
/// always false and the existing OnboardingService flow is untouched.
class FirstRunService extends ChangeNotifier {
  static const _channel = MethodChannel('sinain_hud/backend');

  bool _bundled = false;
  bool _envExists = false;
  bool _initialized = false;
  bool _completed = false;

  bool get initialized => _initialized;

  /// True when the packaged app has no config yet and should show the wizard.
  bool get needsSetup => _bundled && !_envExists && !_completed;

  String get _envPath {
    final home = Platform.environment['HOME'] ?? '';
    return '$home/.sinain/.env';
  }

  Future<void> init() async {
    try {
      _bundled = await _channel.invokeMethod<bool>('isBundled') ?? false;
    } on PlatformException {
      _bundled = false; // dev / non-macOS — channel not wired
    } on MissingPluginException {
      _bundled = false;
    }
    _envExists = await File(_envPath).exists();
    _initialized = true;
    notifyListeners();
  }

  /// Persist the wizard's choices to `~/.sinain/.env`, then relaunch the app so
  /// it boots through the normal startup path with config present. Relaunch is
  /// more robust than an in-place handoff (correct window sizing + key window).
  Future<void> completeSetup(InstallTier tier, {String? openRouterKey}) async {
    final vars = _envForTier(tier, openRouterKey: openRouterKey);
    await _writeEnv(vars);
    // Mark the legacy OnboardingService complete too — this wizard already
    // collected the key, so the old connecting/permissions/orientation flow is
    // redundant and would otherwise trap the user after relaunch.
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('onboarding_complete', true);
    // Arm the post-install feature tour. We relaunch right after this, so the
    // tour can't be triggered in-process — FeatureTourService reads this flag
    // on the next boot. See feature_tour_service.dart for why it's persisted.
    await prefs.setBool('feature_tour_pending', true);
    _envExists = true;
    _completed = true;
    notifyListeners();
    await relaunchApp();
  }

  /// Map a tier choice to env vars — mirrors sinain-hud-plugin/onboard.js so the
  /// GUI and CLI wizards produce identical config (see docs/dmg-distribution-spec.md §1).
  Map<String, String> _envForTier(InstallTier tier, {String? openRouterKey}) {
    final key = (openRouterKey ?? '').trim();
    switch (tier) {
      case InstallTier.cloudOnly:
        return {
          'OPENROUTER_API_KEY': key,
          'TRANSCRIPTION_BACKEND': 'openrouter',
          'PRIVACY_MODE': 'standard',
        };
      case InstallTier.cloudPlusLocalWhisper:
        return {
          'OPENROUTER_API_KEY': key,
          'TRANSCRIPTION_BACKEND': 'local',
          'LOCAL_WHISPER_MODEL': '~/.sinain/models/whisper/ggml-large-v3-turbo.bin',
          'PRIVACY_MODE': 'standard',
        };
      case InstallTier.fullLocal:
        return {
          'SINAIN_LOCAL_MODE': 'true',
          'SINAIN_LOCAL_LLM': 'phi4-mini',
          'SINAIN_LOCAL_VISION': 'qwen2.5vl:7b',
          'TRANSCRIPTION_BACKEND': 'local',
          'LOCAL_WHISPER_MODEL': '~/.sinain/models/whisper/ggml-large-v3-turbo.bin',
          'PRIVACY_MODE': 'paranoid',
          'OPENROUTER_API_KEY': '',
        };
    }
  }

  Future<void> _writeEnv(Map<String, String> vars) async {
    final file = File(_envPath);
    await file.parent.create(recursive: true);
    final buf = StringBuffer()
      ..writeln('# Written by the Sinain first-run wizard')
      ..writeln('# Edit ~/.sinain/.env to change configuration, then restart Sinain.');
    vars.forEach((k, v) => buf.writeln('$k=$v'));
    await file.writeAsString(buf.toString());
    debugPrint('[first-run] wrote $_envPath (${vars.length} vars)');
  }

  /// Relaunch the whole app (used after first-run setup writes config).
  Future<void> relaunchApp() async {
    try {
      await _channel.invokeMethod('relaunch');
    } on PlatformException catch (e) {
      debugPrint('[first-run] relaunch failed: $e');
    }
  }

  /// Restart just the bundled backend so it reloads ~/.sinain/.env.
  Future<void> restartBackend() async {
    try {
      await _channel.invokeMethod('restart');
    } on PlatformException catch (e) {
      debugPrint('[first-run] backend restart failed: $e');
    }
  }
}
