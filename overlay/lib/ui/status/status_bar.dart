import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/models/hud_settings.dart';
import '../../core/services/settings_service.dart';
import '../../core/services/websocket_service.dart';

class StatusBar extends StatelessWidget {
  const StatusBar({super.key});

  @override
  Widget build(BuildContext context) {
    final ws = context.watch<WebSocketService>();
    final settings = context.watch<SettingsService>().settings;

    return Container(
      height: 20,
      padding: const EdgeInsets.symmetric(horizontal: 8),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.6),
        border: Border(
          bottom: BorderSide(
            color: Colors.white.withValues(alpha: 0.08),
            width: 0.5,
          ),
        ),
      ),
      child: Row(
        children: [
          // Connection indicator
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: ws.connected
                  ? const Color(0xFF00FF88)
                  : const Color(0xFFFF3344),
              boxShadow: [
                BoxShadow(
                  color: (ws.connected
                          ? const Color(0xFF00FF88)
                          : const Color(0xFFFF3344))
                      .withValues(alpha: 0.5),
                  blurRadius: 4,
                  spreadRadius: 1,
                ),
              ],
            ),
          ),
          const SizedBox(width: 6),
          Text(
            ws.connected ? 'LIVE' : 'OFF',
            style: TextStyle(
              fontFamily: 'JetBrainsMono',
              fontSize: 9,
              color: Colors.white.withValues(alpha: 0.5),
              letterSpacing: 1.2,
            ),
          ),
          const SizedBox(width: 8),
          // Tab indicator
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(2),
              color: settings.activeTab == HudTab.agent
                  ? const Color(0xFF00FF88).withValues(alpha: 0.12)
                  : Colors.transparent,
              border: Border.all(
                color: settings.activeTab == HudTab.agent
                    ? const Color(0xFF00FF88).withValues(alpha: 0.4)
                    : Colors.white.withValues(alpha: 0.15),
                width: 0.5,
              ),
            ),
            child: Text(
              settings.activeTab == HudTab.agent ? 'AGT' : 'STR',
              style: TextStyle(
                fontFamily: 'JetBrainsMono',
                fontSize: 8,
                color: settings.activeTab == HudTab.agent
                    ? const Color(0xFF00FF88).withValues(alpha: 0.8)
                    : Colors.white.withValues(alpha: 0.4),
                letterSpacing: 1.5,
              ),
            ),
          ),
          const Spacer(),
          // Screen indicator
          Icon(
            ws.screenState == 'active'
                ? Icons.visibility
                : Icons.visibility_off,
            size: 10,
            color: ws.screenState == 'active'
                ? const Color(0xFF00FF88)
                : Colors.white.withValues(alpha: 0.3),
          ),
          const SizedBox(width: 6),
          // Audio indicator
          Icon(
            ws.audioState == 'active'
                ? Icons.volume_up_rounded
                : Icons.volume_off_rounded,
            size: 10,
            color: ws.audioState == 'active'
                ? const Color(0xFF00FF88)
                : Colors.white.withValues(alpha: 0.3),
          ),
          const SizedBox(width: 8),
          // Mode label
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(2),
              border: Border.all(
                color: Colors.white.withValues(alpha: 0.15),
                width: 0.5,
              ),
            ),
            child: Text(
              settings.displayMode.name.toUpperCase(),
              style: TextStyle(
                fontFamily: 'JetBrainsMono',
                fontSize: 8,
                color: Colors.white.withValues(alpha: 0.4),
                letterSpacing: 1.5,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
