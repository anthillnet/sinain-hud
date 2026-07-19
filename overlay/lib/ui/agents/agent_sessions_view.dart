import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/models/agent_session.dart';
import '../../core/models/context_cards.dart';
import '../../core/services/websocket_service.dart';
import '../../core/services/window_service.dart';
import 'agent_approval_card.dart';

class AgentSessionsView extends StatefulWidget {
  final bool showHeader;
  final bool showApprovals;

  /// Agent-liveness color — the user's accent from settings (default green).
  final Color accent;
  final VoidCallback? onSnapRegion;
  final ValueNotifier<String?>? externalAnswerAppend;
  final VoidCallback? onApprovalDispose;

  const AgentSessionsView({
    super.key,
    this.showHeader = true,
    this.showApprovals = true,
    this.accent = const Color(0xFF1F8039),
    this.onSnapRegion,
    this.externalAnswerAppend,
    this.onApprovalDispose,
  });

  @override
  State<AgentSessionsView> createState() => _AgentSessionsViewState();
}

class _AgentSessionsViewState extends State<AgentSessionsView> {
  static const _amber = Color(0xFFD9A21B);
  static const _doneGrey = Color(0xFF6C707E);

  List<AgentSession> _sessions = const [];
  List<AgentApprovalRequest> _approvals = const [];
  int _working = 0;
  int _waiting = 0;
  double? _usage5h;
  double? _usage7d;
  StreamSubscription<void>? _sessionsSub;
  StreamSubscription<dynamic>? _chipSub;
  WebSocketService? _ws;
  Timer? _tickTimer;

