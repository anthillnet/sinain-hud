import 'package:flutter/material.dart';

import '../../core/constants.dart';
import '../../core/models/context_cards.dart';
import '../../core/models/region_highlight.dart';
import '../../core/theme/hud_theme.dart';

typedef RegionRoute = ({String agent, bool isTerminal});

/// Island-raised result of an explicit region catch. The selection is already
/// the prompt; this card only witnesses the composed seed and picks its lane.
class RegionRouteCard extends StatefulWidget {
  final RegionHighlight region;
  final String? sessionLabel;
  final SessionAssist? assist;
  final List<String> chatAgents;
  final List<String> terminalAgents;
  final String initialChatAgent;
  final String initialTerminalAgent;
  final ValueChanged<RegionRoute> onRoute;
  final VoidCallback onDismiss;

  const RegionRouteCard({
    super.key,
    required this.region,
    required this.chatAgents,
    required this.terminalAgents,
    required this.initialChatAgent,
    required this.initialTerminalAgent,
    required this.onRoute,
    required this.onDismiss,
    this.sessionLabel,
    this.assist,
  });

  @override
  State<RegionRouteCard> createState() => _RegionRouteCardState();
}

class _RegionRouteCardState extends State<RegionRouteCard> {
  RegionRoute? _selected;

  List<RegionRoute> get _routes => [
        for (final agent in widget.chatAgents)
          (agent: agent, isTerminal: false),
        for (final agent in widget.terminalAgents)
          (agent: agent, isTerminal: true),
      ];

  RegionRoute? get _choice {
    final routes = _routes;
    if (_selected case final selected? when routes.contains(selected)) {
      return selected;
    }
    for (final route in routes) {
      if (!route.isTerminal && route.agent == widget.initialChatAgent) {
        return route;
      }
    }
    for (final route in routes) {
      if (route.isTerminal && route.agent == widget.initialTerminalAgent) {
        return route;
      }
    }
    return routes.isEmpty ? null : routes.first;
  }

  String _agentLabel(String id) => switch (id) {
        'sinain' => 'Sinain Chat',
        'claude' => 'Claude Code',
        'gclaude' => 'Claude',
        'openclaude' => 'OpenClaude',
        'codex' => 'Codex',
        'goose' => 'Goose',
        'junie' => 'Junie',
        'aider' => 'Aider',
        'claude-desktop' => 'Claude Desktop',
        'chatgpt-desktop' => 'ChatGPT',
        _ => id,
      };

  TextStyle _mono(double size, Color color,
          {FontWeight weight = FontWeight.w400}) =>
      TextStyle(
        fontFamily: HudConstants.monoFont,
        fontSize: size,
        color: color,
        fontWeight: weight,
      );

  @override
  Widget build(BuildContext context) {
    final theme = HudTheme.of(context);
    final choice = _choice;
    final assist = widget.assist;
    final preview = [widget.region.issue, widget.region.tip]
        .where((text) => text.trim().isNotEmpty)
        .join(' · ');
    return Container(
      key: const ValueKey('island-roi-card'),
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: theme.panelBg,
        border: Border.all(color: theme.border),
        borderRadius: BorderRadius.circular(10),
        boxShadow: const [
          BoxShadow(
              color: Color(0x55000000), blurRadius: 22, offset: Offset(0, 8)),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(children: [
            Container(
              width: 8,
              height: 8,
              decoration: const BoxDecoration(
                color: Color(0xFFD9A21B),
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 9),
            Expanded(
              child: Text('Region caught',
                  style: _mono(12, theme.textPrimary, weight: FontWeight.w600)),
            ),
            InkWell(
              key: const ValueKey('roi-dismiss'),
              onTap: widget.onDismiss,
              child: Padding(
                padding: const EdgeInsets.all(4),
                child: Icon(Icons.close, size: 14, color: theme.textDim),
              ),
            ),
          ]),
          const SizedBox(height: 7),
          _panel(
            theme,
            'CAPTURED REGION',
            preview.isEmpty ? 'selected screen region' : preview,
          ),
          const SizedBox(height: 7),
          _panel(
            theme,
            widget.sessionLabel == null
                ? 'CONTEXT CARD'
                : 'CONTEXT CARD · ${widget.sessionLabel}',
            assist == null
                ? 'goal · current work\nnext · continue from this region'
                : 'goal · ${assist.goal}\n${assist.steps.isEmpty ? 'next · continue from this region' : 'next · ${assist.steps.first}'}',
          ),
          const SizedBox(height: 8),
          Text('DESTINATION LANE',
              style: _mono(9, theme.textDim, weight: FontWeight.w600)),
          const SizedBox(height: 5),
          if (choice != null)
            Container(
              height: 34,
              padding: const EdgeInsets.symmetric(horizontal: 9),
              decoration: BoxDecoration(
                color: theme.bubbleBg,
                border: Border.all(color: theme.border),
                borderRadius: BorderRadius.circular(6),
              ),
              child: DropdownButtonHideUnderline(
                child: DropdownButton<RegionRoute>(
                  key: const ValueKey('roi-lane-selector'),
                  value: choice,
                  isExpanded: true,
                  dropdownColor: theme.panelBg,
                  icon:
                      Icon(Icons.expand_more, size: 15, color: theme.textMuted),
                  style: _mono(11, theme.textPrimary),
                  items: [
                    for (final route in _routes)
                      DropdownMenuItem(
                        value: route,
                        child: Row(children: [
                          Icon(
                              route.isTerminal
                                  ? Icons.terminal
                                  : Icons.chat_bubble_outline,
                              size: 13,
                              color: theme.textMuted),
                          const SizedBox(width: 7),
                          Text(_agentLabel(route.agent)),
                          const Spacer(),
                          Text(route.isTerminal ? 'terminal' : 'chat',
                              style: _mono(9, theme.textDim)),
                        ]),
                      ),
                  ],
                  onChanged: (route) => setState(() => _selected = route),
                ),
              ),
            )
          else
            Text('No AI lanes available', style: _mono(10, theme.textDim)),
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerLeft,
            child: FilledButton(
              key: const ValueKey('roi-route-confirm'),
              onPressed: choice == null ? null : () => widget.onRoute(choice),
              style: FilledButton.styleFrom(
                minimumSize: const Size(0, 30),
                padding: const EdgeInsets.symmetric(horizontal: 12),
                backgroundColor: const Color(0xFF1F8039),
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(6)),
              ),
              child: Text(
                choice == null
                    ? '▶ Select a lane'
                    : '▶ ${_agentLabel(choice.agent)}',
                style: _mono(11, Colors.white, weight: FontWeight.w600),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _panel(HudTheme theme, String label, String body) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          color: theme.bubbleBg,
          borderRadius: BorderRadius.circular(7),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label,
                style: _mono(8, theme.textDim, weight: FontWeight.w600)),
            const SizedBox(height: 4),
            Text(body,
                style: _mono(10, theme.textMuted),
                maxLines: 3,
                overflow: TextOverflow.ellipsis),
          ],
        ),
      );
}
