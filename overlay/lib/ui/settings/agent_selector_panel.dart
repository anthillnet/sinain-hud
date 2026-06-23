import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/constants.dart';
import '../../core/services/websocket_service.dart';
import '../hud_tooltip.dart';

/// Popover for picking which agent handles each lane.
///
/// Two collapsed dropdowns — "Chat opens with" (the CHAT lane: MAIN + region
/// chat + idle messages, includes the built-in Sinain sidecar) and "Terminal
/// runs" (the TERM lane: interactive thread terminals, excludes Sinain). Each
/// shows the current pick with its monogram; opening one reveals only the
/// detected installs with a count, plus an Off row. An inline Idle messages
/// toggle sits below. Empty roster shows an install-and-restart hint.
class AgentSelectorPanel extends StatefulWidget {
  final VoidCallback onClose;

  const AgentSelectorPanel({super.key, required this.onClose});

  @override
  State<AgentSelectorPanel> createState() => _AgentSelectorPanelState();
}

class _AgentSelectorPanelState extends State<AgentSelectorPanel> {
  // Which dropdown is expanded: 'escalation' | 'terminal' | null.
  String? _open;

  // Design palette (Overlay UX Drafts · section F).
  static const _panelBg = Color(0xFF1E1F22);
  static const _selectBg = Color(0xFF2B2D30);
  static const _muted = Color(0xFFA8ADBD);
  static const _dim = Color(0xFF6C707E);
  static const _green = Color(0xFF1F8039);
  static const _hairline = Color(0x14FFFFFF); // rgba(255,255,255,.08)
  static const _stroke = Color(0x24FFFFFF); // rgba(255,255,255,.14)

