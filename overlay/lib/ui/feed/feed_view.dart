import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/models/feed_item.dart';
import '../../core/services/websocket_service.dart';

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
  static const _scrollStep = 80.0;
  final List<FeedItem> _items = [];
  final ScrollController _scrollController = ScrollController();
  StreamSubscription<FeedItem>? _feedSub;
  StreamSubscription<String>? _scrollSub;
  Timer? _fadeTimer;
  bool _autoScroll = true;

  @override
  void initState() {
    super.initState();
    _fadeTimer = Timer.periodic(const Duration(seconds: 30), (_) => _fadeOldItems());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final ws = context.read<WebSocketService>();
    _feedSub ??= (widget.channel == FeedChannel.agent
            ? ws.agentFeedStream
            : ws.feedStream)
        .listen(_onFeedItem);
    _scrollSub ??= ws.scrollStream.listen(_onScrollCommand);
  }

  void _onFeedItem(FeedItem item) {
    setState(() {
      _items.add(item);
      if (_items.length > _maxItems) {
        _items.removeRange(0, _items.length - _maxItems);
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
    if (!_scrollController.hasClients) return;
    final pos = _scrollController.position;
    switch (direction) {
      case 'up':
        _autoScroll = false;
        _scrollController.animateTo(
          (pos.pixels - _scrollStep).clamp(0.0, pos.maxScrollExtent),
          duration: const Duration(milliseconds: 100),
          curve: Curves.easeOut,
        );
      case 'down':
        final target = (pos.pixels + _scrollStep).clamp(0.0, pos.maxScrollExtent);
        _scrollController.animateTo(
          target,
          duration: const Duration(milliseconds: 100),
          curve: Curves.easeOut,
        );
        // Re-enable auto-scroll when reaching bottom
        if (target >= pos.maxScrollExtent - 20) {
          _autoScroll = true;
        }
      case 'bottom':
        _autoScroll = true;
        _scrollController.jumpTo(pos.maxScrollExtent);
    }
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
    if (_items.length != countBefore) changed = true;
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
    _fadeTimer?.cancel();
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_items.isEmpty) {
      return Center(
        child: Text(
          widget.emptyLabel,
          style: TextStyle(
            fontFamily: 'JetBrainsMono',
            fontSize: 11,
            color: Colors.white.withValues(alpha: 0.2),
          ),
        ),
      );
    }

    return ListView.builder(
      controller: _scrollController,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      itemCount: _items.length,
      itemBuilder: (context, index) {
        final item = _items[index];
        final color = _priorityColor(item.priority);
        return Opacity(
          opacity: item.opacity,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 1),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Timestamp
                Text(
                  _formatTime(item.timestamp),
                  style: TextStyle(
                    fontFamily: 'JetBrainsMono',
                    fontSize: 10,
                    color: Colors.white.withValues(alpha: 0.25),
                  ),
                ),
                const SizedBox(width: 6),
                // Priority marker
                if (item.priority != FeedPriority.normal)
                  Container(
                    width: 3,
                    height: 12,
                    margin: const EdgeInsets.only(right: 4, top: 1),
                    decoration: BoxDecoration(
                      color: color,
                      borderRadius: BorderRadius.circular(1),
                      boxShadow: [
                        BoxShadow(
                          color: color.withValues(alpha: 0.4),
                          blurRadius: 3,
                        ),
                      ],
                    ),
                  ),
                // Text content
                Expanded(
                  child: Text(
                    item.text,
                    style: TextStyle(
                      fontFamily: 'JetBrainsMono',
                      fontSize: 12,
                      color: color.withValues(alpha: item.opacity),
                      height: 1.3,
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  String _formatTime(DateTime t) {
    return '${t.hour.toString().padLeft(2, '0')}:'
        '${t.minute.toString().padLeft(2, '0')}:'
        '${t.second.toString().padLeft(2, '0')}';
  }
}
