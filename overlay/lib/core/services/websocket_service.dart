import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import '../models/feed_item.dart';
import '../models/spawn_task.dart';

/// WebSocket service with auto-reconnect and exponential backoff.
class WebSocketService extends ChangeNotifier {
  final String url;
  WebSocketChannel? _channel;
  StreamSubscription? _subscription;
  bool _connected = false;
  bool _disposed = false;
  int _retryCount = 0;
  Timer? _reconnectTimer;
  Timer? _profilingTimer;
  final DateTime _startTime = DateTime.now();
  String _audioState = 'muted';
  String _screenState = 'off';
  bool _audioFeedEnabled = true;
  bool _screenFeedEnabled = true;

  final _feedController = StreamController<FeedItem>.broadcast();
  final _agentFeedController = StreamController<FeedItem>.broadcast();
  final _statusController = StreamController<Map<String, dynamic>>.broadcast();
  final _scrollController = StreamController<String>.broadcast();
  final _spawnTaskController = StreamController<SpawnTask>.broadcast();

  Stream<FeedItem> get feedStream => _feedController.stream;
  Stream<FeedItem> get agentFeedStream => _agentFeedController.stream;
  Stream<Map<String, dynamic>> get statusStream => _statusController.stream;
  Stream<String> get scrollStream => _scrollController.stream;
  Stream<SpawnTask> get spawnTaskStream => _spawnTaskController.stream;
  bool get connected => _connected;
  String get audioState => _audioState;
  String get screenState => _screenState;
  bool get audioFeedEnabled => _audioFeedEnabled;
  bool get screenFeedEnabled => _screenFeedEnabled;

  void toggleAudioFeed() {
    _audioFeedEnabled = !_audioFeedEnabled;
    _log('Audio feed ${_audioFeedEnabled ? "enabled" : "disabled"}');
    _feedController.add(FeedItem(
      id: DateTime.now().microsecondsSinceEpoch.toString(),
      text: 'Audio feed ${_audioFeedEnabled ? "enabled" : "disabled"}',
    ));
    notifyListeners();
  }

  void toggleScreenFeed() {
    _screenFeedEnabled = !_screenFeedEnabled;
    _log('Screen feed ${_screenFeedEnabled ? "enabled" : "disabled"}');
    _feedController.add(FeedItem(
      id: DateTime.now().microsecondsSinceEpoch.toString(),
      text: 'Screen feed ${_screenFeedEnabled ? "enabled" : "disabled"}',
    ));
    notifyListeners();
  }

  void scrollFeed(String direction) {
    _scrollController.add(direction);
  }

  WebSocketService({this.url = 'ws://localhost:9500'});

  void connect() {
    if (_disposed) return;
    _doConnect();
  }

  void _doConnect() {
    try {
      final uri = Uri.parse(url);
      _channel = WebSocketChannel.connect(uri);

      // Wait for the connection to actually be ready
      _channel!.ready.then((_) {
        _connected = true;
        _retryCount = 0;
        notifyListeners();
        _log('Connected to $url');

        // Start periodic profiling reports
        _profilingTimer?.cancel();
        _profilingTimer = Timer.periodic(const Duration(seconds: 30), (_) {
          if (_connected) {
            send({
              'type': 'profiling',
              'rssMb': (ProcessInfo.currentRss / 1048576).round(),
              'uptimeS': DateTime.now().difference(_startTime).inSeconds,
              'ts': DateTime.now().millisecondsSinceEpoch,
            });
          }
        });
      }).catchError((e) {
        _log('Connection handshake failed: $e');
        _connected = false;
        notifyListeners();
        _scheduleReconnect();
      });

      _subscription = _channel!.stream.listen(
        _onMessage,
        onError: _onError,
        onDone: _onDone,
      );
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
          _log('FEED [${item.channel.name}]: ${item.text.substring(0, item.text.length > 60 ? 60 : item.text.length)}');
          if (!_audioFeedEnabled && item.text.startsWith('[📝]')) break;
          if (!_screenFeedEnabled && item.text.startsWith('[👁]')) break;
          if (item.channel == FeedChannel.agent) {
            _agentFeedController.add(item);
          } else {
            _feedController.add(item);
          }
          break;
        case 'status':
          final statusData = json['data'] as Map<String, dynamic>? ?? json;
          final audio = statusData['audio'] as String?;
          if (audio != null && audio != _audioState) {
            _audioState = audio;
            notifyListeners();
          }
          final screen = statusData['screen'] as String?;
          if (screen != null && screen != _screenState) {
            _screenState = screen;
            notifyListeners();
          }
          _statusController.add(statusData);
          break;
        case 'spawn_task':
          final task = SpawnTask.fromJson(json);
          _log('SPAWN_TASK: taskId=${task.taskId}, status=${task.status.name}, label=${task.label}');
          _spawnTaskController.add(task);
          break;
        case 'ping':
          // Respond to app-level ping with pong
          send({'type': 'pong', 'ts': DateTime.now().millisecondsSinceEpoch});
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
      'action': command,
      if (params != null) ...params,
    });
  }

  void disconnect() {
    _profilingTimer?.cancel();
    _profilingTimer = null;
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
    _agentFeedController.close();
    _statusController.close();
    _scrollController.close();
    _spawnTaskController.close();
    super.dispose();
  }

  void _log(String msg) {
    if (kDebugMode) print('[WebSocketService] $msg');
  }
}
