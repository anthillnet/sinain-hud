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
  testWidgets('pins a live voice lane above tracked sessions', (tester) async {
    const chip = SessionChipState(
      sessionId: 'tracked-1',
      threadId: 'thread-1',
      status: 'running',
      label: 'visa application',
      startedTs: 1,
      activeMs: 120000,
    );
    final ws = _TestWebSocketService(
      const SessionList(sessions: [chip], bookmarks: []),
    );
    ws.voiceSession = const VoiceSession(
      status: VoiceStatus.live,
      mode: VoiceMode.webview,
      minutes: 15,
      coverage: 'last 15 minutes',
    );

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

    expect(find.byKey(const ValueKey('live-assist-lane')), findsOneWidget);
    expect(find.text('● live'), findsOneWidget);
    expect(tester.getTopLeft(find.text('● live')).dy,
        lessThan(tester.getTopLeft(find.text('visa application')).dy));

    await tester.pumpWidget(const SizedBox.shrink());
    ws.dispose();
  });

  testWidgets('groups attached lane and context card before candidate agents',
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
        'sessionId': 'agent-candidate',
        'threadId': 'proj:candidate-project',
        'candidate': true,
        'cwd': '/work/candidate-project',
        'source': 'claude',
        'name': 'candidate agent',
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
    expect(find.text('candidate · candidate-project'), findsOneWidget);
    expect(find.text('candidate agent · Bash · tests'), findsOneWidget);
    expect(find.text('unattached'), findsNothing);

    final attachedY =
        tester.getTopLeft(find.text('attached agent · Read · documents')).dy;
    final candidateY =
        tester.getTopLeft(find.text('candidate · candidate-project')).dy;
    expect(attachedY, lessThan(candidateY));

    await tester.pumpWidget(const SizedBox.shrink());
    ws.dispose();
  });

  testWidgets('island groups default closed except waiting groups',
      (tester) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    const quiet = SessionChipState(
      sessionId: 'quiet',
      threadId: 'thread-quiet',
      status: 'running',
      label: 'quiet session',
      startedTs: 1,
      activeMs: 60000,
    );
    const waiting = SessionChipState(
      sessionId: 'waiting',
      threadId: 'thread-waiting',
      status: 'running',
      label: 'waiting session',
      startedTs: 1,
      activeMs: 120000,
    );
    final ws = _TestWebSocketService(
      const SessionList(sessions: [quiet, waiting], bookmarks: []),
    );
    ws.agentSessions = [
      AgentSession.fromJson({
        'sessionId': 'agent-quiet',
        'threadId': 'thread-quiet',
        'source': 'codex',
        'name': 'quiet agent',
        'state': 'working',
        'toolLine': 'Read · code',
        'startedAt': now,
        'lastEventAt': now,
      }),
      AgentSession.fromJson({
        'sessionId': 'agent-waiting',
        'threadId': 'thread-waiting',
        'source': 'claude',
        'name': 'waiting agent',
        'state': 'waiting',
        'toolLine': 'permission needed',
        'startedAt': now,
        'lastEventAt': now,
      }),
    ];

    await tester.pumpWidget(
      ChangeNotifierProvider.value(
        value: SettingsService(),
        child: MaterialApp(
          home: SizedBox(
            width: 320,
            height: 400,
            child: SessionListView(
              ws: ws,
              islandMode: true,
              onShare: (_) {},
              onCallAi: (_) {},
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('waiting agent · permission needed'), findsOneWidget);
    expect(find.text('quiet agent · Read · code'), findsNothing);

    await tester.tap(find.byKey(const ValueKey('session-group-header-quiet')));
    await tester.pump();
    expect(find.text('quiet agent · Read · code'), findsOneWidget);

    await tester
        .tap(find.byKey(const ValueKey('session-group-header-waiting')));
    await tester.pump();
    expect(find.text('waiting agent · permission needed'), findsNothing);

    await tester.pumpWidget(const SizedBox.shrink());
    ws.dispose();
  });
}
