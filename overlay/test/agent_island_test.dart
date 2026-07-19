import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:sinain_hud/core/models/agent_session.dart';
import 'package:sinain_hud/core/models/context_cards.dart';
import 'package:sinain_hud/core/models/region_highlight.dart';
import 'package:sinain_hud/core/services/websocket_service.dart';
import 'package:sinain_hud/core/services/settings_service.dart';
import 'package:sinain_hud/ui/agents/agent_approval_card.dart';
import 'package:sinain_hud/ui/agents/agent_island_bar.dart';
import 'package:sinain_hud/ui/feed/idle_animation.dart';
import 'package:sinain_hud/ui/regions/region_route_card.dart';

class _RecordingWebSocketService extends WebSocketService {
  String? reply;
  String? answer;

  @override
  void sendAgentApprovalReply(String id, String behavior, {String? answer}) {
    reply = behavior;
    this.answer = answer;
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

  testWidgets('tracked-label state renders violet label pill', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: AgentIslandBar(
        working: 0,
        waiting: 0,
        trackedLabel: 'visa-app',
        trackedActiveMs: const Duration(minutes: 25).inMilliseconds,
        accent: const Color(0xFF3369D6),
        onEyeTap: () {},
        onEyeDragUpdate: (_) {},
        onEyeDragEnd: (_) {},
        onCountsTap: () {},
      ),
    ));

