import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:sinain_hud/core/models/agent_session.dart';
import 'package:sinain_hud/core/services/websocket_service.dart';
import 'package:sinain_hud/ui/agents/agent_sessions_view.dart';

void main() {
  test('AgentSession parses the server snapshot contract', () {
    final session = AgentSession.fromJson({
      'sessionId': 'session-1',
      'source': 'codex',
      'name': 'codex — bridge',
      'cwd': '/tmp/project',
      'model': 'gpt-5.2',
      'branch': 'main',
      'state': 'waiting',
      'toolLine': 'Edit · src/server.ts',
      'startedAt': 1720000000000,
      'lastEventAt': 1720000001000,
      'endedAt': null,
      'summary': null,
    });

    expect(session.sessionId, 'session-1');
    expect(session.source, 'codex');
    expect(session.state, 'waiting');
    expect(session.model, 'gpt-5.2');
    expect(session.branch, 'main');
    expect(session.startedAt.millisecondsSinceEpoch, 1720000000000);
    expect(session.lastEventAt.millisecondsSinceEpoch, 1720000001000);
    expect(session.endedAt, isNull);
  });

  test('AgentApprovalRequest parses the reply identifier and command', () {
    final request = AgentApprovalRequest.fromJson({
      'id': 'apr_1',
      'sessionId': 'session-1',
      'source': 'codex',
      'title': 'codex wants to run Bash',
      'command': 'npm publish --access public',
      'cwd': '/tmp/project',
      'createdAt': 1720000000000,
    });

    expect(request.id, 'apr_1');
    expect(request.sessionId, 'session-1');
    expect(request.command, 'npm publish --access public');
    expect(request.createdAt.millisecondsSinceEpoch, 1720000000000);
  });

  testWidgets('renders a waiting session card', (tester) async {
    final ws = WebSocketService();
    ws.agentSessions = [
      AgentSession.fromJson({
        'sessionId': 'session-1',
        'source': 'codex',
        'name': 'codex — bridge',
        'model': 'gpt-5.2',
        'branch': 'main',
        'state': 'waiting',
        'toolLine': 'Bash · npm publish',
        'startedAt': DateTime.now().millisecondsSinceEpoch,
        'lastEventAt': DateTime.now().millisecondsSinceEpoch,
      }),
    ];
    ws.agentWaiting = 1;

    await tester.pumpWidget(
      ChangeNotifierProvider.value(
        value: ws,
        child: const MaterialApp(
          home: SizedBox(width: 420, height: 300, child: AgentSessionsView()),
        ),
      ),
    );

    expect(find.text('codex — bridge'), findsOneWidget);
    expect(find.text('Bash · npm publish'), findsOneWidget);
    expect(find.text('0 working · 1 waiting'), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    ws.dispose();
  });
}
