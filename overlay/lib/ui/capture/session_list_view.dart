import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/constants.dart';
import '../../core/models/context_cards.dart';
import '../../core/models/agent_session.dart';
import '../../core/services/websocket_service.dart';
import '../../core/services/window_service.dart';
import '../../core/theme/hud_theme.dart';

const _green = Color(0xFF1F8039);
const _amber = Color(0xFFD9A21B);
const _violet = Color(0xFF7A56D6);
const _liveRed = Color(0xFFE06C5B);

TextStyle _mono(double size, Color color,
        {FontWeight weight = FontWeight.w400, double? height}) =>
    TextStyle(
      fontFamily: HudConstants.monoFont,
      fontSize: size,
      color: color,
      fontWeight: weight,
      height: height,
    );

/// The sessions view — the HUD's primary uncollapsed content (product call
/// 2026-07-16: the list replaces the main chat as what you see first).
///
/// TRACKING NOW: the live session (label · elapsed · paused), with ⚑ flag,
/// Call AI, and End. BOOKMARKED (§9): the ⚑ shelf — ▶ resume, ↗ share
/// (KG view), ✕ release. Hydrates from GET /capture/session/bookmarks, then
/// rides the chip stream.
class SessionListView extends StatefulWidget {
  final WebSocketService ws;
  final Color accent;

  /// ↗ share — the shell owns URL launching (KG entity page).
  final ValueChanged<SessionBookmark> onShare;

  /// Call AI over the live session's span (shell owns the summon flow).
  final ValueChanged<SessionChipState> onCallAi;

  /// Arm a manual region snap as context for a live agent session.
  final ValueChanged<String> onSteerRegion;

  /// Dense 320px presentation used by the notch island. Session groups are
  /// independently collapsible; groups with a waiting lane start expanded.
  final bool islandMode;

  const SessionListView({
    super.key,
    required this.ws,
    required this.onShare,
    required this.onCallAi,
    required this.onSteerRegion,
    this.accent = const Color(0xFF1F8039),
    this.islandMode = false,
  });

  /// Hover-preview span cap (matches the summon clamp).
  static const int maxPreviewMinutes = 120;

  @override
  State<SessionListView> createState() => _SessionListViewState();
}

class _SessionListViewState extends State<SessionListView> {
  SessionList _list = const SessionList(sessions: [], bookmarks: []);
  StreamSubscription<SessionChipState>? _chipSub;
  StreamSubscription<void>? _agentSessionsSub;
  StreamSubscription<SessionAssist>? _assistSub;
  StreamSubscription<VoiceSession>? _voiceSub;
  Timer? _ticker;
  final Map<String, DateTime> _receivedAt = {};
  bool _loaded = false;
  final Map<String, SessionAssist> _assists = {};
  final Set<String> _expandedCards = {};
  final Set<String> _expandedGroups = {};
  final Set<String> _initializedGroups = {};
  // Hover preview of the context the ✦ call would carry (cached core-side).
  String? _preview;
  String? _previewFor; // sessionId the preview belongs under
  bool _previewLoading = false;
  String? _noteEditorFor;
  String? _noteStatusFor;
  String? _noteStatus;
  final TextEditingController _noteController = TextEditingController();
  final FocusNode _noteFocus = FocusNode();
  Timer? _noteStatusTimer;

  @override
  void initState() {
    super.initState();
    _assists.addAll(widget.ws.sessionAssists);
    _list = SessionList(
      sessions: widget.ws.sessionChips.values.toList(),
      bookmarks: const [],
    );
    _refresh();
    _chipSub = widget.ws.sessionChipStream.listen((c) {
      if (!mounted) return;
      setState(() {
        final sessions = [..._list.sessions];
        sessions.removeWhere((s) => s.sessionId == c.sessionId);
        if (!c.ended) {
          sessions.insert(0, c);
          _receivedAt[c.sessionId] = DateTime.now();
        } else {
          _receivedAt.remove(c.sessionId);
        }
        _list = SessionList(sessions: sessions, bookmarks: _list.bookmarks);
      });
      // A wrap may have updated bookmark history — refetch quietly.
      if (c.ended) _refresh();
      _syncTicker();
    });
    _agentSessionsSub = widget.ws.agentSessionsStream.listen((_) {
      if (mounted) setState(() {});
    });
    _assistSub = widget.ws.sessionAssistStream.listen((assist) {
      if (mounted && assist.ready) {
        setState(() => _assists[assist.sessionId] = assist);
      }
    });
    _voiceSub = widget.ws.voiceSessionStream.listen((_) {
      if (mounted) setState(() {});
    });
    _syncTicker();
  }

