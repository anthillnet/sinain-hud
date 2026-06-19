import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_chat_core/flutter_chat_core.dart';
import 'package:flutter_chat_ui/flutter_chat_ui.dart';

import '../../core/models/feed_item.dart';
import '../../core/services/websocket_service.dart';
import '../feed/idle_animation.dart';

/// Chat surface for a thread (chat-threads redesign).
///
/// One flyer-chat instance per thread. MAIN (threadId null) renders the
/// agent feed channel — ambient escalation responses and the user's own
/// messages; a region thread renders that region's conversation. Message
/// transport stays our WebSocket: the flyer composer routes through
/// [onSend], and displayed messages come from the WS echo (no local
/// insertion → no dedup problem).
///
/// Controllers are cached per thread so history survives tab switches —
/// same lifecycle pattern as ThreadTerminalSession.
class ChatThreadView extends StatefulWidget {
  const ChatThreadView({
    super.key,
    required this.ws,
    required this.onSend,
    this.threadId,
    this.accentColor = 0xff00ff88,
    this.onHandoff,
  });

  final WebSocketService ws;
  final void Function(String text) onSend;

  /// null → MAIN; otherwise a region/forked thread id.
  final String? threadId;
  final int accentColor;

  /// "Continue this thread elsewhere" — pick a chat or terminal agent to take
  /// over this conversation. Null hides the inline handoff (⑂) control. The
  /// shell does the actual routing (lane switch / open terminal); this widget
  /// only surfaces the destination picker.
  final void Function({
    required String agent,
    required bool isTerminal,
    required bool includeTranscript,
  })? onHandoff;

  /// Drop a thread's cached history (thread tab closed).
  static void closeThread(String threadId) {
    _controllers.remove(threadId)?.dispose();
    _seededIds.remove(threadId);
  }

  static final Map<String, InMemoryChatController> _controllers = {};
  static final Map<String, Set<String>> _seededIds = {};

  @override
  State<ChatThreadView> createState() => _ChatThreadViewState();
}

class _ChatThreadViewState extends State<ChatThreadView> {
  late final InMemoryChatController _controller;
  StreamSubscription? _sub;
  StreamSubscription? _thinkSub;
  bool _thinking = false;

  // Handoff destination popover (⑂ → "Continue this thread in").
  bool _showHandoff = false;
  bool _includeTranscript = true; // carry the conversation by default

  String get _key => widget.threadId ?? 'main';
  Set<String> get _seen =>
      ChatThreadView._seededIds.putIfAbsent(_key, () => <String>{});

  @override
  void initState() {
    super.initState();
    _controller = ChatThreadView._controllers
        .putIfAbsent(_key, () => InMemoryChatController());

    // Seed from cached history, then follow the live stream.
    final history = widget.threadId == null
        ? widget.ws.agentFeedItems
        : (widget.ws.regionThreads[widget.threadId] ?? const <FeedItem>[]);
    for (final item in history) {
      _append(item);
    }
    _sub = widget.threadId == null
        ? widget.ws.agentFeedStream.listen(_append)
        : widget.ws.regionThreadItemStream.listen((rec) {
            if (rec.$1 == widget.threadId) _append(rec.$2);
          });
    // Thinking indicator. MAIN: core broadcasts {thinking:true} when the
    // user's message is dispatched and {thinking:false} when the response
    // lands. Threads: derived from this thread's status updates — working
    // while the task is in flight, cleared on completion/failure/question.
    if (widget.threadId == null) {
      _thinkSub = widget.ws.thinkingStream.listen((active) {
        if (mounted) setState(() => _thinking = active);
      });
    } else {
      _thinkSub = widget.ws.spawnTaskStream.listen((task) {
        if (!mounted || task.regionId != widget.threadId) return;
        setState(() => _thinking = !task.isTerminal && !task.needsInput);
      });
    }
  }

  void _append(FeedItem item) {
    if (!_seen.add(item.id)) return; // already rendered (seed + stream overlap)
    _controller.insertMessage(TextMessage(
      id: item.id,
      authorId: item.sender == FeedSender.user ? 'user' : 'agent',
      createdAt: item.timestamp.toUtc(),
      text: item.text,
    ));
  }

