import 'dart:io';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/services/onboarding_service.dart';

/// Step 2: Check macOS permissions (Screen Recording, Microphone).
/// Auto-advances when screen capture becomes active.
class StepPermissions extends StatelessWidget {
  const StepPermissions({super.key});

  @override
  Widget build(BuildContext context) {
    final onboarding = context.watch<OnboardingService>();
    final status = onboarding.setupStatus;
    final screenOk = status?.screenActive ?? false;

    if (screenOk) {
      // Auto-advance after a brief moment
      Future.microtask(() => onboarding.skipStep());
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.check_circle_outline, color: Color(0xFF00FF88), size: 32),
            SizedBox(height: 8),
            Text(
              'Permissions OK',
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
            Icons.security,
            color: Colors.white.withValues(alpha: 0.5),
            size: 28,
          ),
          const SizedBox(height: 12),
          const Text(
            'Screen Recording permission needed',
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
                if (Platform.isMacOS) ...[
                  _instruction('1', 'Open System Settings'),
                  const SizedBox(height: 6),
                  _instruction('2', 'Privacy & Security → Screen Recording'),
                  const SizedBox(height: 6),
                  _instruction('3', 'Enable for Terminal (or your IDE)'),
                  const SizedBox(height: 12),
                  Text(
                    'sinain needs screen recording to capture\nwhat\'s on your display for AI analysis.',
                    style: TextStyle(
                      fontSize: 9,
                      color: Colors.white.withValues(alpha: 0.35),
                      height: 1.4,
                    ),
                  ),
                ] else ...[
                  const Text(
                    'Screen capture may need elevated permissions.\nCheck your system settings.',
                    style: TextStyle(fontSize: 10, color: Colors.white54),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 12),
          Text(
            'Waiting for permission...',
            style: TextStyle(
              fontSize: 9,
              color: Colors.white.withValues(alpha: 0.3),
            ),
          ),
        ],
      ),
    );
  }

  static Widget _instruction(String num, String text) {
    return Row(
      children: [
        Container(
          width: 18,
          height: 18,
          decoration: BoxDecoration(
            color: const Color(0xFF00FF88).withValues(alpha: 0.15),
            borderRadius: BorderRadius.circular(9),
          ),
          alignment: Alignment.center,
          child: Text(
            num,
            style: const TextStyle(
              fontSize: 10,
              color: Color(0xFF00FF88),
              fontWeight: FontWeight.bold,
            ),
          ),
        ),
        const SizedBox(width: 8),
        Text(
          text,
          style: const TextStyle(fontSize: 11, color: Colors.white70),
        ),
      ],
    );
  }
}
