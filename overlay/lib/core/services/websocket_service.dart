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
  String _micState = 'muted';
  String _screenState = 'off';
  bool _audioFeedEnabled = true;
  bool _screenFeedEnabled = true;

  // Messages received before the connection `ready` future resolves are buffered
  // here and drained in order once `_connected` is set to true.
  final List<dynamic> _preReadyBuffer = [];

  // Connection lifecycle counters for diagnostics
  int _connectAttempts = 0;
  int _successfulConnects = 0;
  DateTime? _connectedAt;

  final _feedController = StreamController<FeedItem>.broadcast();
  final _agentFeedController = StreamController<FeedItem>.broadcast();
  final _statusController = StreamController<Map<String, dynamic>>.broadcast();
  final _scrollController = StreamController<String>.broadcast();
  final _spawnTaskController = StreamController<SpawnTask>.broadcast();
  final _copyController = StreamController<String>.broadcast();

  Stream<FeedItem> get feedStream => _feedController.stream;
  Stream<FeedItem> get agentFeedStream => _agentFeedController.stream;
  Stream<Map<String, dynamic>> get statusStream => _statusController.stream;
  Stream<String> get scrollStream => _scrollController.stream;
  Stream<SpawnTask> get spawnTaskStream => _spawnTaskController.stream;
  Stream<String> get copyStream => _copyController.stream;
  bool get connected => _connected;
  String get audioState => _audioState;
  String get micState => _micState;
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

  void requestCopy(String activeTab) {
    _copyController.add(activeTab);
  }

  /// Send a HUD engagement event to sinain-core for feedback signal collection.
  /// [action] must be one of: 'copy', 'scroll', 'dismissed'.
  void sendEngagement(String action) {
    send({
      'type': 'hud_engagement',
      'action': action,
      'ts': DateTime.now().millisecondsSinceEpoch,
    });
  }

  WebSocketService({this.url = 'ws://localhost:9500'});

  void connect() {
    if (_disposed) return;
    _doConnect();
  }

  void _doConnect() {
    _connectAttempts++;
    _log('connect attempt #$_connectAttempts → $url');

    // Cancel the old subscription before touching the channel so we never have
    // two active subscriptions on different channels. Failing to cancel here
    // is the root cause of duplicate message processing across reconnects.
    _subscription?.cancel();
    _subscription = null;

    try {
      final uri = Uri.parse(url);
      _channel = WebSocketChannel.connect(uri);

      // Wait for the connection to actually be ready before marking connected
      // and draining the pre-ready buffer.
      _channel!.ready.then((_) {
        _connected = true;
        _connectedAt = DateTime.now();
        _retryCount = 0;
        _successfulConnects++;
        notifyListeners();
        _log('connected ✓ (attempt #$_connectAttempts, successful connects=$_successfulConnects)');

        // Drain messages buffered before ready resolved, in order
        if (_preReadyBuffer.isNotEmpty) {
          _log('draining ${_preReadyBuffer.length} pre-ready buffered message(s)');
          final buffered = List<dynamic>.from(_preReadyBuffer);
          _preReadyBuffer.clear();
          for (final msg in buffered) {
            _onMessage(msg);
          }
        }

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
        _log('connection handshake failed: $e');
        _preReadyBuffer.clear(); // discard buffered messages from failed attempt
        _connected = false;
        notifyListeners();
        _scheduleReconnect();
      });

      _subscription = _channel!.stream.listen(
        (data) {
          if (_connected) {
            // Normal path: fully connected, dispatch immediately
            _onMessage(data);
          } else {
            // Pre-ready path: server sends status + replay burst before our
            // `ready` future resolves. Buffer and drain once connected.
            _preReadyBuffer.add(data);
            _log('buffered pre-ready message (buffer size=${_preReadyBuffer.length})');
          }
        },
        onError: _onError,
        onDone: _onDone,
      );
    } catch (e) {
      _log('connection failed: $e');
      _preReadyBuffer.clear();
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
          if (!_audioFeedEnabled && (item.text.startsWith('[📝]') || item.text.startsWith('[🔊]') || item.text.startsWith('[🎤]'))) break;
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
            _log('status: audio $_audioState → $audio');
            _audioState = audio;
            notifyListeners();
          }
          final mic = statusData['mic'] as String?;
          if (mic != null && mic != _micState) {
            _log('status: mic $_micState → $mic');
            _micState = mic;
            notifyListeners();
          }
          final screen = statusData['screen'] as String?;
          if (screen != null && screen != _screenState) {
            _log('status: screen $_screenState → $screen');
            _screenState = screen;
            notifyListeners();
          }
          _statusController.add(statusData);
          break;
        case 'spawn_task':
          final task = SpawnTask.fromJson(json);
          _log('SPAWN_TASK: taskId=${task.taskId} status=${task.status.name} label=${task.label}');
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
      _log('parse error: $e');
      // Try treating raw string as a simple feed message
      _feedController.add(FeedItem(
        id: DateTime.now().microsecondsSinceEpoch.toString(),
        text: data.toString(),
      ));
    }
  }

  void _onError(dynamic error) {
    final uptime = _connectedAt != null
        ? '${DateTime.now().difference(_connectedAt!).inSeconds}s uptime'
        : 'never connected';
    _log('WebSocket error ($uptime): $error');
    _connected = false;
    _connectedAt = null;
    _preReadyBuffer.clear();
    notifyListeners();
    _scheduleReconnect();
  }

  void _onDone() {
    final uptime = _connectedAt != null
        ? '${DateTime.now().difference(_connectedAt!).inSeconds}s uptime'
        : 'never connected';
    _log('WebSocket closed ($uptime), attempt #$_connectAttempts');
    _connected = false;
    _connectedAt = null;
    _preReadyBuffer.clear();
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
    _log('reconnecting in ${delay.inSeconds}s (attempt #${_connectAttempts + 1}, retryCount=$_retryCount)');
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
    _log('disconnect: stopping (connected=$_connected)');
    _profilingTimer?.cancel();
    _profilingTimer = null;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _subscription?.cancel();
    _subscription = null;
    _channel?.sink.close();
    _channel = null;
    _connected = false;
    _connectedAt = null;
    _preReadyBuffer.clear();
    notifyListeners();
  }

  @override
  void dispose() {
    _log('dispose');
    _disposed = true;
    disconnect();
    _feedController.close();
    _agentFeedController.close();
    _statusController.close();
    _scrollController.close();
    _spawnTaskController.close();
    _copyController.close();
    super.dispose();
  }

  void _log(String msg) {
    // Always log connection lifecycle events; use debugPrint to stay off the
    // release build hot path but visible in Xcode console and flutter run.
    debugPrint('[WS] $msg');
  }
}
