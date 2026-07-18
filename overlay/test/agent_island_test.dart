import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:sinain_hud/core/models/agent_session.dart';
import 'package:sinain_hud/core/services/websocket_service.dart';
import 'package:sinain_hud/ui/agents/agent_approval_card.dart';
import 'package:sinain_hud/ui/agents/agent_island_bar.dart';
import 'package:sinain_hud/ui/feed/idle_animation.dart';

class _RecordingWebSocketService extends WebSocketService {
  String? reply;

  @override
  void sendAgentApprovalReply(String id, String behavior) {
    reply = behavior;
  }
}

void main() {
  testWidgets('island bar renders working and amber waiting counts',
      (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Align(
          alignment: Alignment.topCenter,
          child: SizedBox(
            width: 284,
            child: AgentIslandBar(
              working: 2,
              waiting: 1,
              accent: const Color(0xFF1F8039),
              onEyeTap: () {},
              onEyeDragUpdate: (_) {},
              onEyeDragEnd: (_) {},
              onCountsTap: () {},
            ),
          ),
        ),
      ),
    );

    expect(find.text('2 working'), findsOneWidget);
    final waiting = tester.widget<Text>(find.text('1 waiting'));
    expect(waiting.style?.color, const Color(0xFFD9A21B));
  });

  testWidgets('notch island leaves the cutout gap on a pure-black bar',
      (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Align(
          alignment: Alignment.topCenter,
          child: SizedBox(
            width: 46 + 180 + 132,
            child: AgentIslandBar(
              working: 2,
              waiting: 0,
              accent: const Color(0xFF1F8039),
              notchGap: 180,
              notchHeight: 37,
              onEyeTap: () {},
              onEyeDragUpdate: (_) {},
              onEyeDragEnd: (_) {},
              onCountsTap: () {},
            ),
          ),
        ),
      ),
    );

    final eye = find.byType(IdleAnimation);
    final counts = find.text('2 working');
    expect(eye, findsOneWidget);
    expect(counts, findsOneWidget);
    expect(tester.getRect(counts).left - tester.getRect(eye).right,
        greaterThanOrEqualTo(180));
    final bar = tester.widget<Container>(find.byWidgetPredicate(
      (widget) =>
          widget is Container &&
          widget.decoration is BoxDecoration &&
          (widget.decoration as BoxDecoration).color == const Color(0xFF000000),
    ));
    expect((bar.decoration as BoxDecoration).color, const Color(0xFF000000));
    expect(tester.takeException(), isNull);
  });

  testWidgets('notch island with waiting count never overflows the wing',
      (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Align(
          alignment: Alignment.topCenter,
          child: SizedBox(
            width: 46 + 180 + 236,
            child: AgentIslandBar(
              working: 12,
              waiting: 3,
              accent: const Color(0xFF1F8039),
              notchGap: 180,
              notchHeight: 37,
              onEyeTap: () {},
              onEyeDragUpdate: (_) {},
              onEyeDragEnd: (_) {},
              onCountsTap: () {},
            ),
          ),
        ),
      ),
    );
    expect(find.text('12 working'), findsOneWidget);
    expect(find.text('3 waiting'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('approval card renders request and sends allow reply',
      (tester) async {
    final ws = _RecordingWebSocketService();
    final request = AgentApprovalRequest(
      id: 'approval-1',
      sessionId: 'session-1',
      source: 'codex',
      title: 'codex wants to run a command',
      command: 'flutter test',
      createdAt: DateTime.now(),
    );

    await tester.pumpWidget(
      ChangeNotifierProvider<WebSocketService>.value(
        value: ws,
        child: MaterialApp(
          home: AgentApprovalCard(
            request: request,
            onReply: (behavior) => ws.sendAgentApprovalReply(
              request.id,
              behavior,
            ),
          ),
        ),
      ),
    );

    expect(find.text('codex wants to run a command'), findsOneWidget);
    expect(find.text('flutter test'), findsOneWidget);
    await tester.tap(find.text('Allow'));
    expect(ws.reply, 'allow');

    await tester.pumpWidget(const SizedBox.shrink());
    ws.dispose();
  });
}
