import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import '../models/feed_item.dart';

/// WebSocket service with auto-reconnect and exponential backoff.
class WebSocketService extends ChangeNotifier {
  final String url;
  WebSocketChannel? _channel;
  StreamSubscription? _subscription;
  bool _connected = false;
  bool _disposed = false;
  int _retryCount = 0;
  Timer? _reconnectTimer;

  final _feedController = StreamController<FeedItem>.broadcast();
  final _statusController = StreamController<Map<String, dynamic>>.broadcast();

  Stream<FeedItem> get feedStream => _feedController.stream;
  Stream<Map<String, dynamic>> get statusStream => _statusController.stream;
  bool get connected => _connected;

  WebSocketService({this.url = 'ws://localhost:9500'});

  void connect() {
    if (_disposed) return;
    _doConnect();
  }

  void _doConnect() {
    try {
      final uri = Uri.parse(url);
      _channel = WebSocketChannel.connect(uri);
      _subscription = _channel!.stream.listen(
        _onMessage,
        onError: _onError,
        onDone: _onDone,
      );
      _connected = true;
      _retryCount = 0;
      notifyListeners();
      _log('Connected to $url');
    } catch (e) {
      _log('Connection failed: $e');
      _scheduleReconnect();
    }
  }

  void _onMessage(dynamic data) {
    try {
      final json = jsonDecode(data as String) as Map<String, dynamic>;
      final type = json['type'] as String?;
      switch (type) {
        case 'feed':
          final item = FeedItem.fromJson(json['data'] as Map<String, dynamic>? ?? json);
          _feedController.add(item);
          break;
        case 'status':
          _statusController.add(json['data'] as Map<String, dynamic>? ?? json);
          break;
        default:
          // Treat unknown messages as feed items with text
          if (json.containsKey('text')) {
            _feedController.add(FeedItem.fromJson(json));
          }
      }
    } catch (e) {
      _log('Parse error: $e');
      // Try treating raw string as a simple feed message
      _feedController.add(FeedItem(
        id: DateTime.now().microsecondsSinceEpoch.toString(),
        text: data.toString(),
      ));
    }
  }

  void _onError(dynamic error) {
    _log('WebSocket error: $error');
    _connected = false;
    notifyListeners();
    _scheduleReconnect();
  }

  void _onDone() {
    _log('WebSocket closed');
    _connected = false;
    notifyListeners();
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_disposed) return;
    _reconnectTimer?.cancel();
    final delay = Duration(
      milliseconds: min(30000, 1000 * pow(2, _retryCount).toInt()),
    );
    _retryCount++;
    _log('Reconnecting in ${delay.inSeconds}s (attempt $_retryCount)');
    _reconnectTimer = Timer(delay, () {
      if (!_disposed) _doConnect();
    });
  }

  void send(Map<String, dynamic> message) {
    if (_connected && _channel != null) {
      _channel!.sink.add(jsonEncode(message));
    }
  }

  void sendCommand(String command, [Map<String, dynamic>? params]) {
    send({
      'type': 'command',
      'command': command,
      if (params != null) ...params,
    });
  }

  void disconnect() {
    _reconnectTimer?.cancel();
    _subscription?.cancel();
    _channel?.sink.close();
    _connected = false;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    disconnect();
    _feedController.close();
    _statusController.close();
    super.dispose();
  }

  void _log(String msg) {
    if (kDebugMode) print('[WebSocketService] $msg');
  }
}
