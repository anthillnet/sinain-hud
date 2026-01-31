import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/models/feed_item.dart';
import '../../core/services/websocket_service.dart';

class AlertCard extends StatefulWidget {
  const AlertCard({super.key});

  @override
  State<AlertCard> createState() => _AlertCardState();
}

class _AlertCardState extends State<AlertCard> with SingleTickerProviderStateMixin {
  FeedItem? _currentAlert;
  StreamSubscription<FeedItem>? _feedSub;
  Timer? _dismissTimer;
  late AnimationController _glowController;

  @override
  void initState() {
    super.initState();
    _glowController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1500),
    )..repeat(reverse: true);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _feedSub ??= context.read<WebSocketService>().feedStream.listen(_onFeedItem);
  }

  void _onFeedItem(FeedItem item) {
    // Only show high/urgent alerts in alert mode
    if (item.priority == FeedPriority.normal) return;

    setState(() {
      _currentAlert = item;
    });

    // Auto-dismiss after 10s
    _dismissTimer?.cancel();
    _dismissTimer = Timer(const Duration(seconds: 10), () {
      if (mounted) {
        setState(() => _currentAlert = null);
      }
    });
  }

  void _dismiss() {
    _dismissTimer?.cancel();
    setState(() => _currentAlert = null);
  }

  Color get _borderColor {
    if (_currentAlert?.priority == FeedPriority.urgent) {
      return const Color(0xFFFF3344);
    }
    return const Color(0xFFFFAB00);
  }

  @override
  void dispose() {
    _feedSub?.cancel();
    _dismissTimer?.cancel();
    _glowController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_currentAlert == null) {
      return Center(
        child: Text(
          '—',
          style: TextStyle(
            fontFamily: 'JetBrainsMono',
            fontSize: 14,
            color: Colors.white.withValues(alpha: 0.1),
          ),
        ),
      );
    }

    return GestureDetector(
      onTap: _dismiss,
      child: Center(
        child: AnimatedBuilder(
          listenable: _glowController,
          builder: (context, child) {
            final glowIntensity = 0.3 + (_glowController.value * 0.4);
            return Container(
              margin: const EdgeInsets.all(16),
              padding: const EdgeInsets.all(20),
              constraints: const BoxConstraints(maxWidth: 280),
              decoration: BoxDecoration(
                color: Colors.black.withValues(alpha: 0.9),
                borderRadius: BorderRadius.circular(4),
                border: Border.all(
                  color: _borderColor.withValues(alpha: 0.7),
                  width: 1.5,
                ),
                boxShadow: [
                  BoxShadow(
                    color: _borderColor.withValues(alpha: glowIntensity),
                    blurRadius: 20,
                    spreadRadius: 2,
                  ),
                  BoxShadow(
                    color: _borderColor.withValues(alpha: glowIntensity * 0.3),
                    blurRadius: 40,
                    spreadRadius: 8,
                  ),
                ],
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Priority badge
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    decoration: BoxDecoration(
                      color: _borderColor.withValues(alpha: 0.2),
                      borderRadius: BorderRadius.circular(2),
                    ),
                    child: Text(
                      _currentAlert!.priority == FeedPriority.urgent
                          ? '⚠ URGENT'
                          : '! ALERT',
                      style: TextStyle(
                        fontFamily: 'JetBrainsMono',
                        fontSize: 10,
                        color: _borderColor,
                        fontWeight: FontWeight.bold,
                        letterSpacing: 2,
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  // Message text
                  Text(
                    _currentAlert!.text,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontFamily: 'JetBrainsMono',
                      fontSize: 15,
                      color: Colors.white.withValues(alpha: 0.95),
                      height: 1.4,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'tap to dismiss',
                    style: TextStyle(
                      fontFamily: 'JetBrainsMono',
                      fontSize: 9,
                      color: Colors.white.withValues(alpha: 0.2),
                    ),
                  ),
                ],
              ),
            );
          },
        ),
      ),
    );
  }
}

/// Like AnimatedBuilder but works with newer Flutter
class AnimatedBuilder extends AnimatedWidget {
  final Widget Function(BuildContext, Widget?) builder;

  const AnimatedBuilder({
    super.key,
    required super.listenable,
    required this.builder,
  });

  Animation<double> get animation => listenable as Animation<double>;

  @override
  Widget build(BuildContext context) {
    return builder(context, null);
  }
}
