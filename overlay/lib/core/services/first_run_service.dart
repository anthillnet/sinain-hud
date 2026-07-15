import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../ui/first_run/install_tier.dart';

/// SEED-001 Stage 5 — first-run setup for the packaged app.
///
/// The overlay is the entry point and there is no CLI `sinain onboard` to write
/// `~/.sinain/.env`. This service shows the first-run wizard whenever there is
/// no config yet (a fresh install on a clean machine), writes the env from the
/// wizard's choices, and relaunches so the backend picks up the config.
///
/// The wizard gate is purely "no `~/.sinain/.env` yet." We deliberately do NOT
/// gate on a bundled-vs-dev (`isBundled`) check: that check round-tripped to the
/// `sinain_hud/backend` platform channel, which the Flutter engine queried
/// (during awakeFromNib) before AppDelegate.applicationDidFinishLaunching
/// registered its handler — so it raced, threw MissingPluginException, was
/// swallowed to false, and the wizard silently never ran on real installs.
/// Removing it makes the wizard run on every fresh install, deterministically.
class FirstRunService extends ChangeNotifier {
  static const _channel = MethodChannel('sinain_hud/backend');

  // Checkpoint keys. Granting Screen Recording in System Settings makes macOS
  // offer to quit-and-reopen Sinain so the new permission takes effect. That
  // relaunch happens *mid-wizard* (before `~/.sinain/.env` exists), so without
  // a checkpoint the wizard would restart at Welcome and drop the user's tier +
  // key. We persist just enough to resume at the permission step. Cleared once
  // setup completes; the user's key only lives here transiently (it's about to
  // be written to `.env` in plaintext anyway).
  static const _keyResumePermission = 'first_run_resume_permission';
  static const _keyResumeTier = 'first_run_resume_tier';
  static const _keyResumeKey = 'first_run_resume_key';
  static const _keyResumeCerebras = 'first_run_resume_cerebras';

  bool _envExists = false;
  bool _initialized = false;
  bool _completed = false;

  bool _resumeAtPermission = false;
  InstallTier? _resumeTier;
  String? _resumeKey;
  String? _resumeCerebrasKey;

  /// QA / preview override: `SINAIN_WIZARD_PREVIEW=1` forces the wizard to show
  /// on a machine that already has `~/.sinain/.env`, and makes [completeSetup]
  /// non-destructive (no env write, no backend relaunch). Mirrors the tour's
  /// `SINAIN_FORCE_TOUR` hook. Resolved in [init].
  bool _previewMode = false;

  bool get initialized => _initialized;

  /// True when there's no config yet → run the first-run wizard. Once setup
  /// writes `~/.sinain/.env`, this is false and the wizard won't re-run.
  /// In preview mode the env-existence check is bypassed so the wizard always
  /// shows until it's stepped through.
  bool get needsSetup => (_previewMode || !_envExists) && !_completed;

  /// When a permission-step checkpoint survived a macOS relaunch, the wizard
  /// jumps straight back to the Screen Recording step with these restored.
  bool get resumeAtPermission => _resumeAtPermission;
  InstallTier? get resumeTier => _resumeTier;
  String? get resumeKey => _resumeKey;
  String? get resumeCerebrasKey => _resumeCerebrasKey;

  String get _envPath {
    final home = Platform.environment['HOME'] ?? '';
    return '$home/.sinain/.env';
  }

  Future<void> init() async {
    final preview = Platform.environment['SINAIN_WIZARD_PREVIEW'];
    _previewMode = preview == '1' || preview == 'true';
    _envExists = await File(_envPath).exists();
    // Only honour a checkpoint while the wizard would actually run (no env yet).
    if (!_envExists) {
      final prefs = await SharedPreferences.getInstance();
      _resumeAtPermission = prefs.getBool(_keyResumePermission) ?? false;
      if (_resumeAtPermission) {
        final tierIdx = prefs.getInt(_keyResumeTier);
        if (tierIdx != null && tierIdx >= 0 && tierIdx < InstallTier.values.length) {
          _resumeTier = InstallTier.values[tierIdx];
        }
        _resumeKey = prefs.getString(_keyResumeKey);
        _resumeCerebrasKey = prefs.getString(_keyResumeCerebras);
        // A checkpoint with no tier is unusable — discard it.
        if (_resumeTier == null) _resumeAtPermission = false;
      }
    }
    _initialized = true;
    notifyListeners();
  }

