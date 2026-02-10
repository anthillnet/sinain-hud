import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../core/models/feed_item.dart';
import '../core/models/hud_settings.dart';
import '../core/services/settings_service.dart';
import 'alert/alert_card.dart';
import 'feed/feed_view.dart';
import 'status/status_bar.dart';
import 'tasks/tasks_view.dart';
import 'ticker/ticker_view.dart';

class HudShell extends StatelessWidget {
  const HudShell({super.key});

  @override
  Widget build(BuildContext context) {
    final settings = context.watch<SettingsService>().settings;

    if (settings.displayMode == DisplayMode.hidden) {
      return const SizedBox.shrink();
    }

    return Container(
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.85),
        borderRadius: BorderRadius.circular(6),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: [
          // Status bar — always visible unless hidden
          const StatusBar(),
          // Main content area
          Expanded(
            child: _buildContent(settings),
          ),
        ],
      ),
    );
  }

  Widget _buildContent(HudSettings settings) {
    switch (settings.displayMode) {
      case DisplayMode.feed:
        return IndexedStack(
          index: settings.activeTab.index,
          children: const [
            FeedView(
              channel: FeedChannel.stream,
              emptyLabel: 'awaiting feed…',
            ),
            FeedView(
              channel: FeedChannel.agent,
              emptyLabel: 'awaiting sinain…',
            ),
            TasksView(),
          ],
        );
      case DisplayMode.alert:
        return const AlertCard();
      case DisplayMode.minimal:
        return const TickerView();
      case DisplayMode.hidden:
        return const SizedBox.shrink();
    }
  }
}
