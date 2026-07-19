import 'package:flutter/material.dart';

import '../../core/constants.dart';
import '../../core/models/context_cards.dart';
import '../../core/models/region_highlight.dart';
import '../../core/theme/hud_theme.dart';

typedef RegionRoute = ({String agent, bool isTerminal, String? sessionId});

/// Island-raised result of an explicit region catch. The selection is already
/// the prompt; this card only witnesses the composed seed and picks its lane.
class RegionRouteCard extends StatefulWidget {
  final RegionHighlight region;
  final List<SessionChipState> sessions;
  final Map<String, SessionAssist> assists;
  final String? initialSessionId;
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
    this.sessions = const [],
    this.assists = const {},
    this.initialSessionId,
  });

  @override
  State<RegionRouteCard> createState() => _RegionRouteCardState();
}

class _RegionRouteCardState extends State<RegionRouteCard> {
  RegionRoute? _selected;
  String? _selectedSessionId;

  List<RegionRoute> get _routes => [
        for (final agent in widget.chatAgents)
          (agent: agent, isTerminal: false, sessionId: null),
        for (final agent in widget.terminalAgents)
          (agent: agent, isTerminal: true, sessionId: null),
      ];

  List<SessionChipState> get _contextSessions => widget.sessions
      .where((session) =>
          !session.ended &&
          widget.assists[session.sessionId]?.ready == true &&
          (widget.assists[session.sessionId]!.goal.trim().isNotEmpty ||
              widget.assists[session.sessionId]!.steps.isNotEmpty))
      .toList();

  SessionChipState? get _contextSession {
    final sessions = _contextSessions;
    if (sessions.isEmpty) return null;
    final selectedId = _selectedSessionId ?? widget.initialSessionId;
    return sessions.cast<SessionChipState?>().firstWhere(
          (session) => session?.sessionId == selectedId,
          orElse: () => sessions.first,
        );
  }

  void _cycleContextSession() {
    final sessions = _contextSessions;
    if (sessions.length < 2) return;
    final current = _contextSession!;
    final next = (sessions.indexOf(current) + 1) % sessions.length;
    setState(() => _selectedSessionId = sessions[next].sessionId);
  }

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
    final contextSession = _contextSession;
    final assist = contextSession == null
        ? null
        : widget.assists[contextSession.sessionId];
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
          if (assist != null && contextSession != null) ...[
            const SizedBox(height: 7),
            _contextPanel(theme, contextSession, assist),
          ],
          const SizedBox(height: 8),
          if (choice != null)
            Align(
                alignment: Alignment.centerLeft, child: _verbRow(theme, choice))
          else
            Text('No AI lanes available', style: _mono(10, theme.textDim)),
        ],
      ),
    );
  }

  Widget _contextPanel(
      HudTheme theme, SessionChipState session, SessionAssist assist) {
    final canSwitch = _contextSessions.length > 1;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: theme.bubbleBg,
        borderRadius: BorderRadius.circular(7),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Text('CONTEXT CARD',
              style: _mono(8, theme.textDim, weight: FontWeight.w600)),
          InkWell(
            key: const ValueKey('roi-session-picker'),
            onTap: canSwitch ? _cycleContextSession : null,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 3, vertical: 2),
              child: Text('· ${session.label}',
                  style: _mono(8, canSwitch ? theme.textMuted : theme.textDim,
                      weight: FontWeight.w600)),
            ),
          ),
        ]),
        const SizedBox(height: 4),
        if (assist.goal.trim().isNotEmpty)
          Text('goal · ${assist.goal}',
              style: _mono(10, theme.textMuted),
              maxLines: 1,
              overflow: TextOverflow.ellipsis),
        if (assist.steps.isNotEmpty)
          Text('next · ${assist.steps.first}',
              style: _mono(10, theme.textMuted),
              maxLines: 1,
              overflow: TextOverflow.ellipsis),
      ]),
    );
  }

  Widget _verbRow(HudTheme theme, RegionRoute choice) => Row(children: [
        Container(
          decoration: BoxDecoration(
            color: const Color(0xFF1E1F22),
            borderRadius: BorderRadius.circular(5),
          ),
          clipBehavior: Clip.antiAlias,
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            InkWell(
              key: const ValueKey('roi-route-confirm'),
              onTap: () => widget.onRoute((
                agent: choice.agent,
                isTerminal: choice.isTerminal,
                sessionId: _contextSession?.sessionId,
              )),
              child: Container(
                color: const Color(0xFF1F8039),
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 4),
                child: Text('▶', style: _mono(8, Colors.white)),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 4),
              child: Text(
                  '${_agentLabel(choice.agent)} — ${choice.isTerminal ? 'bridge' : 'chat'}',
                  style: _mono(8, const Color(0xFFE8EAEE))),
            ),
            PopupMenuButton<RegionRoute>(
              key: const ValueKey('roi-lane-selector'),
              tooltip: 'Switch lane',
              padding: EdgeInsets.zero,
              color: theme.panelBg,
              onSelected: (route) => setState(() => _selected = route),
              itemBuilder: (_) => [
                for (final route in _routes)
                  PopupMenuItem(
                    value: route,
                    child: Text(_agentLabel(route.agent),
                        style: _mono(10, theme.textPrimary)),
                  ),
              ],
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                decoration: const BoxDecoration(
                  border: Border(
                    left: BorderSide(color: Color(0x24FFFFFF)),
                  ),
                ),
                child: Text('▾', style: _mono(8, const Color(0xFF6C707E))),
              ),
            ),
          ]),
        ),
        const SizedBox(width: 4),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 4),
          decoration: BoxDecoration(
            color: const Color(0xFF1E1F22),
            borderRadius: BorderRadius.circular(5),
          ),
          child: Text('⤓', style: _mono(8, const Color(0xBFE8EAEE))),
        ),
      ]);

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
