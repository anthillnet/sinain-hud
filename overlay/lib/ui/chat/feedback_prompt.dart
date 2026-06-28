import 'package:flutter/material.dart';

import '../../core/constants.dart';
import '../feed/idle_animation.dart';

/// One-time "Was that helpful?" feedback toast (Feedback Prompt design).
///
/// Self-styled as a solid dark card — "clearly Sinain speaking," not an OS
/// notification — so it reads the same regardless of the HUD's presentation
/// style. Fired by the shell at the first value-proof moment; the shell owns
/// the lifecycle (see SettingsService.setFeedbackState) and passes the three
/// outcomes in.
class FeedbackPrompt extends StatelessWidget {
  const FeedbackPrompt({
    super.key,
    required this.onAnswer,
    required this.onLater,
    required this.onDismiss,
  });

  /// "Answer the poll" — opens the survey, then retires the prompt.
  final VoidCallback onAnswer;

  /// "Later" — snooze and re-arm at the next breakpoint (max two asks).
  final VoidCallback onLater;

  /// "Don't ask again" — retire for good.
  final VoidCallback onDismiss;

  // Design palette (Feedback Prompt · section 2).
  static const _cardBg = Color(0xFF1E1F22);
  static const _green = Color(0xFF1F8039);
  static const _muted = Color(0xFFA8ADBD);
  static const _dim = Color(0xFF6C707E);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 4),
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: _cardBg,
          border: Border.all(color: _green.withValues(alpha: 0.4)),
          borderRadius: BorderRadius.circular(10),
          boxShadow: const [
            BoxShadow(
                color: Color(0x57001C36), blurRadius: 32, offset: Offset(0, 12)),
          ],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Row(
              children: [
                SizedBox(
                  width: 16,
                  height: 16,
                  child: IdleAnimation(size: 16, color: _green),
                ),
                SizedBox(width: 9),
                Text(
                  'Was that helpful?',
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: Colors.white,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 9),
            const Text(
              "Sinain's still early. Now that you've seen it in action — one "
              "quick question on whether it's worth keeping around?",
              style: TextStyle(fontSize: 13, height: 1.38, color: _muted),
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: _button(
                    label: 'Answer the poll',
                    filled: true,
                    onTap: onAnswer,
                  ),
                ),
                const SizedBox(width: 8),
                _button(label: 'Later', filled: false, onTap: onLater),
              ],
            ),
            const SizedBox(height: 9),
            Center(
              child: MouseRegion(
                cursor: SystemMouseCursors.click,
                child: GestureDetector(
                  onTap: onDismiss,
                  child: const Text(
                    "Don't ask again",
                    style: TextStyle(fontSize: 11, color: _dim),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _button({
    required String label,
    required bool filled,
    required VoidCallback onTap,
  }) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          height: 32,
          alignment: Alignment.center,
          padding: filled ? null : const EdgeInsets.symmetric(horizontal: 14),
          decoration: BoxDecoration(
            color: filled ? _green : Colors.transparent,
            borderRadius: BorderRadius.circular(6),
            border: filled
                ? null
                : Border.all(color: Colors.white.withValues(alpha: 0.18)),
          ),
          child: Text(
            label,
            style: TextStyle(
              fontFamily: HudConstants.monoFont,
              fontFamilyFallback: HudConstants.monoFontFallbacks,
              fontSize: 13,
              fontWeight: FontWeight.w500,
              color: filled ? Colors.white : _muted,
            ),
          ),
        ),
      ),
    );
  }
}
