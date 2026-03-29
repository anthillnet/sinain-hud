import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:provider/provider.dart';
import '../../core/models/feed_item.dart';
import '../../core/services/websocket_service.dart';
import 'idle_animation.dart';

class FeedView extends StatefulWidget {
  final FeedChannel channel;
  final String emptyLabel;

  const FeedView({
    super.key,
    this.channel = FeedChannel.stream,
    this.emptyLabel = 'awaiting feed…',
  });

  @override
  State<FeedView> createState() => _FeedViewState();
}

class _FeedViewState extends State<FeedView> {
  static const _maxItems = 50;
  static const _scrollStep = 200.0;
  static const _selectionColor = Color(0xFF00E5FF);
  final List<FeedItem> _items = [];
  final ScrollController _scrollController = ScrollController();
  final GlobalKey _listKey = GlobalKey();
  final Map<int, GlobalKey> _itemKeys = {};
  StreamSubscription<FeedItem>? _feedSub;
  StreamSubscription<String>? _scrollSub;
  StreamSubscription<String>? _copySub;
  Timer? _fadeTimer;
  bool _autoScroll = true;

  /// Index of the selected message, or null when in auto-scroll mode
  /// (last message is implicitly selected).
  int? _selectedIndex;

  @override
  void initState() {
    super.initState();
    _fadeTimer = Timer.periodic(const Duration(seconds: 30), (_) => _fadeOldItems());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final ws = context.read<WebSocketService>();

    // Restore persistent items on mount (survives state transitions)
    if (_items.isEmpty && widget.channel == FeedChannel.agent && ws.agentFeedItems.isNotEmpty) {
      _items.addAll(ws.agentFeedItems);
    }

    _feedSub ??= (widget.channel == FeedChannel.agent
            ? ws.agentFeedStream
            : ws.feedStream)
        .listen(_onFeedItem);
    _scrollSub ??= ws.scrollStream.listen(_onScrollCommand);
    _copySub ??= ws.copyStream.listen(_onCopyCommand);
  }

