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
  static const _selectionColor = Color(0xFF00E5FF);
  final List<FeedItem> _items = [];
  final ScrollController _scrollController = ScrollController();
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
        // Adjust selection to track the same message after trim
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
    switch (direction) {
      case 'up':
        setState(() {
          _autoScroll = false;
          if (_selectedIndex == null) {
            // First scroll up: select second-to-last (one above newest)
            _selectedIndex = (_items.length - 2).clamp(0, _items.length - 1);
          } else if (_selectedIndex! > 0) {
            _selectedIndex = _selectedIndex! - 1;
          }
        });
        _scrollToSelected();
      case 'down':
        setState(() {
          if (_selectedIndex == null) return;
          if (_selectedIndex! < _items.length - 1) {
            _selectedIndex = _selectedIndex! + 1;
          }
          // Reaching the last item: return to auto-scroll
          if (_selectedIndex == _items.length - 1) {
            _selectedIndex = null;
            _autoScroll = true;
          }
        });
        if (_autoScroll) {
          _scrollController.animateTo(
            _scrollController.position.maxScrollExtent,
            duration: const Duration(milliseconds: 100),
            curve: Curves.easeOut,
          );
        } else {
          _scrollToSelected();
        }
      case 'bottom':
        setState(() {
          _selectedIndex = null;
          _autoScroll = true;
        });
        _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
    }
  }

  void _scrollToSelected() {
    if (_selectedIndex == null || !_scrollController.hasClients) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients || _items.isEmpty) return;
      // Proportional scroll: estimate position based on index ratio
      final fraction = _selectedIndex! / (_items.length - 1).clamp(1, _items.length);
      final target = fraction * _scrollController.position.maxScrollExtent;
      _scrollController.animateTo(
        target.clamp(0.0, _scrollController.position.maxScrollExtent),
        duration: const Duration(milliseconds: 100),
        curve: Curves.easeOut,
      );
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
      controller: _scrollController,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      itemCount: _items.length,
      itemBuilder: (context, index) {
        final item = _items[index];
        final color = _priorityColor(item.priority);
        final isSelected = index == _selectedIndex;
        return Opacity(
          opacity: item.opacity,
          child: Container(
            decoration: isSelected
                ? BoxDecoration(
                    border: Border(
                      left: BorderSide(
                        color: _selectionColor.withValues(alpha: 0.6),
                        width: 2,
                      ),
                    ),
                  )
                : null,
            padding: EdgeInsets.only(
              left: isSelected ? 4 : 0,
              top: 1,
              bottom: 1,
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Timestamp
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
                  child: MarkdownBody(
                    data: item.text,
                    shrinkWrap: true,
                    softLineBreak: true,
                    styleSheet: MarkdownStyleSheet(
                      p: TextStyle(
                        fontFamily: 'JetBrainsMono',
                        fontSize: 12,
                        color: color,
                        height: 1.3,
                      ),
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