    expect(find.text('visa-app · 25m'), findsOneWidget);
    expect(
      find.byWidgetPredicate((widget) =>
          widget is Container &&
          widget.decoration is BoxDecoration &&
          (widget.decoration as BoxDecoration).color ==
              const Color(0xFF7A56D6)),
      findsOneWidget,
    );
  });

  testWidgets('save-offer state renders green save pill', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: AgentIslandBar(
        working: 0,
        waiting: 0,
        saveOfferLabel: 'goal met · 6 facts',
        accent: const Color(0xFF3369D6),
        onEyeTap: () {},
        onEyeDragUpdate: (_) {},
        onEyeDragEnd: (_) {},
        onCountsTap: () {},
      ),
    ));

    final label = tester.widget<Text>(find.text('save? goal met · 6 facts'));
    expect(label.style?.color, const Color(0xFFCDE8D4));
  });

  testWidgets('live assist overrides every other island state', (tester) async {
    var tapped = false;
    await tester.pumpWidget(MaterialApp(
      home: AgentIslandBar(
        working: 2,
        waiting: 1,
        trackedLabel: 'visa-app',
        saveOfferLabel: 'goal met',
        enrichLabel: 'visa-app',
        liveAssist: true,
        accent: const Color(0xFF3369D6),
        onEyeTap: () {},
        onEyeDragUpdate: (_) {},
        onEyeDragEnd: (_) {},
        onCountsTap: () {},
        onLiveAssistTap: () => tapped = true,
      ),
    ));

    final live = find.text('● live · call assist');
    expect(live, findsOneWidget);
    expect(find.text('1 waiting'), findsNothing);
    expect(find.textContaining('save?'), findsNothing);
    expect(tester.widget<Text>(live).style?.color, const Color(0xFFF2C4BC));
    await tester.tap(live);
    expect(tapped, isTrue);
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
    final append = ValueNotifier<String?>(null);

    await tester.pumpWidget(
      ChangeNotifierProvider<WebSocketService>.value(
        value: ws,
        child: MaterialApp(
          home: Scaffold(
              backgroundColor: Colors.black,
              body: Center(
                  child: SizedBox(
                width: 320,
                child: AgentApprovalCard(
                  request: request,
                  externalAnswerAppend: append,
                  onReply: (behavior) => ws.sendAgentApprovalReply(
                    request.id,
                    behavior,
                  ),
                  onReplyWithAnswer: (behavior, {answer}) =>
                      ws.sendAgentApprovalReply(request.id, behavior,
                          answer: answer),
                ),
              ))),
        ),
      ),
    );

    expect(find.text('codex wants to run a command'), findsOneWidget);
    expect(find.text('flutter test'), findsOneWidget);
    append.value = '[screen] selected text';
    await tester.pump();
    expect(find.textContaining('[screen] selected text'), findsOneWidget);
    await tester.enterText(
        find.byType(TextField), 'Please preserve the lockfile');
    await tester.tap(find.text('Allow'));
    expect(ws.reply, 'allow');
    expect(ws.answer, 'Please preserve the lockfile');

    await tester.pumpWidget(const SizedBox.shrink());
    append.dispose();
    ws.dispose();
  });

  testWidgets('ROI card composes region and context then routes chosen lane',
      (tester) async {
    RegionRoute? routed;
    await tester.pumpWidget(ChangeNotifierProvider.value(
      value: SettingsService(),
      child: MaterialApp(
        home: Scaffold(
          backgroundColor: Colors.black,
          body: Center(
            child: SizedBox(
              width: 320,
              child: RegionRouteCard(
                region: const RegionHighlight(
                  id: 'r-man-test',
                  issue: 'Submit button overlaps the footer',
                  tip: 'captured checkout panel',
                ),
                sessions: const [
                  SessionChipState(
                    sessionId: 'session-1',
                    status: 'running',
                    label: 'visa-app',
                    startedTs: 1,
                    activeMs: 1000,
                  ),
                  SessionChipState(
                    sessionId: 'session-2',
                    status: 'running',
                    label: 'docs',
                    startedTs: 2,
                    activeMs: 1000,
                  ),
                ],
                assists: const {
                  'session-1': SessionAssist(
                    sessionId: 'session-1',
                    status: 'ready',
                    goal: 'ship the checkout fix',
                    steps: ['test the corrected layout'],
                  ),
                  'session-2': SessionAssist(
                    sessionId: 'session-2',
                    status: 'ready',
                    goal: 'publish the docs',
                    steps: ['review examples'],
                  ),
                },
                initialSessionId: 'session-1',
                chatAgents: const ['sinain', 'claude-desktop'],
                terminalAgents: const ['codex'],
                initialChatAgent: 'sinain',
                initialTerminalAgent: 'codex',
                onRoute: (route) => routed = route,
                onDismiss: () {},
              ),
            ),
          ),
        ),
      ),
    ));

    expect(find.textContaining('Submit button overlaps'), findsOneWidget);
    expect(find.textContaining('goal · ship the checkout fix'), findsOneWidget);
    expect(find.textContaining('next · test the corrected layout'),
        findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('roi-session-picker')));
    await tester.pump();
    expect(find.text('· docs'), findsOneWidget);
    expect(find.textContaining('goal · publish the docs'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('roi-lane-selector')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Codex').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('roi-route-confirm')));
    expect(routed, (
      agent: 'codex',
      isTerminal: true,
      sessionId: 'session-2',
      agentSessionId: null
    ));
  });

  testWidgets('ROI card omits context when no session assist exists',
      (tester) async {
    await tester.pumpWidget(ChangeNotifierProvider.value(
      value: SettingsService(),
      child: MaterialApp(
        home: Scaffold(
          body: RegionRouteCard(
            region: const RegionHighlight(id: 'r-empty', issue: '', tip: ''),
            sessions: const [
              SessionChipState(
                sessionId: 'session-1',
                status: 'running',
                label: 'visa-app',
                startedTs: 1,
                activeMs: 1000,
              ),
            ],
            chatAgents: const ['sinain'],
            terminalAgents: const [],
            initialChatAgent: 'sinain',
            initialTerminalAgent: 'codex',
            onRoute: (_) {},
            onDismiss: () {},
          ),
        ),
      ),
    ));

    expect(find.textContaining('CONTEXT CARD'), findsNothing);
    expect(find.textContaining('current work'), findsNothing);
    expect(find.textContaining('continue from'), findsNothing);
  });
}
