import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Gates the post-install feature tour (`ui/tour/onboarding_tour.dart`).
///
/// The tour is the feature walkthrough that runs *after* the first-run setup
/// wizard (`FirstRunService`) has written `~/.sinain/.env` and the app has
/// relaunched. It teaches what the product does; setup grants/permissions are a
/// separate concern handled upstream by the wizard + the macOS prompts.
///
/// Why a persisted "pending" flag instead of an in-session callback: when the
/// wizard finishes it calls `relaunchApp()`, so any flag armed in the wizard's
/// process is gone by the time the HUD boots. `FirstRunService.completeSetup`
/// therefore writes `feature_tour_pending=true`; this service reads it on the
/// *next* launch. That also cleanly distinguishes a brand-new user (pending set)
/// from an existing user upgrading into this build (pending never set) — only
/// the former sees the tour.
class FeatureTourService extends ChangeNotifier {
  static const _keyPending = 'feature_tour_pending';
  static const _keyComplete = 'feature_tour_complete';

  late SharedPreferences _prefs;
  bool _pending = false;
  bool _complete = false;
  bool _initialized = false;

  bool get initialized => _initialized;

  /// True when a fresh setup just completed and the tour hasn't been seen yet.
  bool get needsTour => _pending && !_complete;

  Future<void> init() async {
    _prefs = await SharedPreferences.getInstance();
    _pending = _prefs.getBool(_keyPending) ?? false;
    _complete = _prefs.getBool(_keyComplete) ?? false;

    // QA / preview override: `SINAIN_FORCE_TOUR=1` arms the tour on any
    // launch. Checked both as a process env var (works for a packaged app
    // launched from a shell) and as a compile-time define — `flutter run
    // --dart-define=SINAIN_FORCE_TOUR=1` — because the flutter tool launches
    // the macOS app without passing its shell environment through.
    const defined = String.fromEnvironment('SINAIN_FORCE_TOUR');
    final force = Platform.environment['SINAIN_FORCE_TOUR'];
    if (defined == '1' ||
        defined == 'true' ||
        force == '1' ||
        force == 'true') {
      _pending = true;
      _complete = false;
    }

    _initialized = true;
    notifyListeners();
  }

  /// Mark the tour seen — clears the pending flag so it never reappears.
  Future<void> complete() async {
    _complete = true;
    _pending = false;
    await _prefs.setBool(_keyComplete, true);
    await _prefs.remove(_keyPending);
    notifyListeners();
  }
}
