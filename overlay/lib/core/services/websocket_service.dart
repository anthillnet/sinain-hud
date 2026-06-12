import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import '../models/feed_item.dart';
import '../models/region_highlight.dart';
import '../models/thread_status.dart';

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
  String _escalationState = 'active';
  String _responseSize = 'medium';
  String _envPath = '';
  // Bare-agent roster + per-lane current choice. Populated from status
  // messages once the bare agent registers with sinain-core. Empty string
  // for a lane means "Off" (lane disabled). Empty availableAgents means
  // the bare agent hasn't registered yet (or no agents are installed).
  List<String> _availableAgents = const [];
  String _escalationAgent = '';
  String _spawnAgent = '';
  bool _agentRegistered = false;
  bool _audioFeedEnabled = true;
  bool _screenFeedEnabled = true;
  double _totalCost = 0.0;
  int _costCallCount = 0;
  bool _costDisplayEnabled = false;
  String? _systemAlertText;
  FeedPriority _systemAlertPriority = FeedPriority.normal;

  final _feedController = StreamController<FeedItem>.broadcast();
  final _agentFeedController = StreamController<FeedItem>.broadcast();
  final _statusController = StreamController<Map<String, dynamic>>.broadcast();
  final _scrollController = StreamController<String>.broadcast();
  final _spawnTaskController = StreamController<ThreadStatusUpdate>.broadcast();
  final _copyController = StreamController<String>.broadcast();
  final _thinkingController = StreamController<bool>.broadcast();
  final _regionController = StreamController<List<RegionHighlight>>.broadcast();

  Stream<FeedItem> get feedStream => _feedController.stream;
  Stream<FeedItem> get agentFeedStream => _agentFeedController.stream;
  Stream<bool> get thinkingStream => _thinkingController.stream;
  Stream<Map<String, dynamic>> get statusStream => _statusController.stream;
  Stream<String> get scrollStream => _scrollController.stream;
  Stream<ThreadStatusUpdate> get spawnTaskStream => _spawnTaskController.stream;
  Stream<String> get copyStream => _copyController.stream;
  Stream<List<RegionHighlight>> get regionStream => _regionController.stream;

  /// Latest full region set (Grammarly mode). Read on mount; updates via
  /// [regionStream].
  List<RegionHighlight> regions = const [];

  // ── Region threads (Grammarly mode) ──
  // Each ROI has its own conversation with the escalation agent. Messages
  // tagged with regionId land here instead of the main feed; the HUD shows
  // them as tabs.
  final Map<String, List<FeedItem>> regionThreads = {};
  final Map<String, String> regionThreadLabels = {};
  final _regionThreadController =
      StreamController<(String, FeedItem)>.broadcast();

  /// (regionId, item) pairs as region thread messages arrive.
  Stream<(String, FeedItem)> get regionThreadItemStream =>
      _regionThreadController.stream;

  /// Register a region tab (eye tapped). The tab persists across ROI/tab
  /// switches — the bar is one united list for all states — until explicitly
  /// closed via [closeRegionThread].
  void registerRegionThread(String regionId, String label) {
    if (regionThreadLabels.containsKey(regionId)) return;
    regionThreadLabels[regionId] = label;
    notifyListeners();
  }

  /// Drop a region thread (tab closed). Server-side session is unaffected.
  void closeRegionThread(String regionId) {
    regionThreads.remove(regionId);
    regionThreadLabels.remove(regionId);
    notifyListeners();
  }

  // Canonical spawn-task map. TasksView still consumes the stream for
  // incremental rendering, but the map gives the AGT/TSK tab indicator
  // a snapshot view ("does any task need attention?") without forcing
  // every consumer to subscribe + duplicate list-management logic.
  final Map<String, ThreadStatusUpdate> _spawnTasks = {};
  // Number of tasks currently waiting on user action (permission ask or
  // free-form input). Drives the badge on the inactive tab so users on
  // AGT see when TSK has something blocking.
  int get pendingAttentionCount =>
      _spawnTasks.values.where((t) => t.needsInput).length;

  /// Snapshot of all known spawn tasks, keyed by taskId.
  /// TasksView reads this on mount to seed its local list with any tasks
  /// that arrived before the Chat panel (and TasksView itself) was built.
  /// The map is unmodifiable — mutations go through the stream only.
  Map<String, ThreadStatusUpdate> get spawnTasks => Map.unmodifiable(_spawnTasks);

  bool get connected => _connected;
  String get audioState => _audioState;
  String get micState => _micState;
  String get screenState => _screenState;
  String get escalationState => _escalationState;
  String get responseSize => _responseSize;
  String get envPath => _envPath;
  List<String> get availableAgents => _availableAgents;
  String get escalationAgent => _escalationAgent;
  String get spawnAgent => _spawnAgent;
  bool get agentRegistered => _agentRegistered;
  double get totalCost => _costDisplayEnabled ? _totalCost : 0.0;
  int get costCallCount => _costCallCount;
  bool get costDisplayEnabled => _costDisplayEnabled;
  String? get systemAlertText => _systemAlertText;
  FeedPriority get systemAlertPriority => _systemAlertPriority;

  /// Persistent feed items that survive widget rebuilds.
  /// FeedView can read from this on mount to restore state.
  final List<FeedItem> agentFeedItems = [];
  static const _maxFeedItems = 50;
  bool get audioFeedEnabled => _audioFeedEnabled;
  bool get screenFeedEnabled => _screenFeedEnabled;

  void setResponseSize(String size) {
    sendCommand('set_response_size', {'responseSize': size});
  }

  /// Ask sinain-core to switch the agent for a lane. Empty agent = Off.
  /// Core validates against the current roster and sends a toast if the
  /// agent isn't available (stale overlay state).
  void setAgent(String lane, String agent) {
    sendCommand('set_agent', {'lane': lane, 'agent': agent});
  }

  /// Hold ambient escalations for [seconds] — the user is actively
  /// interacting (visible thread terminal). Chat messages set this
  /// server-side; this covers terminal sessions. Throttled by callers.
  void sendUserBusy([int seconds = 180]) {
    sendCommand('user_busy', {'seconds': seconds});
  }

  void startLocalAgent([String? agent]) {
    final params = <String, dynamic>{};
    if (agent != null && agent.isNotEmpty) {
      params['agent'] = agent;
    }
    sendCommand('start_local_agent', params.isEmpty ? null : params);
  }

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

  void clearSystemAlert() {
    if (_systemAlertText == null) return;
    _systemAlertText = null;
    _systemAlertPriority = FeedPriority.normal;
    notifyListeners();
  }

  void showSystemAlert(
    String text, {
    FeedPriority priority = FeedPriority.high,
  }) {
    _systemAlertText = text;
    _systemAlertPriority = priority;
    notifyListeners();
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
        // Reconnect succeeded — dismiss the stale disconnect banner (other
        // alerts, e.g. the local-agent warning, are left alone).
        if (_systemAlertText?.startsWith('Sinain disconnected') ?? false) {
          _systemAlertText = null;
          _systemAlertPriority = FeedPriority.normal;
        }
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
          final item =
              FeedItem.fromJson(json['data'] as Map<String, dynamic>? ?? json);
          _log(
              'FEED [${item.channel.name}]: ${item.text.substring(0, item.text.length > 60 ? 60 : item.text.length)}');
          _captureSystemAlert(item);
          if (!_audioFeedEnabled &&
              (item.text.startsWith('[📝]') ||
                  item.text.startsWith('[🔊]') ||
                  item.text.startsWith('[🎤]'))) {
            break;
          }
          if (!_screenFeedEnabled && item.text.startsWith('[👁]')) {
            break;
          }
          if (item.regionId != null) {
            // Region thread message — route to its tab, not the main feed
            final thread = regionThreads.putIfAbsent(item.regionId!, () => []);
            thread.add(item);
            if (thread.length > _maxFeedItems) {
              thread.removeRange(0, thread.length - _maxFeedItems);
            }
            _regionThreadController.add((item.regionId!, item));
            notifyListeners(); // tab bar may need to appear/update
          } else if (item.channel == FeedChannel.agent) {
            agentFeedItems.add(item);
            if (agentFeedItems.length > _maxFeedItems) {
              agentFeedItems.removeRange(
                  0, agentFeedItems.length - _maxFeedItems);
            }
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
          final mic = statusData['mic'] as String?;
          if (mic != null && mic != _micState) {
            _micState = mic;
            notifyListeners();
          }
          final screen = statusData['screen'] as String?;
          if (screen != null && screen != _screenState) {
            _screenState = screen;
            notifyListeners();
          }
          final escalation = statusData['escalation'] as String?;
          if (escalation != null && escalation != _escalationState) {
            _escalationState = escalation;
            notifyListeners();
          }
          final respSize = statusData['responseSize'] as String?;
          if (respSize != null && respSize != _responseSize) {
            _responseSize = respSize;
            notifyListeners();
          }
          final envPath = statusData['envPath'] as String?;
          if (envPath != null && envPath.isNotEmpty) {
            _envPath = envPath;
          }
          final agents = statusData['agents'] as Map<String, dynamic>?;
          if (agents != null) {
            final newAvail = (agents['available'] as List?)?.cast<String>() ??
                const <String>[];
            final newEsc = agents['escalationAgent'] as String? ?? '';
            final newSpawn = agents['spawnAgent'] as String? ?? '';
            final newRegistered = agents['registered'] as bool? ?? false;
            if (newAvail.join(',') != _availableAgents.join(',') ||
                newEsc != _escalationAgent ||
                newSpawn != _spawnAgent ||
                newRegistered != _agentRegistered) {
              final wasRegistered = _agentRegistered;
              _availableAgents = newAvail;
              _escalationAgent = newEsc;
              _spawnAgent = newSpawn;
              _agentRegistered = newRegistered;
              if (newRegistered &&
                  !wasRegistered &&
                  (_systemAlertText?.startsWith(
                        'Starting local escalation agent',
                      ) ??
                      false)) {
                _systemAlertText = null;
                _systemAlertPriority = FeedPriority.normal;
              }
              notifyListeners();
            }
          }
          _statusController.add(statusData);
          break;
        case 'spawn_task':
          final task = ThreadStatusUpdate.fromJson(json);
          _log(
              'SPAWN_TASK: taskId=${task.taskId}, status=${task.status.name}, label=${task.label}');
          // Update the canonical map first, then notify listeners so the
          // tab-indicator badge can re-read pendingAttentionCount before
          // the stream subscriber rebuilds the list view.
          final prevAttention = pendingAttentionCount;
          _spawnTasks[task.taskId] = task;
          // Region tasks: the label is the region issue — use it as the
          // thread tab title. Always notify so the tab pill's working/done
          // indicator tracks status changes.
          if (task.regionId != null) {
            regionThreadLabels.putIfAbsent(task.regionId!, () => task.label);
            notifyListeners();
          }
          if (pendingAttentionCount != prevAttention) notifyListeners();
          _spawnTaskController.add(task);
          break;
        case 'region_highlight':
          final list = (json['regions'] as List? ?? const [])
              .whereType<Map<String, dynamic>>()
              .map(RegionHighlight.fromJson)
              .where((r) => r.id.isNotEmpty)
              .toList();
          _log('REGION_HIGHLIGHT: ${list.length} regions [${list.map((r) => r.id).join(", ")}]');
          regions = list;
          _regionController.add(list);
          break;
        case 'thinking':
          _thinkingController.add(json['active'] as bool? ?? false);
          break;
        case 'cost':
          _totalCost = (json['totalCost'] as num?)?.toDouble() ?? 0.0;
          _costCallCount = (json['callCount'] as num?)?.toInt() ?? 0;
          _costDisplayEnabled = json['displayEnabled'] as bool? ?? false;
          notifyListeners();
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
    _systemAlertText = 'Sinain disconnected from the backend. Reconnecting...';
    _systemAlertPriority = FeedPriority.high;
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

  void sendUserCommand(String text) {
    send({'type': 'user_command', 'text': text});
    _log(
        'User command sent: ${text.substring(0, text.length > 60 ? 60 : text.length)}');
  }

  /// Manual ROI: the user drag-selected a screen rect — core builds a
  /// region from already-computed OCR (fresh crop-OCR as fallback).
  void sendRegionSelect(Map<String, double> sel) {
    send({'type': 'region_select', ...sel});
    _log('Region select sent: ${sel['w']}x${sel['h']}');
  }

  /// Fork MAIN into a new thread — core mints the thread id and seeds it
  /// with the MAIN transcript; the tab opens via the thread-status message.
  void forkMain() {
    send({'type': 'fork_main'});
    _log('Fork main sent');
  }

  void sendSpawnCommand(String text, {String? regionId}) {
    send({
      'type': 'spawn_command',
      'text': text,
      if (regionId != null) 'regionId': regionId,
    });
    _log('Spawn command sent${regionId != null ? " (region=$regionId)" : ""}: ${text.substring(0, text.length > 60 ? 60 : text.length)}');
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
    _copyController.close();
    _regionController.close();
    _regionThreadController.close();
    super.dispose();
  }

  void _log(String msg) {
    if (kDebugMode) print('[WebSocketService] $msg');
  }

  void _captureSystemAlert(FeedItem item) {
    final text = item.text.trim();
    final lower = text.toLowerCase();
    final isAlert = item.priority == FeedPriority.urgent ||
        text.startsWith('⚠') ||
        lower.contains(' error') ||
        lower.contains(' failed') ||
        lower.contains(' rejected') ||
        lower.contains(' paused analysis') ||
        lower.contains('unauthorized') ||
        lower.contains('http 401');
    if (!isAlert) return;
    _systemAlertText = text;
    _systemAlertPriority = item.priority == FeedPriority.normal
        ? FeedPriority.high
        : item.priority;
    notifyListeners();
  }
}
