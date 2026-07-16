import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import '../models/context_cards.dart';
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
  // Service guard: per-service liveness from core. Each: {name,label,state,detail}.
  List<Map<String, dynamic>> _services = const [];
  List<Map<String, dynamic>> get services => _services;
  /// Services in a state the user should be warned about (running-but-stale or
  /// expected-but-down). 'off'/'live' are silent.
  List<Map<String, dynamic>> get staleServices => _services
      .where((s) => s['state'] == 'stale' || s['state'] == 'down')
      .toList();
  // Ambient/idle (unsolicited) HUD messages. Opt-in, default off, decoupled
  // from escalation state so selecting a chat agent never flips it on.
  bool _idleMessagesEnabled = false;
  String _responseSize = 'medium';
  String _envPath = '';
  // ChatGPT MCP-tunnel state pushed by sinain-core when the harness is on:
  // {status, connectorUrl, pairingCode, pairingExpiresAt, handle, error}.
  Map<String, dynamic>? _tunnel;
  // Bare-agent roster + per-lane current choice. Populated from status
  // messages once the bare agent registers with sinain-core. Empty string
  // for a lane means "Off" (lane disabled). Empty availableAgents means
  // the bare agent hasn't registered yet (or no agents are installed).
  List<String> _availableAgents = const [];
  // Terminal-lane roster — `available` minus the sinain sidecar (no TUI). Falls
  // back to the full roster if core hasn't sent it (older core).
  List<String> _terminalAvailable = const [];
  String _escalationAgent = '';
  String _terminalAgent = '';
  // Chat lane is a resident sidecar (type "sinain") — its liveness is the
  // sidecar WS, not bare-agent registration, so the HUD must not show a
  // "not connected" warning or a Run/start button for it.
  bool _escalationResident = false;
  // Chat lane is a desktop app (Claude Desktop / ChatGPT) — chat opens the
  // external app, so the overlay must not open its own HUD chat surface.
  bool _escalationDesktop = false;
  // Resident chat sidecar (:9610) reachable? With a resident lane, down → the
  // HUD shows "Chat sidecar not running" + a Run-to-restart.
  bool _chatSidecarUp = false;
  bool _agentRegistered = false;
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
  final _briefController = StreamController<ContextBrief>.broadcast();
  final _enrichController = StreamController<EnrichCard>.broadcast();
  final _saveReceiptController = StreamController<SaveReceipt>.broadcast();
  final _saveOfferController = StreamController<SaveOffer>.broadcast();
  final _sessionNudgeController = StreamController<SessionNudge>.broadcast();
  final _sessionChipController = StreamController<SessionChipState>.broadcast();
  final _sessionWrapController = StreamController<SessionWrap>.broadcast();
  final _sessionAssistController = StreamController<SessionAssist>.broadcast();
  final _voiceController = StreamController<VoiceSession>.broadcast();

  /// Latest voice session state (snapshot for late-mounting UI); updates via
  /// [voiceSessionStream] + notifyListeners.
  VoiceSession? voiceSession;

  Stream<FeedItem> get feedStream => _feedController.stream;
  Stream<ContextBrief> get briefStream => _briefController.stream;
  Stream<EnrichCard> get enrichStream => _enrichController.stream;
  Stream<SaveReceipt> get saveReceiptStream => _saveReceiptController.stream;
  Stream<SaveOffer> get saveOfferStream => _saveOfferController.stream;
  Stream<SessionNudge> get sessionNudgeStream => _sessionNudgeController.stream;
  Stream<SessionChipState> get sessionChipStream =>
      _sessionChipController.stream;
  Stream<SessionWrap> get sessionWrapStream => _sessionWrapController.stream;
  Stream<SessionAssist> get sessionAssistStream =>
      _sessionAssistController.stream;
  Stream<VoiceSession> get voiceSessionStream => _voiceController.stream;
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
  bool get idleMessagesEnabled => _idleMessagesEnabled;
  String get responseSize => _responseSize;
  String get envPath => _envPath;
  /// ChatGPT MCP-tunnel state (null until the harness is enabled).
  Map<String, dynamic>? get tunnel => _tunnel;
  String get tunnelStatus => (_tunnel?['status'] as String?) ?? 'off';
  String? get tunnelConnectorUrl => _tunnel?['connectorUrl'] as String?;
  String? get tunnelPairingCode => _tunnel?['pairingCode'] as String?;
  bool get tunnelLinked => _tunnel?['linked'] == true;
  String? get tunnelAccountEmail => _tunnel?['accountEmail'] as String?;
  String? get tunnelError => _tunnel?['error'] as String?;
  List<String> get availableAgents => _availableAgents;
  /// Terminal-lane roster (sinain-excluded). Falls back to the full roster
  /// when core hasn't populated it.
  List<String> get terminalAvailable =>
      _terminalAvailable.isNotEmpty ? _terminalAvailable : _availableAgents;
  String get escalationAgent => _escalationAgent;
  String get terminalAgent => _terminalAgent;
  /// Chat lane is the built-in sinain sidecar — connected by definition, no
  /// bare-agent registration / terminal / start applies.
  bool get escalationResident => _escalationResident;
  /// Chat lane is a desktop app (Claude Desktop / ChatGPT) — chat opens the
  /// external app rather than the in-HUD chat surface.
  bool get escalationDesktop => _escalationDesktop;
  /// Resident chat sidecar (:9610) reachable.
  bool get chatSidecarUp => _chatSidecarUp;
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

  void setResponseSize(String size) {
    sendCommand('set_response_size', {'responseSize': size});
  }

  /// Ask sinain-core to switch the agent for a lane. Empty agent = Off.
  /// Core validates against the current roster and sends a toast if the
  /// agent isn't available (stale overlay state).
  void setAgent(String lane, String agent) {
    sendCommand('set_agent', {'lane': lane, 'agent': agent});
  }

  /// Toggle the ChatGPT network harness (exposes the local MCP server over a
  /// public tunnel so ChatGPT can reach it). Off by default — security-sensitive.
  void setChatgptHarness(bool enabled) {
    sendCommand('set_chatgpt_harness', {'enabled': enabled});
  }

  /// Open the Sinain account sign-in (Auth0) in the browser to link this device.
  void signInToSinain() {
    sendCommand('mcp_tunnel_signin');
  }

  /// Disconnect this device from its Sinain account.
  void signOutOfSinain() {
    sendCommand('mcp_tunnel_signout');
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

  /// Ask core to (re)start the built-in sinain chat sidecar (:9610).
  void restartChatSidecar() {
    sendCommand('restart_chat_sidecar');
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
          // Service guard: per-service liveness (sense/backend/sinain-chat/runner).
          final svc = statusData['services'] as List?;
          if (svc != null) {
            final list = svc.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList();
            String key(List<Map<String, dynamic>> l) =>
                l.map((s) => '${s['name']}:${s['state']}').join('|');
            if (key(list) != key(_services)) {
              _services = list;
              notifyListeners();
            }
          }
          final escalation = statusData['escalation'] as String?;
          if (escalation != null && escalation != _escalationState) {
            _escalationState = escalation;
            notifyListeners();
          }
          final idleMessages = statusData['idleMessages'] as String?;
          if (idleMessages != null) {
            final on = idleMessages == 'on';
            if (on != _idleMessagesEnabled) {
              _idleMessagesEnabled = on;
              notifyListeners();
            }
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
          // ChatGPT MCP-tunnel state — replace wholesale (it carries a rotating
          // pairing code); a status frame without it leaves the last known state.
          if (statusData.containsKey('tunnel')) {
            _tunnel = (statusData['tunnel'] as Map?)?.cast<String, dynamic>();
            notifyListeners();
          }
          final agents = statusData['agents'] as Map<String, dynamic>?;
          if (agents != null) {
            final newAvail = (agents['available'] as List?)?.cast<String>() ??
                const <String>[];
            final newTermAvail =
                (agents['terminalAvailable'] as List?)?.cast<String>() ??
                    const <String>[];
            final newEsc = agents['escalationAgent'] as String? ?? '';
            final newTerm = agents['terminalAgent'] as String? ?? '';
            final newResident = agents['escalationResident'] as bool? ?? false;
            final newDesktop = agents['escalationDesktop'] as bool? ?? false;
            final newChatUp = agents['chatSidecarUp'] as bool? ?? false;
            final newRegistered = agents['registered'] as bool? ?? false;
            if (newAvail.join(',') != _availableAgents.join(',') ||
                newTermAvail.join(',') != _terminalAvailable.join(',') ||
                newEsc != _escalationAgent ||
                newTerm != _terminalAgent ||
                newResident != _escalationResident ||
                newDesktop != _escalationDesktop ||
                newChatUp != _chatSidecarUp ||
                newRegistered != _agentRegistered) {
              final wasRegistered = _agentRegistered;
              _availableAgents = newAvail;
              _terminalAvailable = newTermAvail;
              _escalationAgent = newEsc;
              _terminalAgent = newTerm;
              _escalationResident = newResident;
              _escalationDesktop = newDesktop;
              _chatSidecarUp = newChatUp;
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
        case 'context_brief':
          _briefController.add(ContextBrief.fromJson(json));
          break;
        case 'enrich_card':
          _enrichController.add(EnrichCard.fromJson(json));
          break;
        case 'save_receipt':
          _saveReceiptController.add(SaveReceipt.fromJson(json));
          break;
        case 'save_offer':
          _saveOfferController.add(SaveOffer.fromJson(json));
          break;
        case 'session_nudge':
          _sessionNudgeController.add(SessionNudge.fromJson(json));
          break;
        case 'session_chip':
          _sessionChipController.add(SessionChipState.fromJson(json));
          break;
        case 'session_wrap':
          _sessionWrapController.add(SessionWrap.fromJson(json));
          break;
        case 'session_assist':
          _sessionAssistController.add(SessionAssist.fromJson(json));
          break;
        case 'voice_session':
          final session = VoiceSession.fromJson(json);
          voiceSession = session;
          _voiceController.add(session);
          notifyListeners();
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

  /// Fast frontmost-app-change signal (from native NSWorkspace observer).
  /// Lands ahead of the sense pipeline so core can instantly restore the
  /// new app's archived ROIs. Fire-and-forget; dropped silently if offline.
  void sendAppFocus(String app) {
    send({'type': 'app_focus', 'app': app});
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

  /// Core's HTTP base derived from the WS url (ws→http, wss→https).
  String? get _httpBase {
    if (url.startsWith('wss://')) return 'https://${url.substring(6)}';
    if (url.startsWith('ws://')) return 'http://${url.substring(5)}';
    return null;
  }

  /// Public HTTP base for native surfaces that load core pages directly
  /// (the hidden-webview call engine).
  String? get httpBase => _httpBase;

  /// Fetch the portable seed text for a thread (key = regionId or "main") so it
  /// can be copied to the clipboard — the same context we feed supported
  /// agents, built server-side. Returns null on any failure.
  Future<String?> fetchSeedText(String key, {String? transcript, String? focus}) async {
    final base = _httpBase;
    if (base == null) return null;
    HttpClient? client;
    try {
      client = HttpClient();
      final req = await client.postUrl(Uri.parse('$base/seed'));
      req.headers.contentType = ContentType.json;
      req.add(utf8.encode(jsonEncode({
        'key': key,
        if (transcript != null) 'transcript': transcript,
        if (focus != null) 'focus': focus,
      })));
      final resp = await req.close();
      if (resp.statusCode != 200) return null;
      final body = await resp.transform(utf8.decoder).join();
      final data = jsonDecode(body) as Map<String, dynamic>;
      return data['ok'] == true ? data['text'] as String? : null;
    } catch (e) {
      _log('fetchSeedText failed: $e');
      return null;
    } finally {
      client?.close();
    }
  }

  // ── Deliberate capture (save / summon / enrich) ──

  Future<Map<String, dynamic>?> _postJson(
      String path, Map<String, dynamic> body) async {
    final base = _httpBase;
    if (base == null) return null;
    HttpClient? client;
    try {
      client = HttpClient();
      final req = await client.postUrl(Uri.parse('$base$path'));
      req.headers.contentType = ContentType.json;
      req.add(utf8.encode(jsonEncode(body)));
      final resp = await req.close();
      final text = await resp.transform(utf8.decoder).join();
      final data = jsonDecode(text) as Map<String, dynamic>;
      if (resp.statusCode != 200) {
        _log('$path → ${resp.statusCode}: ${data['error']}');
      }
      return data;
    } catch (e) {
      _log('$path failed: $e');
      return null;
    } finally {
      client?.close();
    }
  }

  /// Chooser options (5/15/30/60) with free coverage strings.
  Future<List<RangeOption>> fetchRangeOptions() async {
    final base = _httpBase;
    if (base == null) return const [];
    HttpClient? client;
    try {
      client = HttpClient();
      final req = await client.getUrl(Uri.parse('$base/window/coverage'));
      final resp = await req.close();
      if (resp.statusCode != 200) return const [];
      final body = await resp.transform(utf8.decoder).join();
      final data = jsonDecode(body) as Map<String, dynamic>;
      return (data['options'] as List? ?? const [])
          .whereType<Map>()
          .map((m) => RangeOption.fromJson(m.cast<String, dynamic>()))
          .toList();
    } catch (e) {
      _log('fetchRangeOptions failed: $e');
      return const [];
    } finally {
      client?.close();
    }
  }

  /// "Save last N minutes" — receipt lifecycle arrives on [saveReceiptStream].
  /// [apps] scopes the range to the selected sources (app names + "mic");
  /// null means everything in the range.
  Future<bool> requestSave(int minutes, {List<String>? apps}) async =>
      (await _postJson('/capture/save', {
        'minutes': minutes,
        if (apps != null) 'apps': apps,
      }))?['ok'] ==
      true;

  /// Cancel a save inside its undo window.
  Future<bool> requestSaveUndo(String saveId) async =>
      (await _postJson('/capture/undo', {'saveId': saveId}))?['undone'] == true;

  /// Respond to a breakpoint save offer. accepted/adjusted trigger the save
  /// server-side (receipt arrives on [saveReceiptStream]); every response is
  /// a training label. [minutes]/[apps] carry the Adjust edits.
  Future<bool> respondToOffer(String offerId, String response,
          {int? minutes, List<String>? apps}) async =>
      (await _postJson('/capture/offer/response', {
        'offerId': offerId,
        'response': response,
        if (minutes != null) 'minutes': minutes,
        if (apps != null) 'apps': apps,
      }))?['ok'] ==
      true;

  /// Respond to a Session Sense nudge. `tracked`/`corrected` start the
  /// session server-side (chip arrives on [sessionChipStream]); every
  /// response is a training label. [label] carries the "Wrong?" pick
  /// ("" = just work — shape confirmed, label abstained).
  Future<bool> respondToSessionNudge(String nudgeId, String response,
          {String? label}) async =>
      (await _postJson('/capture/session/response', {
        'nudgeId': nudgeId,
        'response': response,
        if (label != null) 'label': label,
      }))?['ok'] ==
      true;

  /// Session actions: `wrapped` (wrap card confirm), `keep_going` (corrects a
  /// too-eager decay model), `ended` (chip tap — a boundary correction), or
  /// `later` (⚑ — wrap + a bookmark on the thread).
  /// Wrapping saves over the credited span; receipt on [saveReceiptStream].
  Future<bool> sessionAction(String sessionId, String action) async =>
      (await _postJson('/capture/session/action', {
        'sessionId': sessionId,
        'action': action,
      }))?['ok'] ==
      true;

  /// The bookmarked-session shelf (§9), most recent first.
  Future<List<SessionBookmark>> fetchSessionBookmarks() async {
    final base = _httpBase;
    if (base == null) return const [];
    HttpClient? client;
    try {
      client = HttpClient();
      final req =
          await client.getUrl(Uri.parse('$base/capture/session/bookmarks'));
      final resp = await req.close();
      if (resp.statusCode != 200) return const [];
      final body = await resp.transform(utf8.decoder).join();
      final data = jsonDecode(body) as Map<String, dynamic>;
      return (data['bookmarks'] as List? ?? const [])
          .whereType<Map>()
          .map((m) => SessionBookmark.fromJson(m.cast<String, dynamic>()))
          .toList();
    } catch (e) {
      _log('fetchSessionBookmarks failed: $e');
      return const [];
    } finally {
      client?.close();
    }
  }

  /// Shelf actions: ▶ `resume` starts a fresh session on the thread now
  /// (chip arrives on [sessionChipStream]); ✕ `remove` releases the promise.
  Future<bool> sessionBookmarkAction(String threadId, String action) async =>
      (await _postJson('/capture/session/bookmark', {
        'threadId': threadId,
        'action': action,
      }))?['ok'] ==
      true;

  /// "Call AI on my last N minutes" — brief arrives on [briefStream].
  /// Returns an error string, or null on accepted.
  Future<String?> requestSummon(int minutes, {List<String>? apps}) async {
    final data = await _postJson('/context/summon', {
      'minutes': minutes,
      if (apps != null) 'apps': apps,
    });
    if (data == null) return 'core unreachable';
    return data['ok'] == true ? null : (data['error'] as String? ?? 'failed');
  }

  /// "Build context" for clipboard text — card arrives on [enrichStream].
  Future<String?> requestEnrich(String text) async {
    final data = await _postJson('/context/enrich', {'text': text});
    if (data == null) return 'core unreachable';
    return data['ok'] == true ? null : (data['error'] as String? ?? 'failed');
  }

  /// "Call sinain" — start a voice session seeded with the last N minutes
  /// (0 = unseeded). Lifecycle arrives on [voiceSessionStream]. Returns the
  /// raw response so callers can react to `loginUrl` ("login required").
  Future<Map<String, dynamic>?> requestVoiceStart(int minutes,
          {List<String>? apps}) async =>
      _postJson('/voice/start', {
        'minutes': minutes,
        if (apps != null) 'apps': apps,
      });

  /// Hand the login window's captured session cookie to core.
  Future<bool> requestVoicePair(String cookie) async =>
      (await _postJson('/voice/pair', {'cookie': cookie}))?['ok'] == true;

  /// Voice session status snapshot (incl. `paired` — the browser pair flow
  /// completes out-of-band, so the overlay polls this).
  Future<Map<String, dynamic>?> fetchVoiceStatus() async {
    final base = _httpBase;
    if (base == null) return null;
    HttpClient? client;
    try {
      client = HttpClient();
      final req = await client.getUrl(Uri.parse('$base/voice/status'));
      final resp = await req.close();
      final body = await resp.transform(utf8.decoder).join();
      return jsonDecode(body) as Map<String, dynamic>;
    } catch (_) {
      return null;
    } finally {
      client?.close();
    }
  }

  /// End the running voice session.
  Future<bool> requestVoiceStop() async =>
      (await _postJson('/voice/stop', {}))?['stopped'] == true;

  /// Mic mute for the webview call engine (the call page polls core's ctl).
  Future<void> requestVoiceMute(bool muted) async {
    await _postJson('/voice/mute', {'muted': muted});
  }

  /// "Call sinain" via the deployed meetbot: the bot joins the given
  /// Meet/Teams call, seeded with the last N minutes.
  Future<String?> requestVoiceMeet(String url, int minutes) async {
    final data = await _postJson('/voice/meet', {'url': url, 'minutes': minutes});
    if (data == null) return 'core unreachable';
    return data['ok'] == true ? null : (data['error'] as String? ?? 'failed');
  }

  /// Chooser context card: cached range summary + coverage for a duration.
  Future<Map<String, dynamic>?> fetchWindowPreview(int minutes) async {
    final base = _httpBase;
    if (base == null) return null;
    HttpClient? client;
    try {
      client = HttpClient();
      final req = await client
          .getUrl(Uri.parse('$base/window/preview?minutes=$minutes'));
      final resp = await req.close();
      if (resp.statusCode != 200) return null;
      final body = await resp.transform(utf8.decoder).join();
      return (jsonDecode(body) as Map<String, dynamic>)['preview']
          as Map<String, dynamic>?;
    } catch (_) {
      return null;
    } finally {
      client?.close();
    }
  }

  /// Sources present in a range — each {name, kind, minutes} drives one row
  /// of the chooser's source checklist. Free window metadata, no LLM.
  Future<List<Map<String, dynamic>>?> fetchWindowSources(int minutes) async {
    final base = _httpBase;
    if (base == null) return null;
    HttpClient? client;
    try {
      client = HttpClient();
      final req = await client
          .getUrl(Uri.parse('$base/window/sources?minutes=$minutes'));
      final resp = await req.close();
      if (resp.statusCode != 200) return null;
      final body = await resp.transform(utf8.decoder).join();
      final sources =
          (jsonDecode(body) as Map<String, dynamic>)['sources'] as List?;
      return sources?.cast<Map<String, dynamic>>().toList();
    } catch (_) {
      return null;
    } finally {
      client?.close();
    }
  }

  /// Live coverage for an arbitrary slider position (free window data).
  Future<String?> fetchCoverageAt(int minutes) async {
    final base = _httpBase;
    if (base == null) return null;
    HttpClient? client;
    try {
      client = HttpClient();
      final req = await client
          .getUrl(Uri.parse('$base/window/coverage?minutes=$minutes'));
      final resp = await req.close();
      if (resp.statusCode != 200) return null;
      final body = await resp.transform(utf8.decoder).join();
      final option =
          (jsonDecode(body) as Map<String, dynamic>)['option'] as Map?;
      return option?['covers'] as String?;
    } catch (_) {
      return null;
    } finally {
      client?.close();
    }
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
    _briefController.close();
    _enrichController.close();
    _saveReceiptController.close();
    _saveOfferController.close();
    _sessionNudgeController.close();
    _sessionChipController.close();
    _sessionWrapController.close();
    _sessionAssistController.close();
    _voiceController.close();
    super.dispose();
  }

  void _log(String msg) {
    if (kDebugMode) print('[WebSocketService] $msg');
  }

  void _captureSystemAlert(FeedItem item) {
    // Only genuine SYSTEM messages (the stream channel) can raise the yellow
    // banner. Agent chat replies and region-thread messages are conversational
    // — an answer that merely mentions "error"/"failed" must never turn the
    // bottom panel yellow. This is what kept leaking idle/chat text there.
    if (item.channel == FeedChannel.agent || item.regionId != null) return;
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
