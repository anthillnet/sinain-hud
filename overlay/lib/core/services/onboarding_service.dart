import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Manages the overlay onboarding flow state.
///
/// Checks whether sinain-core is connected and configured,
/// then guides the user through permissions and orientation.
class OnboardingService extends ChangeNotifier {
  static const _keyComplete = 'onboarding_complete';

  bool _isComplete = false;
  bool get isComplete => _isComplete;

  OnboardingStep _currentStep = OnboardingStep.connecting;
  OnboardingStep get currentStep => _currentStep;

  SetupStatus? _setupStatus;
  SetupStatus? get setupStatus => _setupStatus;

  bool _coreConnected = false;
  bool get coreConnected => _coreConnected;

  Timer? _pollTimer;

  Future<void> init() async {
    final prefs = await SharedPreferences.getInstance();
    _isComplete = prefs.getBool(_keyComplete) ?? false;

    if (!_isComplete) {
      // Try auto-skip: if core is already healthy, skip onboarding
      final status = await _fetchSetupStatus();
      if (status != null && status.openrouterKey) {
        _isComplete = true;
        await prefs.setBool(_keyComplete, true);
      }
    }

    notifyListeners();
  }

  /// Called when WebSocket connects to sinain-core.
  void onCoreConnected() {
    _coreConnected = true;
    if (!_isComplete && _currentStep == OnboardingStep.connecting) {
      _advance();
    }
    notifyListeners();
  }

  /// Called when WebSocket disconnects.
  void onCoreDisconnected() {
    _coreConnected = false;
    notifyListeners();
  }

  /// Fetch setup status from sinain-core.
  Future<SetupStatus?> _fetchSetupStatus() async {
    try {
      final client = HttpClient();
      client.connectionTimeout = const Duration(seconds: 2);
      final request = await client.getUrl(
        Uri.parse('http://127.0.0.1:9500/setup/status'),
      );
      final response = await request.close().timeout(const Duration(seconds: 2));
      final body = await response.transform(utf8.decoder).join();
      final json = jsonDecode(body) as Map<String, dynamic>;
      final setup = json['setup'] as Map<String, dynamic>;
      client.close(force: true);
      return SetupStatus(
        openrouterKey: setup['openrouterKey'] as bool? ?? false,
        gatewayConfigured: setup['gatewayConfigured'] as bool? ?? false,
        gatewayConnected: setup['gatewayConnected'] as bool? ?? false,
        audioActive: setup['audioActive'] as bool? ?? false,
        screenActive: setup['screenActive'] as bool? ?? false,
        transcriptionBackend: setup['transcriptionBackend'] as String? ?? 'openrouter',
        escalationMode: setup['escalationMode'] as String? ?? 'off',
      );
    } catch (_) {
      return null;
    }
  }

  /// Refresh setup status and update step accordingly.
  Future<void> refreshStatus() async {
    _setupStatus = await _fetchSetupStatus();
    notifyListeners();
  }

  /// Start polling for setup status (used during permission/audio checks).
  void startPolling() {
    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(const Duration(seconds: 3), (_) async {
      await refreshStatus();
      if (_setupStatus != null) {
        // Auto-advance if conditions are met
        if (_currentStep == OnboardingStep.permissionCheck &&
            _setupStatus!.screenActive) {
          _advance();
        }
        if (_currentStep == OnboardingStep.audioCheck &&
            _setupStatus!.audioActive) {
          _advance();
        }
      }
    });
  }

  void stopPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  void _advance() {
    final next = OnboardingStep.values.indexOf(_currentStep) + 1;
    if (next < OnboardingStep.values.length) {
      _currentStep = OnboardingStep.values[next];
    }
    notifyListeners();
  }

  void goToStep(OnboardingStep step) {
    _currentStep = step;
    notifyListeners();
  }

  /// Skip the current step and advance.
  void skipStep() {
    _advance();
  }

  /// Mark onboarding as complete.
  Future<void> complete() async {
    stopPolling();
    _isComplete = true;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_keyComplete, true);
    notifyListeners();
  }

  /// Reset onboarding (for testing).
  Future<void> reset() async {
    _isComplete = false;
    _currentStep = OnboardingStep.connecting;
    _setupStatus = null;
    _coreConnected = false;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_keyComplete);
    notifyListeners();
  }

  @override
  void dispose() {
    stopPolling();
    super.dispose();
  }
}

enum OnboardingStep {
  connecting,
  permissionCheck,
  audioCheck,
  orientation,
}

class SetupStatus {
  final bool openrouterKey;
  final bool gatewayConfigured;
  final bool gatewayConnected;
  final bool audioActive;
  final bool screenActive;
  final String transcriptionBackend;
  final String escalationMode;

  const SetupStatus({
    required this.openrouterKey,
    required this.gatewayConfigured,
    required this.gatewayConnected,
    required this.audioActive,
    required this.screenActive,
    required this.transcriptionBackend,
    required this.escalationMode,
  });
}
