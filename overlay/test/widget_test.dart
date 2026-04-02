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
}