  @override
  Widget build(BuildContext context) {
    final ws = context.watch<WebSocketService>();
    final available = ws.availableAgents;
    final terminalAvailable = ws.terminalAvailable;

    return Container(
      width: 280,
      decoration: BoxDecoration(
        color: _panelBg,
        borderRadius: BorderRadius.circular(8),
        boxShadow: const [
          BoxShadow(color: Color(0x33000000), blurRadius: 12, offset: Offset(0, 4)),
        ],
      ),
      clipBehavior: Clip.antiAlias,
      // Header pinned; the body scrolls so an expanded dropdown never overflows
      // the HUD-bounded height it's placed in (the panel is a Stack child).
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _header(),
          Flexible(
            // shrinkWrap → the panel hugs its content when short, but caps at
            // the available height and scrolls when a dropdown expands past it.
            child: ListView(
              shrinkWrap: true,
              padding: EdgeInsets.zero,
              children: [
              (available.isEmpty && terminalAvailable.isEmpty)
                  ? Padding(
                      padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
                      child: _emptyState(),
                    )
                  : Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          // Chat lane — conversational agents only (Sinain, desktop
                          // chat apps, gateways). CLI tools live in Terminal below.
                          if (available.isNotEmpty) ...[
                            _selectField(
                              label: 'Chat opens with',
                              lane: 'escalation',
                              current: ws.escalationAgent,
                              options: available,
                              // The CHAT lane may resolve to the resident Sinain sidecar.
                              builtIn: ws.escalationResident,
                            ),
                            const SizedBox(height: 16),
                          ],
                          // Terminal lane — the CLI agents (claude, openclaude, …).
                          if (terminalAvailable.isNotEmpty)
                            _selectField(
                              label: 'Terminal runs',
                              lane: 'terminal',
                              current: ws.terminalAgent,
                              options: terminalAvailable,
                              builtIn: false,
                            ),
                          const SizedBox(height: 20),
                          Container(height: 1, color: _hairline),
                          const SizedBox(height: 12),
                          _idleRow(ws),
                        ],
                      ),
                    ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _header() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: _hairline)),
      ),
      child: Row(
        children: [
          const Text(
            'AGENTS',
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.7,
              color: _muted,
            ),
          ),
          const Spacer(),
          HudTooltip(
            message: 'Close',
            child: MouseRegion(
              cursor: SystemMouseCursors.click,
              child: GestureDetector(
                onTap: widget.onClose,
                child: const Icon(Icons.close, size: 14, color: _muted),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _selectField({
    required String label,
    required String lane,
    required String current,
    required List<String> options,
    required bool builtIn,
  }) {
    final isOpen = _open == lane;
    final isOff = current.isEmpty;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: const TextStyle(fontSize: 12, color: _muted)),
        const SizedBox(height: 6),
        // Collapsed select row — current pick + chevron.
        MouseRegion(
          cursor: SystemMouseCursors.click,
          child: GestureDetector(
            onTap: () => setState(() => _open = isOpen ? null : lane),
            child: Container(
              height: 36,
              padding: const EdgeInsets.symmetric(horizontal: 10),
              decoration: BoxDecoration(
                color: _selectBg,
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: isOpen ? _green : _stroke),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: isOff
                        ? const Row(children: [
                            Icon(Icons.do_not_disturb_on_outlined,
                                size: 16, color: _muted),
                            SizedBox(width: 8),
                            Text('Off',
                                style: TextStyle(fontSize: 13, color: _muted)),
                          ])
                        : Row(children: [
                            Flexible(
                              child: Text(
                                current,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  fontSize: 13,
                                  fontWeight: FontWeight.w500,
                                  color: Colors.white,
                                  fontFamily: HudConstants.monoFont,
                                  fontFamilyFallback:
                                      HudConstants.monoFontFallbacks,
                                ),
                              ),
                            ),
                            if (builtIn) ...[
                              const SizedBox(width: 8),
                              const Text('Built in',
                                  style: TextStyle(fontSize: 11, color: _dim)),
                            ],
                          ]),
                  ),
                  Icon(isOpen ? Icons.keyboard_arrow_up : Icons.keyboard_arrow_down,
                      size: 16, color: isOpen ? _green : _muted),
                ],
              ),
            ),
          ),
        ),
        if (isOpen) _optionList(lane: lane, current: current, options: options),
      ],
    );
  }

  Widget _optionList({
    required String lane,
    required String current,
    required List<String> options,
  }) {
    return Container(
      margin: const EdgeInsets.only(top: 4),
      decoration: BoxDecoration(
        color: _selectBg,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: _stroke),
        boxShadow: const [
          BoxShadow(color: Color(0x66000000), blurRadius: 24, offset: Offset(0, 4)),
        ],
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
            child: Text(
              'Detected on your machine · ${options.length}',
              style: const TextStyle(
                  fontSize: 10, letterSpacing: 0.6, color: _dim),
            ),
          ),
          for (final agent in options)
            _optionRow(
              lane: lane,
              agent: agent,
              selected: agent == current,
            ),
          // Off row — clears the lane.
          Container(
            decoration: const BoxDecoration(
              border: Border(top: BorderSide(color: _hairline)),
            ),
            child: _plainRow(
              lane: lane,
              label: 'Off',
              leading: const Icon(Icons.do_not_disturb_on_outlined,
                  size: 16, color: _muted),
              value: '',
              color: _muted,
            ),
          ),
        ],
      ),
    );
  }

  Widget _optionRow({
    required String lane,
    required String agent,
    required bool selected,
  }) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: () => _choose(lane, agent),
        child: Container(
          color: selected ? const Color(0x291F8039) : Colors.transparent,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  agent,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 13,
                    color: Colors.white,
                    fontFamily: HudConstants.monoFont,
                    fontFamilyFallback: HudConstants.monoFontFallbacks,
                  ),
                ),
              ),
              if (selected)
                const Icon(Icons.check, size: 14, color: _green),
            ],
          ),
        ),
      ),
    );
  }

  Widget _plainRow({
    required String lane,
    required String label,
    required Widget leading,
    required String value,
    required Color color,
  }) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: () => _choose(lane, value),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          child: Row(children: [
            leading,
            const SizedBox(width: 8),
            Text(label, style: TextStyle(fontSize: 13, color: color)),
          ]),
        ),
      ),
    );
  }

  void _choose(String lane, String agent) {
    context.read<WebSocketService>().setAgent(lane, agent);
    setState(() => _open = null);
  }

  Widget _idleRow(WebSocketService ws) {
    final on = ws.idleMessagesEnabled;
    return Row(
      children: [
        const Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Idle messages',
                  style: TextStyle(
                      fontSize: 13, fontWeight: FontWeight.w600, color: Colors.white)),
              SizedBox(height: 2),
              Text('Comments when you pause',
                  style: TextStyle(fontSize: 11, color: _muted)),
            ],
          ),
        ),
        HudTooltip(
          message: on
              ? 'Idle messages on — Sinain comments while you pause (uses API tokens)'
              : 'Idle messages off',
          child: MouseRegion(
            cursor: SystemMouseCursors.click,
            child: GestureDetector(
              // Explicit set (not a blind flip): send the opposite of the
              // displayed state. Wires to the persisted idleMessagesEnabled flag.
              onTap: () => ws.sendCommand(
                  'set_idle_messages_enabled', {'enabled': !on}),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 120),
                width: 36,
                height: 20,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(10),
                  color: on ? _green : const Color(0x29FFFFFF),
                ),
                child: AnimatedAlign(
                  duration: const Duration(milliseconds: 120),
                  alignment: on ? Alignment.centerRight : Alignment.centerLeft,
                  child: Container(
                    margin: const EdgeInsets.all(2),
                    width: 16,
                    height: 16,
                    decoration: const BoxDecoration(
                        color: Colors.white, shape: BoxShape.circle),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _emptyState() {
    return const Text(
      'No agents detected.\nInstall claude / openclaude / codex / goose / junie / aider\nand restart the bare agent.',
      style: TextStyle(fontSize: 11, color: _muted, height: 1.4),
    );
  }
}
