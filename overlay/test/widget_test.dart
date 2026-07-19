import 'package:flutter_test/flutter_test.dart';
import 'package:sinain_hud/core/models/feed_item.dart';
import 'package:sinain_hud/core/models/hud_settings.dart';

void main() {
  group('FeedItem', () {
    test('creates with defaults', () {
      final item = FeedItem(id: '1', text: 'test');
      expect(item.priority, FeedPriority.normal);
      expect(item.opacity, 1.0);
    });

    test('parses from json', () {
      final item = FeedItem.fromJson({
        'id': '2',
        'text': 'urgent message',
        'priority': 'urgent',
      });
      expect(item.priority, FeedPriority.urgent);
      expect(item.text, 'urgent message');
    });
  });

  group('HudSettings', () {
    test('defaults to chat state', () {
      final settings = HudSettings();
      expect(settings.overlayState, HudState.chat);
      expect(settings.eyeX, -1);
      expect(settings.notchParked, isFalse);
      expect(settings.chatWidth, 427);
    });

    test('has default display settings', () {
      final settings = HudSettings();
      expect(settings.fontSize, 12.0);
      expect(settings.accentColor, 0xFF00FF88);
    });

    test('copyWith preserves display settings', () {
      final original = HudSettings(fontSize: 16.0, accentColor: 0xFF00E5FF);
      final copied = original.copyWith(overlayState: HudState.eye);
      expect(copied.fontSize, 16.0);
      expect(copied.accentColor, 0xFF00E5FF);
      expect(copied.overlayState, HudState.eye);
      expect(copied.notchParked, isFalse);
    });

    test('copyWith overrides display settings', () {
      final original = HudSettings();
      final copied = original.copyWith(fontSize: 18.0, accentColor: 0xFFFF3344);
      expect(copied.fontSize, 18.0);
      expect(copied.accentColor, 0xFFFF3344);
    });

    test('cycles tabs', () {
      final settings = HudSettings(activeTab: HudTab.agent);
      expect(settings.nextTab, HudTab.tasks);
    });
  });

  group('Feedback prompt eligibility', () {
    const now = 1000000;

    test('pending under cap is eligible', () {
      final s = HudSettings();
      expect(s.feedbackStatus, FeedbackPromptStatus.pending);
      expect(s.feedbackEligible(now), isTrue);
    });

    test('retired is never eligible', () {
      final s = HudSettings(feedbackStatus: FeedbackPromptStatus.retired);
      expect(s.feedbackEligible(now), isFalse);
    });

    test('ask cap retires it even when pending', () {
      final s = HudSettings(
        feedbackStatus: FeedbackPromptStatus.pending,
        feedbackAskCount: HudSettings.feedbackMaxAsks,
      );
      expect(s.feedbackEligible(now), isFalse);
    });

    test('snoozed before re-arm time is not eligible', () {
      final s = HudSettings(
        feedbackStatus: FeedbackPromptStatus.snoozed,
        feedbackSnoozeUntilMs: now + 1,
      );
      expect(s.feedbackEligible(now), isFalse);
    });

    test('snoozed after re-arm time is eligible', () {
      final s = HudSettings(
        feedbackStatus: FeedbackPromptStatus.snoozed,
        feedbackSnoozeUntilMs: now - 1,
      );
      expect(s.feedbackEligible(now), isTrue);
    });
  });
}
