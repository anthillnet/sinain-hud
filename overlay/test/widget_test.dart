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
    test('defaults to eye state', () {
      final settings = HudSettings();
      expect(settings.overlayState, HudState.eye);
      expect(settings.eyeX, -1);
      expect(settings.chatWidth, 427);
    });

    test('cycles tabs', () {
      final settings = HudSettings(activeTab: HudTab.agent);
      expect(settings.nextTab, HudTab.tasks);
    });
  });
}