  Future<void> _refresh() async {
    final list = await widget.ws.fetchSessionList();
    if (!mounted) return;
    setState(() {
      _list = list;
      final now = DateTime.now();
      for (final s in list.sessions) {
        _receivedAt[s.sessionId] = now;
      }
      _loaded = true;
    });
    _syncTicker();
  }

  void _syncTicker() {
    _ticker?.cancel();
    if (_list.sessions.any((s) => !s.paused)) {
      _ticker =
          Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
    }
  }

  @override
  void dispose() {
    _chipSub?.cancel();
    _agentSessionsSub?.cancel();
    _assistSub?.cancel();
    _voiceSub?.cancel();
    _ticker?.cancel();
    _noteStatusTimer?.cancel();
    _noteController.dispose();
    _noteFocus.dispose();
    super.dispose();
  }

  String _elapsed(SessionChipState s) {
    var ms = s.activeMs;
    if (!s.paused) {
      final at = _receivedAt[s.sessionId];
      if (at != null) ms += DateTime.now().difference(at).inMilliseconds;
    }
    final sec = ms ~/ 1000;
    return '${sec ~/ 60}:${(sec % 60).toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final t = HudTheme.of(context);
    final sessions = [..._list.sessions]..sort((a, b) {
        final aWaiting = _agentsFor(a).any((x) => x.state == 'waiting');
        final bWaiting = _agentsFor(b).any((x) => x.state == 'waiting');
        if (aWaiting != bWaiting) return aWaiting ? -1 : 1;
        return 0;
      });
    final candidateGroups = <String, List<AgentSession>>{};
    for (final agent in widget.ws.agentSessions.where((a) => a.candidate)) {
      final threadId = agent.threadId;
      if (threadId != null && threadId.isNotEmpty) {
        candidateGroups.putIfAbsent(threadId, () => []).add(agent);
      }
    }
    final liveVoice = widget.ws.voiceSession;
    if (widget.islandMode) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(10, 4, 10, 4),
        child: ListView(
          shrinkWrap: true,
          padding: EdgeInsets.zero,
          children: [
            if (liveVoice?.isActive ?? false)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: _liveLane(t, liveVoice!),
              ),
            if (sessions.isEmpty &&
                !(liveVoice?.isActive ?? false) &&
                candidateGroups.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Text(
                  _loaded ? 'nothing tracked' : ' ',
                  textAlign: TextAlign.center,
                  style: _mono(11, t.textDim),
                ),
              ),
            for (final s in sessions) ...[
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: _activeRow(t, s),
              ),
              if (_preview != null && _previewFor == s.sessionId)
                Padding(
                  padding: const EdgeInsets.fromLTRB(10, 0, 10, 6),
                  child: Text(_preview!,
                      style: _mono(9, t.textDim, height: 1.35),
                      maxLines: 4,
                      overflow: TextOverflow.ellipsis),
                ),
            ],
            for (final entry in candidateGroups.entries)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: _candidateGroup(t, entry.key, entry.value),
              ),
          ],
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Text('TRACKING NOW',
                style: _mono(10, t.textDim, weight: FontWeight.w600)),
            if (sessions.length > 1) ...[
              const SizedBox(width: 8),
              Text('${sessions.length}', style: _mono(9, t.textDim)),
            ],
          ]),
          const SizedBox(height: 6),
          if (liveVoice?.isActive ?? false) ...[
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: _liveLane(t, liveVoice!),
            ),
          ],
          if (sessions.isEmpty && !(liveVoice?.isActive ?? false))
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(
                  _loaded
                      ? 'nothing tracked — work a few minutes and Sinain will ask'
                      : ' ',
                  style: _mono(10, t.textDim)),
            )
          else
            for (final s in sessions) ...[
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: _activeRow(t, s),
              ),
              // The context preview the ✦ call would carry — on hover only.
              if (_preview != null && _previewFor == s.sessionId)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Text(_preview!,
                      style: _mono(9, t.textDim, height: 1.35),
                      maxLines: 4,
                      overflow: TextOverflow.ellipsis),
                ),
            ],
          if (candidateGroups.isNotEmpty) ...[
            const SizedBox(height: 2),
            for (final entry in candidateGroups.entries)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: _candidateGroup(t, entry.key, entry.value),
              ),
          ],
          const SizedBox(height: 14),
          Row(children: [
            Text('BOOKMARKED',
                style: _mono(10, t.textDim, weight: FontWeight.w600)),
            const SizedBox(width: 8),
            Text('${_list.bookmarks.length}', style: _mono(9, t.textDim)),
          ]),
          const SizedBox(height: 6),
          if (_list.bookmarks.isEmpty)
            Text(
                _loaded
                    ? 'nothing flagged — "⚑ Later" on a wrap card lands here'
                    : ' ',
                style: _mono(10, t.textDim))
          else
            Expanded(
              child: ListView(
                padding: EdgeInsets.zero,
                children: [
                  for (final b in _list.bookmarks) _bookmarkRow(t, b),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _liveLane(HudTheme t, VoiceSession voice) {
    final detail = voice.coverage.trim().isEmpty
        ? 'voice session'
        : 'voice session · ${voice.coverage.trim()}';
    return Container(
      key: const ValueKey('live-assist-lane'),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        border: Border.all(color: _liveRed.withValues(alpha: 0.45)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(children: [
        Container(
          width: 7,
          height: 7,
          decoration:
              const BoxDecoration(color: _liveRed, shape: BoxShape.circle),
        ),
        const SizedBox(width: 7),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
          decoration: BoxDecoration(
            color: _liveRed.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Text('● live', style: _mono(9, const Color(0xFFF2C4BC))),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(detail,
              style: _mono(10, t.textMuted),
              maxLines: 1,
              overflow: TextOverflow.ellipsis),
        ),
      ]),
    );
  }

  Widget _activeRow(HudTheme t, SessionChipState s) {
    final dot = s.paused ? _violet.withValues(alpha: 0.45) : _violet;
    final agents = _agentsFor(s)..sort(_laneOrder);
    final waiting = agents.any((agent) => agent.state == 'waiting');
    final expanded = _isGroupExpanded(s.sessionId, waiting);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        border:
            Border.all(color: (waiting ? _amber : dot).withValues(alpha: 0.4)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(children: [
        _dragSource(
            s.threadId,
            GestureDetector(
                key: ValueKey('session-group-header-${s.sessionId}'),
                behavior: HitTestBehavior.opaque,
                onTap: widget.islandMode
                    ? () => setState(() => expanded
                        ? _expandedGroups.remove(s.sessionId)
                        : _expandedGroups.add(s.sessionId))
                    : null,
                child: Row(children: [
                  Container(
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(
                      color: dot,
                      shape: BoxShape.circle,
                      boxShadow: [
                        BoxShadow(
                            color: dot.withValues(alpha: 0.3), spreadRadius: 2),
                      ],
                    ),
                  ),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Text(s.label,
                        style:
                            _mono(12, t.textPrimary, weight: FontWeight.w500),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis),
                  ),
                  Text(_elapsed(s),
                      style: _mono(10, s.paused ? _amber : t.textMuted)),
                  if (widget.islandMode) ...[
                    const SizedBox(width: 6),
                    Text(
                      s.paused
                          ? (agents.isEmpty
                              ? 'paused'
                              : 'paused · ${agents.length} agents')
                          : '${agents.length} agent${agents.length == 1 ? '' : 's'}',
                      style: _mono(9, s.paused ? _amber : t.textDim),
                    ),
                    const SizedBox(width: 5),
                    Text(expanded ? '▴' : '▾', style: _mono(8, t.textDim)),
                  ] else if (s.paused) ...[
                    const SizedBox(width: 6),
                    Text(
                      s.agentsWorking > 0
                          ? 'paused · ${s.agentsWorking} agent${s.agentsWorking == 1 ? '' : 's'} working'
                          : 'paused',
                      style: _mono(9, _amber),
                    ),
                  ],
                  if (!widget.islandMode) ...[
                    const SizedBox(width: 8),
                    MouseRegion(
                      onEnter: (_) => _loadPreview(s),
                      onExit: (_) => setState(() {
                        _preview = null;
                        _previewFor = null;
                      }),
                      child: _action(t, '✦', 'Call AI on this session',
                          () => widget.onCallAi(s)),
                    ),
                    const SizedBox(width: 5),
                    _action(t, '⚑', 'Come back later (bookmark)', () async {
                      await widget.ws.sessionAction(s.sessionId, 'flag');
                      _refresh();
                    }),
                    const SizedBox(width: 5),
                    _action(t, '✕', 'End session', () {
                      widget.ws.sessionAction(s.sessionId, 'ended');
                    }),
                  ],
                ]))),
        if (expanded) ...[
          if (widget.islandMode)
            Padding(
              padding: const EdgeInsets.only(left: 17, top: 6),
              child: Row(children: [
                MouseRegion(
                  onEnter: (_) => _loadPreview(s),
                  onExit: (_) => setState(() {
                    _preview = null;
                    _previewFor = null;
                  }),
                  child: _action(t, '✦', 'Call AI on this session',
                      () => widget.onCallAi(s)),
                ),
                const SizedBox(width: 5),
                _action(t, '⚑', 'Come back later (bookmark)', () async {
                  await widget.ws.sessionAction(s.sessionId, 'flag');
                  _refresh();
                }),
                const SizedBox(width: 5),
                _action(t, '✕', 'End session',
                    () => widget.ws.sessionAction(s.sessionId, 'ended')),
              ]),
            ),
          if (_assists[s.sessionId] case final assist?)
            _contextCard(t, s.sessionId, assist,
                forceExpanded: widget.islandMode),
          for (final agent in agents) _lane(t, agent),
        ],
      ]),
    );
  }

  bool _isGroupExpanded(String id, bool waiting) {
    if (!widget.islandMode) return true;
    if (_initializedGroups.add(id) && waiting) _expandedGroups.add(id);
    return _expandedGroups.contains(id);
  }

  List<AgentSession> _agentsFor(SessionChipState session) => widget
      .ws.agentSessions
      .where((agent) =>
          session.threadId.isNotEmpty && agent.threadId == session.threadId)
      .toList();

  int _laneOrder(AgentSession a, AgentSession b) {
    int rank(String state) => state == 'waiting'
        ? 0
        : state == 'working'
            ? 1
            : 2;
    return rank(a.state).compareTo(rank(b.state));
  }

  Widget _contextCard(HudTheme t, String sessionId, SessionAssist assist,
      {bool forceExpanded = false}) {
    final expanded = forceExpanded || _expandedCards.contains(sessionId);
    return GestureDetector(
      key: ValueKey('context-card-$sessionId'),
      onTap: forceExpanded
          ? null
          : () => setState(() => expanded
              ? _expandedCards.remove(sessionId)
              : _expandedCards.add(sessionId)),
      child: Padding(
        padding: const EdgeInsets.only(left: 17, top: 7),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('card · goal: ${assist.goal}',
              style: _mono(9, t.textMuted),
              maxLines: 1,
              overflow: TextOverflow.ellipsis),
          if (expanded) ...[
            const SizedBox(height: 5),
            Text('goal · ${assist.goal}', style: _mono(9, t.textPrimary)),
            if (assist.steps.isNotEmpty) ...[
              const SizedBox(height: 3),
              for (var i = 0; i < assist.steps.length; i++)
                Text('${i == 0 ? 'next' : '    '} · ${assist.steps[i]}',
                    style: _mono(9, t.textMuted, height: 1.35)),
            ],
          ],
        ]),
      ),
    );
  }

  Widget _lane(HudTheme t, AgentSession agent) {
    final done = agent.state == 'done';
    final live = agent.state == 'working' || agent.state == 'waiting';
    final color = agent.state == 'waiting'
        ? _amber
        : done
            ? t.textDim
            : widget.accent;
    final detail = done
        ? (agent.summary?.trim().isNotEmpty == true
            ? agent.summary!
            : agent.toolLine ?? 'done')
        : agent.toolLine ?? agent.state;
    return Opacity(
      opacity: done ? 0.55 : 1,
      child: Padding(
        padding: const EdgeInsets.only(left: 17, top: 6),
        child: Column(children: [
          Row(children: [
            Container(
              width: 7,
              height: 7,
              decoration: BoxDecoration(color: color, shape: BoxShape.circle),
            ),
            const SizedBox(width: 7),
            Expanded(
              child: Text('${agent.name} · $detail',
                  style: _mono(done ? 10 : 11, t.textMuted),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis),
            ),
            if (live) ...[
              const SizedBox(width: 5),
              _action(t, '◱', 'Add region to this session',
                  () => widget.onSteerRegion(agent.sessionId)),
              const SizedBox(width: 5),
              _action(t, '✎', 'Add a note to this session',
                  () => _toggleNoteEditor(agent.sessionId)),
            ],
            if (agent.term.isNotEmpty) ...[
              const SizedBox(width: 5),
              _action(
                  t,
                  '⏵',
                  'Jump to terminal',
                  () =>
                      context.read<WindowService>().jumpToTerminal(agent.term)),
            ],
          ]),
          if (_noteEditorFor == agent.sessionId)
            Padding(
              padding: const EdgeInsets.only(left: 14, top: 4),
              child: SizedBox(
                height: 26,
                child: Focus(
                  onKeyEvent: (_, event) {
                    if (event is KeyDownEvent &&
                        event.logicalKey == LogicalKeyboardKey.escape) {
                      _closeNoteEditor();
                      return KeyEventResult.handled;
                    }
                    return KeyEventResult.ignored;
                  },
                  child: TextField(
                    controller: _noteController,
                    focusNode: _noteFocus,
                    autofocus: true,
                    maxLines: 1,
                    style: _mono(9, t.textPrimary),
                    decoration: InputDecoration(
                      hintText: 'note for this session',
                      hintStyle: _mono(9, t.textDim),
                      contentPadding: const EdgeInsets.fromLTRB(7, 0, 2, 0),
                      enabledBorder: OutlineInputBorder(
                        borderSide: BorderSide(color: t.border),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderSide: BorderSide(color: widget.accent),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      suffixIconConstraints:
                          const BoxConstraints.tightFor(width: 26, height: 26),
                      suffixIcon: IconButton(
                        padding: EdgeInsets.zero,
                        tooltip: 'Send note',
                        icon: Text('▸', style: _mono(10, t.textMuted)),
                        onPressed: () => _submitNote(agent.sessionId),
                      ),
                    ),
                    onSubmitted: (_) => _submitNote(agent.sessionId),
                    onTapOutside: (_) => _closeNoteEditor(),
                    onEditingComplete: () {},
                  ),
                ),
              ),
            ),
          if (_noteStatusFor == agent.sessionId && _noteStatus != null)
            Align(
              alignment: Alignment.centerRight,
              child: Padding(
                padding: const EdgeInsets.only(top: 3),
                child: Text(_noteStatus!,
                    style: _mono(9,
                        _noteStatus == 'queued ✓' ? widget.accent : _liveRed)),
              ),
            ),
        ]),
      ),
    );
  }

  void _toggleNoteEditor(String sessionId) {
    if (_noteEditorFor == sessionId) {
      _closeNoteEditor();
      return;
    }
    setState(() {
      _noteEditorFor = sessionId;
      _noteController.clear();
    });
  }

  void _closeNoteEditor() {
    if (_noteEditorFor == null) return;
    setState(() {
      _noteEditorFor = null;
      _noteController.clear();
    });
  }

  Future<void> _submitNote(String sessionId) async {
    final text = _noteController.text.trim();
    if (text.isEmpty) return;
    final queued = await widget.ws.postAgentContextNote(sessionId, text);
    if (!mounted) return;
    _noteStatusTimer?.cancel();
    setState(() {
      if (queued) {
        _noteEditorFor = null;
        _noteController.clear();
      }
      _noteStatusFor = sessionId;
      _noteStatus = queued ? 'queued ✓' : 'failed';
    });
    _noteStatusTimer = Timer(const Duration(seconds: 2), () {
      if (!mounted) return;
      setState(() {
        _noteStatusFor = null;
        _noteStatus = null;
      });
    });
  }

  Widget _candidateGroup(
      HudTheme t, String threadId, List<AgentSession> agents) {
    agents.sort(_laneOrder);
    final groupId = 'candidate:$threadId';
    if (_initializedGroups.add(groupId)) _expandedGroups.add(groupId);
    final expanded = _expandedGroups.contains(groupId);
    final cwd = agents.first.cwd ?? '';
    final cwdParts =
        cwd.split(RegExp(r'[/\\]')).where((part) => part.isNotEmpty).toList();
    final name = cwdParts.isNotEmpty
        ? cwdParts.last
        : threadId.replaceFirst(RegExp(r'^(proj|cand):'), '');
    final color = _violet.withValues(alpha: 0.48);
    return DragTarget<String>(
      onWillAcceptWithDetails: (details) =>
          details.data.isNotEmpty && details.data != threadId,
      onAcceptWithDetails: (details) => widget.ws.sendCommand(
          'merge_candidate', {'candidate': threadId, 'target': details.data}),
      builder: (context, candidates, rejected) {
        final hovering = candidates.isNotEmpty;
        final hoverColor = hovering ? widget.accent : color;
        return Stack(children: [
          Positioned.fill(
            child: IgnorePointer(
              child: CustomPaint(
                painter: _DashedRoundedBorderPainter(hoverColor),
              ),
            ),
          ),
          Padding(
              key: ValueKey('candidate-group-$threadId'),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              child: Column(children: [
                GestureDetector(
                    key: ValueKey('candidate-group-header-$threadId'),
                    behavior: HitTestBehavior.opaque,
                    onTap: () => setState(() => expanded
                        ? _expandedGroups.remove(groupId)
                        : _expandedGroups.add(groupId)),
                    child: Row(children: [
                      Container(
                          width: 8,
                          height: 8,
                          decoration: BoxDecoration(
                              color: color, shape: BoxShape.circle)),
                      const SizedBox(width: 9),
                      Expanded(
                          child: Text('candidate · $name',
                              style: _mono(11, hoverColor),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis)),
                      Text(
                          '${agents.length} agent${agents.length == 1 ? '' : 's'}',
                          style: _mono(9, color)),
                      const SizedBox(width: 5),
                      Text(expanded ? '▴' : '▾', style: _mono(8, color)),
                    ])),
                if (expanded)
                  for (final agent in agents) _lane(t, agent),
              ])),
        ]);
      },
    );
  }

  /// Fetch the (core-cached) window preview for the session's span — shown
  /// under the row while hovering ✦, so the call is one click but never blind.
  Future<void> _loadPreview(SessionChipState s) async {
    if (_previewLoading) return;
    _previewLoading = true;
    try {
      final minutes =
          ((DateTime.now().millisecondsSinceEpoch - s.startedTs) / 60000)
              .ceil()
              .clamp(1, SessionListView.maxPreviewMinutes);
      final data = await widget.ws.fetchWindowPreview(minutes);
      if (!mounted) return;
      final summary = data?['summary'] as String?;
      if (summary != null && summary.isNotEmpty) {
        setState(() {
          _preview = summary;
          _previewFor = s.sessionId;
        });
      }
    } finally {
      _previewLoading = false;
    }
  }

  Widget _bookmarkRow(HudTheme t, SessionBookmark b) {
    return _dragSource(
        b.threadId,
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(children: [
            Text('⚑ ', style: _mono(11, _green)),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(b.label,
                      style: _mono(11, t.textPrimary, weight: FontWeight.w500),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis),
                  Text(b.meta, style: _mono(9, t.textDim)),
                ],
              ),
            ),
            _action(t, '▶', 'Resume', () async {
              await widget.ws.sessionBookmarkAction(b.threadId, 'resume');
              _refresh();
            }, accent: _green),
            const SizedBox(width: 5),
            _action(t, '↗', 'Share session (KG view)', () => widget.onShare(b)),
            const SizedBox(width: 5),
            _action(t, '✕', 'Release', () async {
              await widget.ws.sessionBookmarkAction(b.threadId, 'remove');
              _refresh();
            }),
          ]),
        ));
  }

  Widget _dragSource(String threadId, Widget child) {
    if (threadId.isEmpty) return child;
    final feedback = Material(
      color: Colors.transparent,
      child: Opacity(opacity: 0.85, child: SizedBox(width: 220, child: child)),
    );
    if (widget.islandMode) {
      return LongPressDraggable<String>(
          data: threadId, feedback: feedback, child: child);
    }
    return Draggable<String>(data: threadId, feedback: feedback, child: child);
  }

  Widget _action(HudTheme t, String glyph, String tooltip, VoidCallback onTap,
      {Color? accent}) {
    return Tooltip(
      message: tooltip,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          onTap: onTap,
          child: Container(
            width: 22,
            height: 22,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border:
                  Border.all(color: accent?.withValues(alpha: 0.5) ?? t.border),
            ),
            child: Text(glyph, style: _mono(9, accent ?? t.textMuted)),
          ),
        ),
      ),
    );
  }
}

class _DashedRoundedBorderPainter extends CustomPainter {
  final Color color;

  const _DashedRoundedBorderPainter(this.color);

  @override
  void paint(Canvas canvas, Size size) {
    final path = Path()
      ..addRRect(RRect.fromRectAndRadius(
          Offset.zero & size, const Radius.circular(8)));
    final metric = path.computeMetrics().first;
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    const dash = 4.0;
    const gap = 3.0;
    for (double start = 0; start < metric.length; start += dash + gap) {
      canvas.drawPath(metric.extractPath(start, start + dash), paint);
    }
  }

  @override
  bool shouldRepaint(covariant _DashedRoundedBorderPainter oldDelegate) =>
      oldDelegate.color != color;
}
