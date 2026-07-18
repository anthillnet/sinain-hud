import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:sinain_hud/core/models/agent_session.dart';
import 'package:sinain_hud/core/models/context_cards.dart';
import 'package:sinain_hud/core/services/websocket_service.dart';
import 'package:sinain_hud/core/services/settings_service.dart';
import 'package:sinain_hud/ui/capture/session_list_view.dart';

class _TestWebSocketService extends WebSocketService {
  final SessionList list;

  _TestWebSocketService(this.list);

  @override
  Future<SessionList> fetchSessionList() async => list;
}

void main() {
  testWidgets('groups attached lane and context card before unattached agents',
      (tester) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    const chip = SessionChipState(
      sessionId: 'tracked-1',
      threadId: 'thread-1',
      status: 'running',
      label: 'visa application',
      startedTs: 1,
      activeMs: 120000,
    );
    const assist = SessionAssist(
      sessionId: 'tracked-1',
      status: 'ready',
      goal: 'finish the application',
      steps: ['review documents'],
    );
    final ws = _TestWebSocketService(
      const SessionList(sessions: [chip], bookmarks: []),
    );
    ws.sessionChips[chip.sessionId] = chip;
    ws.sessionAssists[assist.sessionId] = assist;
    ws.agentSessions = [
      AgentSession.fromJson({
        'sessionId': 'agent-attached',
        'threadId': 'thread-1',
        'source': 'codex',
        'name': 'attached agent',
        'state': 'working',
        'toolLine': 'Read · documents',
        'startedAt': now,
        'lastEventAt': now,
      }),
      AgentSession.fromJson({
        'sessionId': 'agent-orphan',
        'source': 'claude',
        'name': 'orphan agent',
        'state': 'working',
        'toolLine': 'Bash · tests',
        'startedAt': now,
        'lastEventAt': now,
      }),
    ];

    await tester.pumpWidget(
      ChangeNotifierProvider.value(
        value: SettingsService(),
        child: MaterialApp(
          home: SizedBox(
            width: 520,
            height: 700,
            child: SessionListView(
              ws: ws,
              onShare: (_) {},
              onCallAi: (_) {},
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('visa application'), findsOneWidget);
    expect(find.text('card · goal: finish the application'), findsOneWidget);
    expect(find.text('attached agent · Read · documents'), findsOneWidget);
    expect(find.text('unattached'), findsOneWidget);
    expect(find.text('orphan agent · Bash · tests'), findsOneWidget);

    final attachedY =
        tester.getTopLeft(find.text('attached agent · Read · documents')).dy;
    final unattachedY = tester.getTopLeft(find.text('unattached')).dy;
    expect(attachedY, lessThan(unattachedY));

    await tester.pumpWidget(const SizedBox.shrink());
    ws.dispose();
  });
}
