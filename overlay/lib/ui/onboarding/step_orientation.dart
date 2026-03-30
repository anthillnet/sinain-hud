import 'dart:io';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/services/onboarding_service.dart';
import '../../core/services/settings_service.dart';
import '../../core/services/window_service.dart';
import '../../core/models/hud_settings.dart';

/// Step 4: Quick orientation — hotkeys and "Start" button.
class StepOrientation extends StatelessWidget {
  const StepOrientation({super.key});

  @override
  Widget build(BuildContext context) {
    final mod = Platform.isMacOS ? 'Cmd+Shift' : 'Ctrl+Shift';

    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(
            Icons.check_circle_outline,
            color: Color(0xFF00FF88),
            size: 28,
          ),
          const SizedBox(height: 8),
          const Text(
            'You\'re all set',
            style: TextStyle(
              fontSize: 13,
              color: Color(0xFF00FF88),
              fontWeight: FontWeight.bold,
            ),
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
                  'HOTKEYS',
                  style: TextStyle(
                    fontSize: 9,
                    color: Colors.white.withValues(alpha: 0.3),
                    letterSpacing: 2,
                  ),
                ),
                const SizedBox(height: 8),
                _hotkey(mod, 'Space', 'Show / hide overlay'),
                const SizedBox(height: 4),
                _hotkey(mod, 'E', 'Cycle tabs'),
                const SizedBox(height: 4),
                _hotkey(mod, 'C', 'Toggle click-through'),
                const SizedBox(height: 4),
                _hotkey(mod, 'M', 'Cycle display mode'),
              ],
            ),
          ),
          const SizedBox(height: 16),
          GestureDetector(
            onTap: () => _completeOnboarding(context),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 10),
              decoration: BoxDecoration(
                color: const Color(0xFF00FF88),
                borderRadius: BorderRadius.circular(6),
              ),
              child: const Text(
                'Start using sinain',
                style: TextStyle(
                  fontSize: 12,
                  color: Colors.black,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _completeOnboarding(BuildContext context) async {
    final onboarding = context.read<OnboardingService>();
    final settings = context.read<SettingsService>();
    final window = context.read<WindowService>();

    // Set post-onboarding defaults
    await settings.setActiveTab(HudTab.agent);
    await settings.setHudState(HudState.eye);

    // Resize to eye mode
    await window.setWindowFrame(-1, -1, 48, 48);

    // Mark complete
    await onboarding.complete();
  }

  static Widget _hotkey(String mod, String key, String description) {
    return Row(
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
          decoration: BoxDecoration(
            color: Colors.white.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(3),
          ),
          child: Text(
            '$mod+$key',
            style: const TextStyle(
              fontSize: 10,
              color: Color(0xFF00FF88),
              fontWeight: FontWeight.w500,
            ),
          ),
        ),
        const SizedBox(width: 8),
        Text(
          description,
          style: TextStyle(
            fontSize: 10,
            color: Colors.white.withValues(alpha: 0.5),
          ),
        ),
      ],
    );
  }
}
