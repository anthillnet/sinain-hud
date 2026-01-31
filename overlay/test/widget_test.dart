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
    test('cycles display modes', () {
      final settings = HudSettings(displayMode: DisplayMode.feed);
      expect(settings.nextDisplayMode, DisplayMode.alert);

      settings.displayMode = DisplayMode.hidden;
      expect(settings.nextDisplayMode, DisplayMode.feed);
    });
  });
}
