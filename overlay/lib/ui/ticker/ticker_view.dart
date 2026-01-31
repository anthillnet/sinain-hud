import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/models/feed_item.dart';
import '../../core/services/websocket_service.dart';

class TickerView extends StatefulWidget {
  const TickerView({super.key});

  @override
  State<TickerView> createState() => _TickerViewState();
}

class _TickerViewState extends State<TickerView>
    with SingleTickerProviderStateMixin {
  String _currentText = '';
  StreamSubscription<FeedItem>? _feedSub;
  late AnimationController _scrollController;
  late Animation<Offset> _offsetAnimation;

  @override
  void initState() {
    super.initState();
    _scrollController = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 12),
    );
    _offsetAnimation = Tween<Offset>(
      begin: const Offset(1.0, 0.0),
      end: const Offset(-1.0, 0.0),
    ).animate(CurvedAnimation(
      parent: _scrollController,
      curve: Curves.linear,
    ));
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _feedSub ??= context.read<WebSocketService>().feedStream.listen(_onFeedItem);
  }

  void _onFeedItem(FeedItem item) {
    setState(() {
      _currentText = item.text;
    });
    _scrollController.forward(from: 0.0);
  }

  @override
  void dispose() {
    _feedSub?.cancel();
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.bottomCenter,
      child: Container(
        height: 24,
        width: double.infinity,
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: 0.75),
          border: Border(
            top: BorderSide(
              color: Colors.white.withValues(alpha: 0.06),
              width: 0.5,
            ),
          ),
        ),
        child: ClipRect(
          child: _currentText.isEmpty
              ? const SizedBox.shrink()
              : SlideTransition(
                  position: _offsetAnimation,
                  child: Center(
                    child: Text(
                      _currentText,
                      maxLines: 1,
                      overflow: TextOverflow.visible,
                      softWrap: false,
                      style: TextStyle(
                        fontFamily: 'JetBrainsMono',
                        fontSize: 12,
                        color: Colors.white.withValues(alpha: 0.7),
                        letterSpacing: 0.5,
                      ),
                    ),
                  ),
                ),
        ),
      ),
    );
  }
}
