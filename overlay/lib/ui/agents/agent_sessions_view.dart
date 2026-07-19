import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/models/agent_session.dart';
import '../../core/services/websocket_service.dart';

class AgentSessionsView extends StatefulWidget {
  const AgentSessionsView({super.key});

  @override
  State<AgentSessionsView> createState() => _AgentSessionsViewState();
}

class _AgentSessionsViewState extends State<AgentSessionsView> {
  static const _amber = Color(0xFFD9A21B);
  static const _workingBlue = Color(0xFF3369D6);
  static const _doneGrey = Color(0xFF6C707E);

  List<AgentSession> _sessions = const [];
  List<AgentApprovalRequest> _approvals = const [];
  int _working = 0;
  int _waiting = 0;
  double? _usage5h;
  double? _usage7d;
  StreamSubscription<void>? _sessionsSub;
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
    _syncFrom(ws);
    _sessionsSub = ws.agentSessionsStream.listen((_) {
      if (mounted) setState(() => _syncFrom(ws));
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
    _tickTimer?.cancel();
    super.dispose();
  }

  Color _stateColor(String state) => switch (state) {
        'waiting' => _amber,
        'working' => _workingBlue,
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
        _buildHeader(),
        if (_approvals.isNotEmpty) ...[
          const SizedBox(height: 7),
          _buildApprovalCard(_approvals.first),
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

  Widget _buildApprovalCard(AgentApprovalRequest request) {
    return Container(
      padding: const EdgeInsets.all(9),
      decoration: BoxDecoration(
        color: _amber.withValues(alpha: 0.09),
        borderRadius: BorderRadius.circular(7),
        border: Border.all(color: _amber.withValues(alpha: 0.42)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              _dot(_amber),
              const SizedBox(width: 7),
              Expanded(
                child: Text(
                  request.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Color(0xFFE8DCC0),
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 7),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            decoration: BoxDecoration(
              color: Colors.black.withValues(alpha: 0.32),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Text(
              request.command,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontFamily: 'JetBrainsMono',
                color: Color(0xFFE8DCC0),
                fontSize: 10,
              ),
            ),
          ),
          const SizedBox(height: 8),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              _approvalButton(
                'Allow',
                onTap: () => _reply(request.id, 'allow'),
                filled: true,
              ),
              const SizedBox(width: 5),
              _approvalButton(
                'Always',
                onTap: () => _reply(request.id, 'always'),
                bordered: true,
              ),
              const SizedBox(width: 5),
              _approvalButton(
                'Deny',
                onTap: () => _reply(request.id, 'deny'),
                quiet: true,
              ),
            ],
          ),
        ],
      ),
    );
  }

  void _reply(String id, String behavior) {
    context.read<WebSocketService>().sendAgentApprovalReply(id, behavior);
  }

  Widget _approvalButton(
    String text, {
    required VoidCallback onTap,
    bool quiet = false,
    bool bordered = false,
    bool filled = false,
  }) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
          decoration: BoxDecoration(
            color: filled ? const Color(0xFF1F8039) : Colors.transparent,
            borderRadius: BorderRadius.circular(4),
            border: bordered
                ? Border.all(color: Colors.white.withValues(alpha: 0.25))
                : null,
          ),
          child: Text(
            text,
            style: TextStyle(
              fontFamily: 'JetBrainsMono',
              fontSize: 9,
              fontWeight: filled ? FontWeight.w700 : FontWeight.normal,
              color: quiet
                  ? Colors.white.withValues(alpha: 0.42)
                  : Colors.white.withValues(alpha: 0.9),
            ),
          ),
        ),
      ),
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
                child: Text(
                  session.name,
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

  Widget _dot(Color color) => Container(
        width: 7,
        height: 7,
        decoration: BoxDecoration(color: color, shape: BoxShape.circle),
      );
}
