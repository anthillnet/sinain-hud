import 'package:flutter/material.dart';

import '../../core/constants.dart';
import '../../core/theme/hud_theme.dart';

String handoffAgentLabel(String id) => switch (id) {
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

class HandoffControl extends StatefulWidget {
  final List<String> chatAgents;
  final List<String> terminalAgents;
  final String? initialChatAgent;
  final String? initialTerminalAgent;
  final bool initialIsTerminal;
  final Color accent;
  final String verb;
  final void Function(String agent, bool isTerminal) onConfirm;

  const HandoffControl({
    super.key,
    required this.chatAgents,
    required this.terminalAgents,
    this.initialChatAgent,
    this.initialTerminalAgent,
    required this.initialIsTerminal,
    required this.accent,
    required this.verb,
    required this.onConfirm,
  });

  @override
  State<HandoffControl> createState() => _HandoffControlState();
}

class _HandoffControlState extends State<HandoffControl> {
  String? _agent;
  bool? _isTerminal;

  TextStyle _mono(double size, Color color,
          {FontWeight weight = FontWeight.w400}) =>
      TextStyle(
        fontFamily: HudConstants.monoFont,
        fontSize: size,
        color: color,
        fontWeight: weight,
      );

  ({String agent, bool isTerminal})? get _choice {
    final routes = [
      for (final agent in widget.chatAgents)
        (agent: agent, isTerminal: false),
      for (final agent in widget.terminalAgents)
        (agent: agent, isTerminal: true),
    ];
    for (final route in routes) {
      if (route.agent == _agent && route.isTerminal == _isTerminal) {
        return route;
      }
    }
    final initialAgent = widget.initialIsTerminal
        ? widget.initialTerminalAgent
        : widget.initialChatAgent;
    for (final route in routes) {
      if (route.agent == initialAgent &&
          route.isTerminal == widget.initialIsTerminal) {
        return route;
      }
    }
    return routes.isEmpty ? null : routes.first;
  }

  @override
  Widget build(BuildContext context) {
    final theme = HudTheme.of(context);
    final choice = _choice;
    if (choice == null) {
      return Text('No AI lanes available', style: _mono(10, theme.textDim));
    }
    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFF1E1F22),
        borderRadius: BorderRadius.circular(5),
      ),
      clipBehavior: Clip.antiAlias,
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        InkWell(
          onTap: () => widget.onConfirm(choice.agent, choice.isTerminal),
          child: Container(
            color: widget.accent,
            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 4),
            child: Text(widget.verb, style: _mono(8, Colors.white)),
          ),
        ),
        Flexible(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 4),
            child: Text(
              '${handoffAgentLabel(choice.agent)} — ${choice.isTerminal ? 'term' : 'chat'}',
              overflow: TextOverflow.ellipsis,
              style: _mono(8, const Color(0xFFE8EAEE)),
            ),
          ),
        ),
        PopupMenuButton<({String agent, bool isTerminal})>(
          tooltip: 'Switch lane',
          padding: EdgeInsets.zero,
          color: theme.panelBg,
          onSelected: (route) => setState(() {
            _agent = route.agent;
            _isTerminal = route.isTerminal;
          }),
          itemBuilder: (_) => [
            if (widget.chatAgents.isNotEmpty)
              PopupMenuItem(
                enabled: false,
                height: 28,
                child: Text('CHAT', style: _mono(8, theme.textDim,
                    weight: FontWeight.w600)),
              ),
            for (final agent in widget.chatAgents)
              PopupMenuItem(
                value: (agent: agent, isTerminal: false),
                child: Text(handoffAgentLabel(agent),
                    style: _mono(10, theme.textPrimary)),
              ),
            if (widget.terminalAgents.isNotEmpty)
              PopupMenuItem(
                enabled: false,
                height: 28,
                child: Text('TERMINAL', style: _mono(8, theme.textDim,
                    weight: FontWeight.w600)),
              ),
            for (final agent in widget.terminalAgents)
              PopupMenuItem(
                value: (agent: agent, isTerminal: true),
                child: Text(handoffAgentLabel(agent),
                    style: _mono(10, theme.textPrimary)),
              ),
          ],
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
            decoration: const BoxDecoration(
              border: Border(left: BorderSide(color: Color(0x24FFFFFF))),
            ),
            child: Text('▾', style: _mono(8, const Color(0xFF6C707E))),
          ),
        ),
      ]),
    );
  }
}