  @override
  void dispose() {
    _sub?.cancel();
    _thinkSub?.cancel();
    // Controller intentionally NOT disposed — cached for tab switches.
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final accent = Color(widget.accentColor);
    final showHandoff = widget.onHandoff != null;
    final chat = Chat(
      chatController: _controller,
      currentUserId: 'user',
      onMessageSend: (text) {
        final t = text.trim();
        if (t.isNotEmpty) widget.onSend(t);
      },
      // Repurpose the composer's leading "attachment" slot as the inline-left
      // handoff (⑂) control — tapping it opens the destination popover.
      onAttachmentTap:
          showHandoff ? () => setState(() => _showHandoff = !_showHandoff) : null,
      resolveUser: (id) async =>
          User(id: id, name: id == 'user' ? 'You' : 'sinain'),
      builders: Builders(
        // Empty state: the HUD's idle eye animation instead of flyer's
        // "No messages" placeholder — same vibe as the old makeshift chat.
        emptyChatListBuilder: (context) => const Center(child: IdleAnimation()),
        // Desktop chat controls: Enter sends, Shift+Enter inserts a newline.
        // Composer surfaces forced to black — the default theme drew a white
        // frame around the input on our translucent panel.
        composerBuilder: (context) => Composer(
          sendOnEnter: true,
          backgroundColor: Colors.black.withValues(alpha: 0.85),
          inputFillColor: Colors.black.withValues(alpha: 0.6),
          textColor: Colors.white.withValues(alpha: 0.92),
          hintColor: Colors.white.withValues(alpha: 0.35),
          sendIconColor: accent,
          // Inline-left branch glyph (the old tab-strip ⑂, now by the input).
          attachmentIcon: showHandoff
              ? Icon(Icons.call_split,
                  size: 18, color: accent.withValues(alpha: 0.85))
              : null,
        ),
      ),
      theme: ChatTheme.dark().copyWith(
        colors: ChatTheme.dark().colors.copyWith(
              primary: accent.withValues(alpha: 0.25),
              surface: Colors.transparent,
              surfaceContainer: Colors.white.withValues(alpha: 0.06),
              surfaceContainerLow: Colors.white.withValues(alpha: 0.04),
              onPrimary: Colors.white.withValues(alpha: 0.92),
              onSurface: Colors.white.withValues(alpha: 0.88),
            ),
      ),
    );
    return Column(
      children: [
        if (_thinking)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            child: Row(
              children: [
                SizedBox(
                  width: 10,
                  height: 10,
                  child: CircularProgressIndicator(
                    strokeWidth: 1.5,
                    color: accent.withValues(alpha: 0.8),
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  'sinain is thinking…',
                  style: TextStyle(
                    fontFamily: 'JetBrainsMono',
                    fontSize: 10,
                    color: Colors.white.withValues(alpha: 0.55),
                  ),
                ),
              ],
            ),
          ),
        // SelectionArea: native text selection + ⌘C across all messages —
        // copy without per-message buttons.
        Expanded(
          child: Stack(
            children: [
              SelectionArea(child: chat),
              // Destination popover, anchored above the composer's ⑂ button.
              if (_showHandoff && widget.onHandoff != null)
                Positioned(
                  left: 8,
                  bottom: 58,
                  child: _handoffMenu(accent),
                ),
            ],
          ),
        ),
      ],
    );
  }

  /// "Continue this thread in <agent>" — lists chat and terminal destinations
  /// from the live roster plus the "include full transcript" toggle. Selecting
  /// a destination hands the routing back to the shell via [widget.onHandoff].
  Widget _handoffMenu(Color accent) {
    final ws = widget.ws;
    final chatAgents = ws.availableAgents;
    final termAgents = ws.terminalAvailable;

    Widget header(String text) => Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
          child: Text(
            text,
            style: TextStyle(
              fontSize: 9,
              letterSpacing: 0.8,
              fontWeight: FontWeight.w700,
              color: Colors.white.withValues(alpha: 0.4),
            ),
          ),
        );

    Widget option(String agent, {required bool isTerminal}) => MouseRegion(
          cursor: SystemMouseCursors.click,
          child: GestureDetector(
            onTap: () {
              setState(() => _showHandoff = false);
              widget.onHandoff!(
                agent: agent,
                isTerminal: isTerminal,
                includeTranscript: _includeTranscript,
              );
            },
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
              child: Row(
                children: [
                  Icon(isTerminal ? Icons.terminal : Icons.chat_bubble_outline,
                      size: 13, color: Colors.white.withValues(alpha: 0.55)),
                  const SizedBox(width: 8),
                  Flexible(
                    child: Text(
                      agent,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 12, color: Colors.white),
                    ),
                  ),
                ],
              ),
            ),
          ),
        );

    return Material(
      color: Colors.transparent,
      child: ConstrainedBox(
        // Bound the height so a long roster scrolls instead of overflowing
        // off the top of the chat area.
        constraints: const BoxConstraints(maxHeight: 320),
        child: Container(
        width: 220,
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: 0.92),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: accent.withValues(alpha: 0.4)),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.5),
              blurRadius: 16,
              offset: const Offset(0, 6),
            ),
          ],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(12, 12, 12, 2),
              child: Text(
                'Continue this thread in',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: Colors.white,
                ),
              ),
            ),
            // Agent groups scroll; title + transcript toggle stay pinned.
            Flexible(
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (chatAgents.isNotEmpty) ...[
                      header('CHAT'),
                      for (final a in chatAgents) option(a, isTerminal: false),
                    ],
                    if (termAgents.isNotEmpty) ...[
                      header('TERMINAL'),
                      for (final a in termAgents) option(a, isTerminal: true),
                    ],
                    if (chatAgents.isEmpty && termAgents.isEmpty)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(12, 6, 12, 10),
                        child: Text(
                          'No agents available',
                          style: TextStyle(
                              fontSize: 11,
                              color: Colors.white.withValues(alpha: 0.4)),
                        ),
                      ),
                  ],
                ),
              ),
            ),
            Container(
              height: 1,
              color: Colors.white.withValues(alpha: 0.08),
            ),
            // Carry the conversation transcript into the destination (Phase 2
            // wires the actual reseed; the choice is captured here).
            MouseRegion(
              cursor: SystemMouseCursors.click,
              child: GestureDetector(
                onTap: () =>
                    setState(() => _includeTranscript = !_includeTranscript),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          'Include full transcript',
                          style: TextStyle(
                            fontSize: 11,
                            color: Colors.white.withValues(alpha: 0.75),
                          ),
                        ),
                      ),
                      // Custom toggle (matches the agent panel's idle switch —
                      // avoids Switch API skew between local/CI Flutter).
                      AnimatedContainer(
                        duration: const Duration(milliseconds: 120),
                        width: 36,
                        height: 20,
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(10),
                          color: _includeTranscript
                              ? accent
                              : const Color(0x29FFFFFF),
                        ),
                        child: AnimatedAlign(
                          duration: const Duration(milliseconds: 120),
                          alignment: _includeTranscript
                              ? Alignment.centerRight
                              : Alignment.centerLeft,
                          child: Container(
                            margin: const EdgeInsets.all(2),
                            width: 16,
                            height: 16,
                            decoration: const BoxDecoration(
                                color: Colors.white, shape: BoxShape.circle),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
      ),
    );
  }
}