  void _onFeedItem(FeedItem item) {
    final trimCount = _items.length + 1 > _maxItems
        ? _items.length + 1 - _maxItems
        : 0;

    setState(() {
      _items.add(item);
      if (trimCount > 0) {
        _items.removeRange(0, trimCount);
        // Shift item keys and selection to track the same messages
        final shifted = <int, GlobalKey>{};
        for (final e in _itemKeys.entries) {
          final ni = e.key - trimCount;
          if (ni >= 0) shifted[ni] = e.value;
        }
        _itemKeys
          ..clear()
          ..addAll(shifted);
        if (_selectedIndex != null) {
          _selectedIndex = _selectedIndex! - trimCount;
          if (_selectedIndex! < 0) _selectedIndex = null;
        }
      }
    });
    if (_autoScroll) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!_scrollController.hasClients) return;
        _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
      });
    }
  }

  void _onScrollCommand(String direction) {
    if (!_scrollController.hasClients || _items.isEmpty) return;
    final pos = _scrollController.position;
    switch (direction) {
      case 'up':
        setState(() => _autoScroll = false);
        _scrollController
            .animateTo(
              (pos.pixels - _scrollStep).clamp(0.0, pos.maxScrollExtent),
              duration: const Duration(milliseconds: 150),
              curve: Curves.easeOut,
            )
            .then((_) => _updateSelectionFromScroll());
      case 'down':
        final target =
            (pos.pixels + _scrollStep).clamp(0.0, pos.maxScrollExtent);
        if (target >= pos.maxScrollExtent - 10) {
          setState(() {
            _selectedIndex = null;
            _autoScroll = true;
          });
        }
        _scrollController
            .animateTo(
              target,
              duration: const Duration(milliseconds: 150),
              curve: Curves.easeOut,
            )
            .then((_) => _updateSelectionFromScroll());
      case 'bottom':
        setState(() {
          _selectedIndex = null;
          _autoScroll = true;
        });
        _scrollController.jumpTo(pos.maxScrollExtent);
    }
  }

  void _updateSelectionFromScroll() {
    if (!mounted || _autoScroll || _items.isEmpty) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scrollController.hasClients) return;
      final listBox =
          _listKey.currentContext?.findRenderObject() as RenderBox?;
      if (listBox == null) return;
      final listTop = listBox.localToGlobal(Offset.zero).dy;

      int? bestIndex;
      double bestPos = double.infinity;
      for (final entry in _itemKeys.entries) {
        final ctx = entry.value.currentContext;
        if (ctx == null) continue;
        final box = ctx.findRenderObject() as RenderBox?;
        if (box == null || !box.hasSize) continue;
        final itemTop = box.localToGlobal(Offset.zero).dy - listTop;
        // Find the topmost item that is at least half visible
        if (itemTop >= -box.size.height / 2 && itemTop < bestPos) {
          bestPos = itemTop;
          bestIndex = entry.key;
        }
      }
      if (bestIndex != null && bestIndex != _selectedIndex) {
        setState(() => _selectedIndex = bestIndex);
      }
    });
  }

  void _onCopyCommand(String activeTab) {
    // Only respond if this FeedView's channel matches the active tab
    if (activeTab != widget.channel.name) return;
    if (_items.isEmpty) return;

    final targetText = _selectedIndex != null
        ? _items[_selectedIndex!].text
        : _items.last.text;

    Clipboard.setData(ClipboardData(text: targetText));
  }

  void _fadeOldItems() {
    if (!mounted) return;
    final now = DateTime.now();
    bool changed = false;
    for (final item in _items) {
      final age = now.difference(item.timestamp).inSeconds;
      final prevOpacity = item.opacity;
      if (age > 600) {
        item.opacity = (item.opacity - 0.15).clamp(0.15, 1.0);
      } else if (age > 300) {
        item.opacity = (item.opacity - 0.05).clamp(0.3, 1.0);
      }
      if (item.opacity != prevOpacity) changed = true;
    }
    final countBefore = _items.length;
    _items.removeWhere((i) => i.opacity <= 0.15 && _items.length > 10);
    if (_items.length != countBefore) {
      // Adjust selection after fade removal
      if (_selectedIndex != null && _selectedIndex! >= _items.length) {
        _selectedIndex = _items.isNotEmpty ? _items.length - 1 : null;
      }
      changed = true;
    }
    if (changed) setState(() {});
  }

  Color _priorityColor(FeedPriority priority) {
    switch (priority) {
      case FeedPriority.urgent:
        return const Color(0xFFFF3344);
      case FeedPriority.high:
        return const Color(0xFFFFAB00);
      case FeedPriority.normal:
        return Colors.white;
    }
  }

  @override
  void dispose() {
    _feedSub?.cancel();
    _scrollSub?.cancel();
    _copySub?.cancel();
    _fadeTimer?.cancel();
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_items.isEmpty) {
      return IdleAnimation(label: widget.emptyLabel);
    }

    return ListView.builder(
      key: _listKey,
      controller: _scrollController,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      itemCount: _items.length,
      itemBuilder: (context, index) {
        final item = _items[index];
        final itemKey = _itemKeys.putIfAbsent(index, () => GlobalKey());
        return Opacity(
          key: itemKey,
          opacity: item.opacity,
          child: GestureDetector(
            onLongPress: () {
              // Copy message text to clipboard on long-press
              Clipboard.setData(ClipboardData(text: item.text));
            },
            child: item.isUser
                ? _buildUserMessage(item)
                : item.isSpawn
                    ? _buildSpawnMessage(item)
                    : _buildAgentMessage(item, index),
          ),
        );
      },
    );
  }

  Widget _buildUserMessage(FeedItem item) {
    return Padding(
      padding: const EdgeInsets.only(left: 40, top: 2, bottom: 2),
      child: Align(
        alignment: Alignment.centerRight,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            color: const Color(0xFF1A3A4A),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: const Color(0xFF00E5FF).withValues(alpha: 0.2)),
          ),
          child: Text(
            item.text,
            style: const TextStyle(
              fontFamily: 'JetBrainsMono',
              fontSize: 12,
              color: Color(0xFF00E5FF),
              height: 1.3,
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildSpawnMessage(FeedItem item) {
    return Padding(
      padding: const EdgeInsets.only(left: 40, top: 2, bottom: 2),
      child: Align(
        alignment: Alignment.centerRight,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            color: const Color(0xFF1A3A2A),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: const Color(0xFF00E676).withValues(alpha: 0.3)),
          ),
          child: Text(
            item.text,
            style: const TextStyle(
              fontFamily: 'JetBrainsMono',
              fontSize: 12,
              color: Color(0xFF00E676),
              height: 1.3,
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildAgentMessage(FeedItem item, int index) {
    final color = _priorityColor(item.priority);
    final isSelected = index == _selectedIndex;
    return Container(
      decoration: isSelected
          ? BoxDecoration(
              border: Border(
                left: BorderSide(color: _selectionColor.withValues(alpha: 0.6), width: 2),
              ),
            )
          : null,
      padding: EdgeInsets.only(left: isSelected ? 4 : 0, top: 1, bottom: 1),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            _formatTime(item.timestamp),
            style: TextStyle(
              fontFamily: 'JetBrainsMono',
              fontSize: 10,
              color: isSelected
                  ? _selectionColor.withValues(alpha: 0.5)
                  : Colors.white.withValues(alpha: 0.25),
            ),
          ),
          const SizedBox(width: 6),
          if (item.priority != FeedPriority.normal)
            Container(
              width: 3,
              height: 12,
              margin: const EdgeInsets.only(right: 4, top: 1),
              decoration: BoxDecoration(
                color: color,
                borderRadius: BorderRadius.circular(1),
                boxShadow: [BoxShadow(color: color.withValues(alpha: 0.4), blurRadius: 3)],
              ),
            ),
          Expanded(
            child: MarkdownBody(
              data: item.text,
              shrinkWrap: true,
              softLineBreak: true,
              styleSheet: MarkdownStyleSheet(
                p: TextStyle(fontFamily: 'JetBrainsMono', fontSize: 12, color: color, height: 1.3),
                code: TextStyle(
                  fontFamily: 'JetBrainsMono',
                  fontSize: 11,
                  color: color,
                  backgroundColor: Colors.white.withValues(alpha: 0.1),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _formatTime(DateTime t) {
    return '${t.hour.toString().padLeft(2, '0')}:'
        '${t.minute.toString().padLeft(2, '0')}:'
        '${t.second.toString().padLeft(2, '0')}';
  }
}
