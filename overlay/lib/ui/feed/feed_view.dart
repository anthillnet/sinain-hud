import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/models/feed_item.dart';
import '../../core/services/websocket_service.dart';

class FeedView extends StatefulWidget {
  const FeedView({super.key});

  @override
  State<FeedView> createState() => _FeedViewState();
}

class _FeedViewState extends State<FeedView> {
  static const _maxItems = 50;
  final List<FeedItem> _items = [];
  final ScrollController _scrollController = ScrollController();
  StreamSubscription<FeedItem>? _feedSub;
  Timer? _fadeTimer;

  @override
  void initState() {
    super.initState();
    // Start fade timer — every 30s, reduce opacity of old items
    _fadeTimer = Timer.periodic(const Duration(seconds: 30), (_) => _fadeOldItems());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _feedSub ??= context.read<WebSocketService>().feedStream.listen(_onFeedItem);
  }

  void _onFeedItem(FeedItem item) {
    setState(() {
      _items.add(item);
      if (_items.length > _maxItems) {
        _items.removeRange(0, _items.length - _maxItems);
      }
    });
    // Auto-scroll to bottom
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      }
    });
  }

  void _fadeOldItems() {
    if (!mounted) return;
    final now = DateTime.now();
    setState(() {
      for (final item in _items) {
        final age = now.difference(item.timestamp).inSeconds;
        if (age > 120) {
          item.opacity = (item.opacity - 0.15).clamp(0.15, 1.0);
        } else if (age > 60) {
          item.opacity = (item.opacity - 0.05).clamp(0.3, 1.0);
        }
      }
      // Prune fully faded
      _items.removeWhere((i) => i.opacity <= 0.15 && _items.length > 10);
    });
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
    _fadeTimer?.cancel();
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_items.isEmpty) {
      return Center(
        child: Text(
          'awaiting feed…',
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
