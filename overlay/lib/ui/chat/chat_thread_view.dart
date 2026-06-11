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
  });

  final WebSocketService ws;
  final void Function(String text) onSend;

  /// null → MAIN; otherwise a region/forked thread id.
  final String? threadId;
  final int accentColor;

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
    // Thinking indicator: core broadcasts {thinking:true} when the user's
    // message is dispatched and {thinking:false} when the response lands.
    // MAIN only — region threads show progress via the tab's ⟳ badge.
    if (widget.threadId == null) {
      _thinkSub = widget.ws.thinkingStream.listen((active) {
        if (mounted) setState(() => _thinking = active);
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
    final chat = Chat(
      chatController: _controller,
      currentUserId: 'user',
      onMessageSend: (text) {
        final t = text.trim();
        if (t.isNotEmpty) widget.onSend(t);
      },
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
        Expanded(child: SelectionArea(child: chat)),
      ],
    );
  }
}
