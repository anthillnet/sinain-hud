import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../core/models/feed_item.dart';
import '../core/models/hud_settings.dart';
import '../core/services/settings_service.dart';
import '../core/services/websocket_service.dart';
import '../core/services/window_service.dart';
import 'alert/alert_card.dart';
import 'feed/feed_view.dart';
import 'input/command_input.dart';
import 'status/status_bar.dart';
import 'tasks/tasks_view.dart';
import 'ticker/ticker_view.dart';

class HudShell extends StatefulWidget {
  const HudShell({super.key});

  @override
  HudShellState createState() => HudShellState();
}

class HudShellState extends State<HudShell> {
  bool _commandInputVisible = false;

  /// Called externally (from main.dart hotkey handler) to show command input.
  void showCommandInput() {
    if (_commandInputVisible) return;
    setState(() => _commandInputVisible = true);
    // Activate after the widget has rendered so the window is ready for focus
    final windowService = context.read<WindowService>();
    windowService.activateCommandInput();
  }

  void _dismissCommandInput() {
    if (!_commandInputVisible) return;
    setState(() => _commandInputVisible = false);
    final windowService = context.read<WindowService>();
    windowService.dismissCommandInput();
  }

  void _onCommandSubmit(String text) {
    final wsService = context.read<WebSocketService>();
    wsService.sendUserCommand(text);
  }

  void _onSpawnCommand(String text) {
    final wsService = context.read<WebSocketService>();
    wsService.sendSpawnCommand(text);
  }

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
          // Command input — shown when user presses Cmd+Shift+/
          if (_commandInputVisible)
            CommandInput(
              onSubmit: _onCommandSubmit,
              onSpawn: _onSpawnCommand,
              onDismiss: _dismissCommandInput,
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
