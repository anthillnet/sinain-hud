import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/constants.dart';
import '../../core/services/settings_service.dart';
import '../../core/services/websocket_service.dart';
import '../hud_tooltip.dart';

/// Popover for picking which bare-agent CLI handles each lane.
/// Triggered by the flash icon in the controls bar. Two sections —
/// ESCALATION (HUD responses) and SPAWN (background subtasks) — each
/// shows the installed agents as selectable chips, plus an "Off" chip
/// that disables that lane entirely. Empty roster shows a helpful
/// install-and-restart hint.
class AgentSelectorPanel extends StatelessWidget {
  final VoidCallback onClose;

  const AgentSelectorPanel({super.key, required this.onClose});

  @override
  Widget build(BuildContext context) {
    final settings = context.watch<SettingsService>();
    final ws = context.watch<WebSocketService>();
    final accent = Color(settings.settings.accentColor);
    final available = ws.availableAgents;
    final terminalAvailable = ws.terminalAvailable;
    final escAgent = ws.escalationAgent;
    final terminalAgent = ws.terminalAgent;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.95),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: accent.withValues(alpha: 0.3)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _headerRow(onClose),
          const SizedBox(height: 8),
          if (available.isEmpty)
            _emptyState()
          else ...[
            _laneSection(
              // User-facing lane names: CHAT answers MAIN + region chat +
              // ambient idle messages (chat selector, includes the sinain
              // sidecar); TERM runs interactive thread terminals (terminal
              // selector, excludes sinain — no TUI). Two decoupled lanes.
              label: 'CHAT',
              current: escAgent,
              available: available,
              accent: accent,
              onSelect: (agent) => ws.setAgent('escalation', agent),
            ),
            const SizedBox(height: 10),
            _laneSection(
              label: 'TERM',
              current: terminalAgent,
              available: terminalAvailable,
              accent: accent,
              onSelect: (agent) => ws.setAgent('terminal', agent),
            ),
            const SizedBox(height: 10),
            // Ambient idle messages (unsolicited proactive messages while the
            // user is idle) — explicit on/off, OFF by default, and fully
            // decoupled from escalation mode + agent selection so picking a
            // chat agent can never silently turn it on. Compact chips (a
            // Material Switch is ~48px tall and pushed itself below the
            // panel's visible area).
            Builder(builder: (context) {
              final idleOn = ws.idleMessagesEnabled;
              return Row(
                children: [
                  Expanded(
                    child: Text(
                      'IDLE MESSAGES',
                      style: TextStyle(
                        fontFamily: HudConstants.monoFont,
                        fontFamilyFallback: HudConstants.monoFontFallbacks,
                        fontSize: 9,
                        letterSpacing: 1.2,
                        color: Colors.white.withValues(alpha: 0.45),
                      ),
                    ),
                  ),
                  _chip(
                    label: 'On',
                    selected: idleOn,
                    accent: accent,
                    // Explicit set (not a flip): tapping On always enables,
                    // even if the displayed state momentarily lags core.
                    onTap: () => ws.sendCommand(
                        'set_idle_messages_enabled', {'enabled': true}),
                  ),
                  const SizedBox(width: 4),
                  _chip(
                    label: 'Off',
                    selected: !idleOn,
                    accent: accent,
                    // Explicit set (not a flip): tapping Off always disables.
                    onTap: () => ws.sendCommand(
                        'set_idle_messages_enabled', {'enabled': false}),
                  ),
                ],
              );
            }),
          ],
        ],
      ),
    );
  }

  Widget _headerRow(VoidCallback onClose) {
    return Row(
      children: [
        Text(
          'AGENTS',
          style: TextStyle(
            fontFamily: HudConstants.monoFont,
            fontFamilyFallback: HudConstants.monoFontFallbacks,
            fontSize: 9,
            color: Colors.white.withValues(alpha: 0.5),
            fontWeight: FontWeight.bold,
            letterSpacing: 1.5,
          ),
        ),
        const Spacer(),
        HudTooltip(
          message: 'Close',
          child: MouseRegion(
            cursor: SystemMouseCursors.click,
            child: GestureDetector(
              onTap: onClose,
              child: Icon(Icons.close, size: 12, color: Colors.white.withValues(alpha: 0.4)),
            ),
          ),
        ),
      ],
    );
  }

  Widget _laneSection({
    required String label,
    required String current,
    required List<String> available,
    required Color accent,
    required void Function(String agent) onSelect,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: TextStyle(
            fontFamily: HudConstants.monoFont,
            fontFamilyFallback: HudConstants.monoFontFallbacks,
            fontSize: 9,
            color: Colors.white.withValues(alpha: 0.35),
            letterSpacing: 1.2,
          ),
        ),
        const SizedBox(height: 6),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            // "Off" chip first — clears this lane.
            _chip(label: 'Off', selected: current.isEmpty, accent: accent, onTap: () => onSelect('')),
            for (final agent in available)
              _chip(
                label: agent,
                selected: current == agent,
                accent: accent,
                onTap: () => onSelect(agent),
              ),
          ],
        ),
      ],
    );
  }

  Widget _chip({
    required String label,
    required bool selected,
    required Color accent,
    required VoidCallback onTap,
  }) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: selected ? null : onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          decoration: BoxDecoration(
            color: selected ? accent.withValues(alpha: 0.2) : Colors.white.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(4),
            border: Border.all(
              color: selected ? accent.withValues(alpha: 0.6) : Colors.white.withValues(alpha: 0.1),
              width: 1,
            ),
          ),
          child: Text(
            label,
            style: TextStyle(
              fontFamily: HudConstants.monoFont,
              fontFamilyFallback: HudConstants.monoFontFallbacks,
              fontSize: 10,
              color: selected ? accent : Colors.white.withValues(alpha: 0.75),
              fontWeight: selected ? FontWeight.w600 : FontWeight.normal,
            ),
          ),
        ),
      ),
    );
  }

  Widget _emptyState() {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Text(
        'No agents detected.\nInstall claude / openclaude / codex / goose / junie / aider\nand restart the bare agent.',
        style: TextStyle(
          fontFamily: HudConstants.monoFont,
          fontFamilyFallback: HudConstants.monoFontFallbacks,
          fontSize: 9,
          color: Colors.white.withValues(alpha: 0.5),
          height: 1.4,
        ),
      ),
    );
  }
}