  @override
  void initState() {
    super.initState();
    _tickTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && _sessions.isNotEmpty) setState(() {});
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_sessionsSub != null) return;
    final ws = context.read<WebSocketService>();
    _ws = ws;
    _syncFrom(ws);
    _sessionsSub = ws.agentSessionsStream.listen((_) {
      if (mounted) setState(() => _syncFrom(ws));
    });
    _chipSub = ws.sessionChipStream.listen((_) {
      if (mounted) setState(() {});
    });
  }

  void _syncFrom(WebSocketService ws) {
    _sessions = List.of(ws.agentSessions);
    _working = ws.agentWorking;
    _waiting = ws.agentWaiting;
    _usage5h = ws.usage5h;
    _usage7d = ws.usage7d;
    _approvals = ws.agentApprovals.values.toList()
      ..sort((a, b) => a.createdAt.compareTo(b.createdAt));
  }

  @override
  void dispose() {
    _sessionsSub?.cancel();
    _chipSub?.cancel();
    _tickTimer?.cancel();
    super.dispose();
  }

  Color _stateColor(String state) => switch (state) {
        'waiting' => _amber,
        'working' => widget.accent,
        _ => _doneGrey,
      };

  String _formatElapsed(Duration duration) {
    final seconds = duration.inSeconds.clamp(0, 359999);
    if (seconds < 60) return '${seconds}s';
    if (seconds < 3600) return '${seconds ~/ 60}m';
    return '${seconds ~/ 3600}h';
  }

  String _formatAgo(DateTime date) {
    final elapsed = DateTime.now().difference(date);
    return '${_formatElapsed(elapsed)} ago';
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 10),
      children: [
        if (widget.showHeader) _buildHeader(),
        if (widget.showApprovals && _approvals.isNotEmpty) ...[
          const SizedBox(height: 7),
          AgentApprovalCard(
            request: _approvals.first,
            onSnapRegion: widget.onSnapRegion,
            externalAnswerAppend: widget.externalAnswerAppend,
            onDispose: widget.onApprovalDispose,
            onReply: (behavior) => context
                .read<WebSocketService>()
                .sendAgentApprovalReply(_approvals.first.id, behavior),
          ),
        ],
        const SizedBox(height: 7),
        if (_sessions.isEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 28),
            child: Center(
              child: Text(
                'no agent sessions',
                style: TextStyle(
                  fontFamily: 'JetBrainsMono',
                  fontSize: 10,
                  color: Colors.white.withValues(alpha: 0.28),
                ),
              ),
            ),
          )
        else
          for (final session in _sessions) ...[
            _buildSessionCard(session),
            const SizedBox(height: 5),
          ],
      ],
    );
  }

  Widget _buildHeader() {
    return Row(
      children: [
        const Text(
          'Agents',
          style: TextStyle(
            color: Colors.white,
            fontSize: 13,
            fontWeight: FontWeight.w700,
          ),
        ),
        const Spacer(),
        Text(
          '$_working working${_waiting > 0 ? ' · $_waiting waiting' : ''}',
          style: TextStyle(
            fontFamily: 'JetBrainsMono',
            fontSize: 10,
            color: Colors.white.withValues(alpha: 0.48),
          ),
        ),
        if (_usage5h != null) ...[
          const SizedBox(width: 6),
          _chip('5h ${_usage5h!.round()}%'),
        ],
        if (_usage7d != null) ...[
          const SizedBox(width: 6),
          _chip('7d ${_usage7d!.round()}%'),
        ],
      ],
    );
  }

  Widget _buildSessionCard(AgentSession session) {
    if (session.state == 'done') return _buildDoneReceipt(session);
    final color = _stateColor(session.state);
    final waiting = session.state == 'waiting';
    return Container(
      padding: const EdgeInsets.all(9),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.035),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(
          color: waiting
              ? _amber.withValues(alpha: 0.4)
              : Colors.white.withValues(alpha: 0.08),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              _dot(color),
              const SizedBox(width: 7),
              Expanded(
                child: Text.rich(
                  TextSpan(children: [
                    if (_sessionLabel(session) case final label?)
                      TextSpan(
                        text: '· $label  ',
                        style: const TextStyle(
                          color: Color(0xFF9B7BE3),
                          fontFamily: 'JetBrainsMono',
                          fontSize: 9,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    TextSpan(text: session.name),
                  ]),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              const SizedBox(width: 7),
              Text(
                '${session.state} · ${_formatElapsed(session.elapsed)}',
                style: TextStyle(
                  fontFamily: 'JetBrainsMono',
                  color: color,
                  fontSize: 9,
                ),
              ),
              if (session.term.isNotEmpty) ...[
                const SizedBox(width: 7),
                _jumpButton(session),
              ],
            ],
          ),
          if (session.toolLine?.trim().isNotEmpty ?? false) ...[
            const SizedBox(height: 6),
            Text(
              session.toolLine!,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontFamily: 'JetBrainsMono',
                color: waiting
                    ? const Color(0xFFE8DCC0)
                    : Colors.white.withValues(alpha: 0.46),
                fontSize: 10,
              ),
            ),
          ],
          const SizedBox(height: 7),
          Wrap(
            spacing: 4,
            runSpacing: 4,
            children: [
              if (session.source.trim().isNotEmpty) _chip(session.source),
              if (session.model?.trim().isNotEmpty ?? false)
                _chip(session.model!),
              if (session.branch?.trim().isNotEmpty ?? false)
                _chip('⎇ ${session.branch}'),
            ],
          ),
        ],
      ),
    );
  }

  String? _sessionLabel(AgentSession session) {
    final threadId = session.threadId;
    if (threadId == null || threadId.isEmpty) return null;
    for (final chip in _ws?.sessionChips.values ?? const <SessionChipState>[]) {
      if (chip.threadId == threadId) return chip.label;
    }
    return null;
  }

  Widget _buildDoneReceipt(AgentSession session) {
    final detail = (session.summary?.trim().isNotEmpty ?? false)
        ? session.summary!
        : (session.toolLine?.trim().isNotEmpty ?? false)
            ? session.toolLine!
            : 'done';
    return Opacity(
      opacity: 0.55,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(5),
          border: Border.all(color: const Color(0x1FFFFFFF)),
        ),
        child: Row(
          children: [
            _dot(_doneGrey),
            const SizedBox(width: 7),
            Expanded(
              child: Text(
                '${session.name} · $detail',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: Colors.white, fontSize: 10),
              ),
            ),
            const SizedBox(width: 8),
            Text(
              _formatAgo(session.endedAt ?? session.lastEventAt),
              style: const TextStyle(
                fontFamily: 'JetBrainsMono',
                color: Colors.white,
                fontSize: 9,
              ),
            ),
            if (session.term.isNotEmpty) ...[
              const SizedBox(width: 7),
              _jumpButton(session),
            ],
          ],
        ),
      ),
    );
  }

  Widget _chip(String value) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: Colors.white.withValues(alpha: 0.12)),
      ),
      child: Text(
        value,
        style: TextStyle(
          fontFamily: 'JetBrainsMono',
          fontSize: 10,
          color: Colors.white.withValues(alpha: 0.55),
        ),
      ),
    );
  }

  Widget _jumpButton(AgentSession session) {
    return Tooltip(
      message: 'Jump to terminal',
      child: InkWell(
        onTap: () => context.read<WindowService>().jumpToTerminal(session.term),
        borderRadius: BorderRadius.circular(3),
        child: const Padding(
          padding: EdgeInsets.symmetric(horizontal: 3, vertical: 1),
          child: Text(
            '⏵',
            style: TextStyle(
              color: Colors.white,
              fontFamily: 'JetBrainsMono',
              fontSize: 10,
            ),
          ),
        ),
      ),
    );
  }

  Widget _dot(Color color) => Container(
        width: 7,
        height: 7,
        decoration: BoxDecoration(color: color, shape: BoxShape.circle),
      );
}