  /// Persist the wizard's choices before triggering the Screen Recording prompt,
  /// so the flow resumes at the permission step if macOS relaunches Sinain to
  /// apply the grant. Safe to call repeatedly.
  Future<void> savePermissionCheckpoint(
    InstallTier tier, {
    String? openRouterKey,
    String? cerebrasKey,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_keyResumePermission, true);
    await prefs.setInt(_keyResumeTier, tier.index);
    if (openRouterKey != null && openRouterKey.isNotEmpty) {
      await prefs.setString(_keyResumeKey, openRouterKey);
    } else {
      await prefs.remove(_keyResumeKey);
    }
    if (cerebrasKey != null && cerebrasKey.isNotEmpty) {
      await prefs.setString(_keyResumeCerebras, cerebrasKey);
    } else {
      await prefs.remove(_keyResumeCerebras);
    }
  }

  Future<void> _clearCheckpoint() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_keyResumePermission);
    await prefs.remove(_keyResumeTier);
    await prefs.remove(_keyResumeKey);
    await prefs.remove(_keyResumeCerebras);
  }

  /// Persist the wizard's choices to `~/.sinain/.env`, then relaunch the app so
  /// it boots through the normal startup path with config present. Relaunch is
  /// more robust than an in-place handoff (correct window sizing + key window).
  Future<void> completeSetup(InstallTier tier,
      {String? openRouterKey, String? cerebrasKey}) async {
    // Preview mode: show the finish screen and dismiss the wizard WITHOUT
    // touching `~/.sinain/.env` or relaunching (which would run stop.sh and
    // tear down a live dev stack). Lets `SINAIN_WIZARD_PREVIEW=1` step the whole
    // flow safely on a configured machine.
    if (_previewMode) {
      await _clearCheckpoint();
      _completed = true;
      notifyListeners();
      return;
    }
    final vars = _envForTier(tier,
        openRouterKey: openRouterKey, cerebrasKey: cerebrasKey);
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
    // Setup finished — the permission checkpoint is no longer needed.
    await _clearCheckpoint();
    _envExists = true;
    _completed = true;
    notifyListeners();
    await relaunchApp();
  }

  /// Map a tier choice to env vars — mirrors sinain-hud-plugin/onboard.js so the
  /// GUI and CLI wizards produce identical config (see docs/dmg-distribution-spec.md §1).
  Map<String, String> _envForTier(InstallTier tier,
      {String? openRouterKey, String? cerebrasKey}) {
    final key = (openRouterKey ?? '').trim();
    // Optional Cerebras key: powers the burst lane (Save/Call context cards,
    // range previews, call seeds). Cloud tiers only — omitted when blank so
    // the burst lane simply stays off.
    final cerebras = (cerebrasKey ?? '').trim();
    switch (tier) {
      case InstallTier.cloudOnly:
        return {
          'OPENROUTER_API_KEY': key,
          if (cerebras.isNotEmpty) 'CEREBRAS_API_KEY': cerebras,
          'TRANSCRIPTION_BACKEND': 'openrouter',
          'PRIVACY_MODE': 'standard',
        };
      case InstallTier.cloudPlusLocalWhisper:
        return {
          'OPENROUTER_API_KEY': key,
          if (cerebras.isNotEmpty) 'CEREBRAS_API_KEY': cerebras,
          'TRANSCRIPTION_BACKEND': 'local',
          'LOCAL_WHISPER_MODEL': '~/.sinain/models/whisper/ggml-large-v3-turbo.bin',
          'PRIVACY_MODE': 'standard',
        };
      case InstallTier.fullLocal:
        return {
          'SINAIN_LOCAL_MODE': 'true',
          // qwen2.5vl:7b serves BOTH text and vision lanes — best local
          // distill quality of the models benched 2026-07-15, one residency.
          'SINAIN_LOCAL_LLM': 'qwen2.5vl:7b',
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
