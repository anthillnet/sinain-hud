import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sinain_hud/core/models/feed_item.dart';
import 'package:sinain_hud/core/services/settings_service.dart';
import 'package:sinain_hud/core/services/websocket_service.dart';
import 'package:sinain_hud/ui/feed/feed_view.dart';

/// Builds a testable FeedView wrapped in required providers.
Widget _buildTestHarness({
  required WebSocketService ws,
  required SettingsService settings,
  FeedChannel channel = FeedChannel.stream,
}) {
  return MaterialApp(
    home: MultiProvider(
      providers: [
        ChangeNotifierProvider<WebSocketService>.value(value: ws),
        ChangeNotifierProvider<SettingsService>.value(value: settings),
      ],
      child: Scaffold(
        body: SizedBox(
          height: 300,
          width: 400,
          child: FeedView(channel: channel),
        ),
      ),
    ),
  );
}

void main() {
  late WebSocketService ws;
  late SettingsService settings;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    ws = WebSocketService();
    settings = SettingsService();
    await settings.init();
  });

  tearDown(() {
    ws.dispose();
    settings.dispose();
  });

  group('FeedView scroll behavior', () {
    testWidgets('shows idle animation when feed is empty', (tester) async {
      await tester.pumpWidget(_buildTestHarness(ws: ws, settings: settings));
      await tester.pump();
      expect(find.text('awaiting feed\u2026'), findsOneWidget);
      expect(find.byType(ListView), findsNothing);
    });

    testWidgets('renders ListView after item emitted', (tester) async {
      await tester.pumpWidget(_buildTestHarness(ws: ws, settings: settings));
      await tester.pump();

      ws.toggleAudioFeed(); // emits one FeedItem via feedStream
      await tester.pump(); // subscription + setState
      await tester.pump(const Duration(milliseconds: 120)); // animateTo finishes

      expect(find.byType(ListView), findsOneWidget);
    });

    testWidgets('each emitted item wraps its content in a RepaintBoundary',
        (tester) async {
      await tester.pumpWidget(_buildTestHarness(ws: ws, settings: settings));
      await tester.pump();

      ws.toggleAudioFeed();
      ws.toggleAudioFeed();
      ws.toggleScreenFeed();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 120));

      // The per-item wrapper in feed_view.dart is:
      //   RepaintBoundary { child: Opacity(...) }
      // Match RepaintBoundary widgets whose direct child is an Opacity —
      // this is specific to our custom wrapper and excludes ListView.builder's
      // internal RepaintBoundaries (whose children are KeyedSubtree etc).
      final perItemBoundaries = find.byWidgetPredicate(
        (w) => w is RepaintBoundary && w.child is Opacity,
      );
      expect(perItemBoundaries, findsNWidgets(3));
    });
  });
}
