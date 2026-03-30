import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/services/onboarding_service.dart';

/// Step 3: Verify audio pipeline is working.
/// Auto-advances when audio becomes active, or allows skip/retry.
class StepAudioCheck extends StatelessWidget {
  const StepAudioCheck({super.key});

  @override
  Widget build(BuildContext context) {
    final onboarding = context.watch<OnboardingService>();
    final status = onboarding.setupStatus;
    final audioOk = status?.audioActive ?? false;

    if (audioOk) {
      Future.microtask(() => onboarding.skipStep());
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.check_circle_outline, color: Color(0xFF00FF88), size: 32),
            SizedBox(height: 8),
            Text(
              'Audio pipeline active',
              style: TextStyle(color: Color(0xFF00FF88), fontSize: 12),
            ),
          ],
        ),
      );
    }

    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.hearing,
            color: Colors.white.withValues(alpha: 0.5),
            size: 28,
          ),
          const SizedBox(height: 12),
          const Text(
            'Checking audio pipeline...',
            style: TextStyle(fontSize: 12, color: Colors.white70),
          ),
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.05),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Audio capture is not active yet.',
                  style: TextStyle(
                    fontSize: 11,
                    color: Colors.white.withValues(alpha: 0.5),
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  'sinain uses ScreenCaptureKit to capture\nsystem audio. No extra software needed.',
                  style: TextStyle(
                    fontSize: 9,
                    color: Colors.white.withValues(alpha: 0.35),
                    height: 1.4,
                  ),
                ),
                const SizedBox(height: 12),
                GestureDetector(
                  onTap: () => onboarding.refreshStatus(),
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 6,
                    ),
                    decoration: BoxDecoration(
                      border: Border.all(
                        color: const Color(0xFF00FF88).withValues(alpha: 0.3),
                      ),
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: const Text(
                      'Retry',
                      style: TextStyle(
                        fontSize: 10,
                        color: Color(0xFF00FF88),
                      ),
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
}
