import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/services/onboarding_service.dart';
import '../../core/services/websocket_service.dart';
import 'step_connecting.dart';
import 'step_permissions.dart';
import 'step_audio_check.dart';
import 'step_orientation.dart';

/// Container for the onboarding flow.
/// Shows step dots, back button, and the current step widget.
class OnboardingView extends StatefulWidget {
  const OnboardingView({super.key});

  @override
  State<OnboardingView> createState() => _OnboardingViewState();
}

class _OnboardingViewState extends State<OnboardingView> {
  @override
  void initState() {
    super.initState();
    final onboarding = context.read<OnboardingService>();
    final ws = context.read<WebSocketService>();

    // Watch WS connection for auto-advance
    ws.addListener(_onWsChanged);

    // If already connected, advance immediately
    if (ws.connected) {
      onboarding.onCoreConnected();
      onboarding.refreshStatus();
      onboarding.startPolling();
    }
  }

  void _onWsChanged() {
    final ws = context.read<WebSocketService>();
    final onboarding = context.read<OnboardingService>();
    if (ws.connected) {
      onboarding.onCoreConnected();
      onboarding.refreshStatus();
      onboarding.startPolling();
    } else {
      onboarding.onCoreDisconnected();
    }
  }

  @override
  void dispose() {
    context.read<WebSocketService>().removeListener(_onWsChanged);
    context.read<OnboardingService>().stopPolling();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final onboarding = context.watch<OnboardingService>();
    final step = onboarding.currentStep;
    const steps = OnboardingStep.values;
    final stepIndex = steps.indexOf(step);

    return Container(
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.92),
        borderRadius: BorderRadius.circular(12),
      ),
      padding: const EdgeInsets.all(20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Header
          const Text(
            'SINAIN HUD',
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.bold,
              color: Color(0xFF00FF88),
              letterSpacing: 3,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            'setup',
            style: TextStyle(
              fontSize: 10,
              color: Colors.white.withValues(alpha: 0.4),
              letterSpacing: 2,
            ),
          ),
          const SizedBox(height: 16),

          // Step dots
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: List.generate(steps.length, (i) {
              final isActive = i == stepIndex;
              final isDone = i < stepIndex;
              return Container(
                width: isActive ? 16 : 8,
                height: 8,
                margin: const EdgeInsets.symmetric(horizontal: 3),
                decoration: BoxDecoration(
                  color: isDone
                      ? const Color(0xFF00FF88)
                      : isActive
                          ? const Color(0xFF00FF88).withValues(alpha: 0.7)
                          : Colors.white.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(4),
                ),
              );
            }),
          ),
          const SizedBox(height: 20),

          // Step content
          Expanded(
            child: _buildStep(step),
          ),

          // Back + Skip row
          if (stepIndex > 0 && step != OnboardingStep.orientation)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  GestureDetector(
                    onTap: () {
                      if (stepIndex > 0) {
                        onboarding.goToStep(steps[stepIndex - 1]);
                      }
                    },
                    child: Text(
                      '< back',
                      style: TextStyle(
                        fontSize: 10,
                        color: Colors.white.withValues(alpha: 0.3),
                      ),
                    ),
                  ),
                  GestureDetector(
                    onTap: () => onboarding.skipStep(),
                    child: Text(
                      'skip >',
                      style: TextStyle(
                        fontSize: 10,
                        color: Colors.white.withValues(alpha: 0.3),
                      ),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildStep(OnboardingStep step) {
    switch (step) {
      case OnboardingStep.connecting:
        return const StepConnecting();
      case OnboardingStep.permissionCheck:
        return const StepPermissions();
      case OnboardingStep.audioCheck:
        return const StepAudioCheck();
      case OnboardingStep.orientation:
        return const StepOrientation();
    }
  }
}
