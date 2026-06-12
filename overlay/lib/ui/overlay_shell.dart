import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';
import '../core/app_control.dart';
import '../core/models/hud_settings.dart';
import '../core/services/settings_service.dart';
import '../core/services/websocket_service.dart';
import '../core/services/window_service.dart';
import 'eye/eye_widget.dart';
import 'feed/idle_animation.dart';
import 'settings/display_settings_panel.dart';
import 'settings/agent_selector_panel.dart';
import 'hud_tooltip.dart';
import 'chat/permission_banner.dart';
import 'regions/region_action_banner.dart';
import 'regions/region_eye_controller.dart';
import 'chat/chat_thread_view.dart';
import 'terminal/thread_terminal_view.dart';
import '../core/models/feed_item.dart';
import '../core/models/region_highlight.dart';

/// Top-level shell managing the 3-state overlay: Eye → Controls → Chat.
class OverlayShell extends StatefulWidget {
  const OverlayShell({super.key});

  @override
  OverlayShellState createState() => OverlayShellState();
}

class OverlayShellState extends State<OverlayShell> {
  static final bool _isMacOS = Platform.isMacOS;

  late HudState _state;
  late HudState _lastVisibleState;

  late final WindowService _windowService;
  late final SettingsService _settingsService;

  // Contextual eye animation state
  bool _isThinking = false;
  bool _hasNewContent = false;
  Timer? _contentResetTimer;
  StreamSubscription<bool>? _thinkingSub;
  StreamSubscription? _forkSub;
  bool _awaitingFork = false;
  StreamSubscription<FeedItem>? _contentSub;

  // Pending-permission signal — drives orange eye color and pupil dilation.
  // Hidden state intentionally ignores this: explicit user hide outranks
  // agent's "I need attention". Agent will time out into deny.
  // NOTE: no auto-switch to Tasks tab — permissions are handled via the
  // PermissionBanner above the chat input only.
  int _pendingAttention = 0;
  WebSocketService? _wsForListener;
  VoidCallback? _wsListener;

  // Display settings panel
  bool _showDisplaySettings = false;
  bool _showAgentPicker = false;

  // Command input focus
  final _commandFocusNode = FocusNode();

  // Grammarly mode: native region eyes (macOS only)
  RegionEyeController? _regionEyes;
  // Region whose action banner is showing in the chat (set on eye tap).
  // While set, the chat input routes to that region's agent thread.
  RegionHighlight? _activeRegion;
  // Selected chat tab: null = MAIN feed, otherwise a region thread id.
  // Each ROI is its own conversation; the input routes to the active tab.
  String? _activeThread;
  // SPIKE: tabs currently showing a terminal instead of the chat feed.
  final Set<String> _terminalThreads = {};
  // Refreshes core's ambient-escalation quiet window while a terminal is up.
  Timer? _busyTimer;
  // Regions whose thread already started (Run pressed / follow-up sent)
  final Set<String> _startedRegionThreads = {};

  @override
  void initState() {
    super.initState();
    _windowService = context.read<WindowService>();
    _settingsService = context.read<SettingsService>();

    // Restore persisted state (defaults to chat for new installs)
    _state = _settingsService.settings.overlayState;
    _lastVisibleState = _state == HudState.hidden ? HudState.chat : _state;

    // Ensure window size matches restored state (may differ from native default)
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _resizeWindowForState(_state);
      if (_state == HudState.chat) _windowService.makeKeyWindow();
    });

    // While a thread terminal is visible the user is conversing with an
    // agent — keep refreshing the ambient-escalation quiet window (core
    // holds it ~3 min per ping; chat messages refresh it server-side).
    _busyTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (_terminalThreads.contains(_activeTabKey) &&
          _state != HudState.hidden) {
        context.read<WebSocketService>().sendUserBusy();
      }
    });

    // Native drag/resize callbacks (macOS only)
    if (_isMacOS) {
      _windowService.setupNativeCallbacks(
        onDragDone: (x, y) => _settingsService.setEyePosition(x, y),
        onResizeDone: (w, h) => _settingsService.setChatSize(w, h),
      );
    }

    final ws = context.read<WebSocketService>();
    // After tapping ⑂ the new fork tab arrives as a thread-status update —
    // switch to it so the user lands in the thread they just created.
    _forkSub = ws.spawnTaskStream.listen((task) {
      if (!mounted || !_awaitingFork) return;
      final id = task.regionId;
      if (id != null && id.startsWith('fork-')) {
        _awaitingFork = false;
        _selectThread(id);
      }
    });
    _thinkingSub = ws.thinkingStream.listen((active) {
      if (mounted) setState(() => _isThinking = active);
    });
    _contentSub = ws.agentFeedStream.listen((_) {
      if (!mounted) return;
      setState(() => _hasNewContent = true);
      _contentResetTimer?.cancel();
      _contentResetTimer = Timer(const Duration(seconds: 5), () {
        if (mounted) setState(() => _hasNewContent = false);
      });
    });

    // Watch pending-permission count from WebSocketService (ChangeNotifier).
    // Only used to drive eye color + pupil dilation. No auto-switch to Tasks
    // tab — permissions are surfaced exclusively via PermissionBanner.
    _wsForListener = ws;
    _wsListener = () {
      if (!mounted) return;
      final n = ws.pendingAttentionCount;
      if (n == _pendingAttention) return;
      setState(() => _pendingAttention = n);
    };
    ws.addListener(_wsListener!);

    // Region eyes (Grammarly mode) — native NSPanels, macOS only
    if (_isMacOS) {
      _regionEyes = RegionEyeController(
        windowService: _windowService,
        ws: ws,
        settingsService: _settingsService,
        onRegionTap: (region, pos) {
          // Register the tab immediately so it persists in the unified tab
          // bar even before the thread starts or another ROI is selected.
          ws.registerRegionThread(region.id, region.issue);
          setState(() {
            _activeRegion = region;
            _activeThread = region.id; // select this region's tab
          });
          _openChatNearRegion(pos.dx, pos.dy);
        },
      )..start();
    }
  }

  static const _redEye = Color(0xFFFF3344);
  static const _pendingOrange = Color(0xFFFFAA00);

  double get _pupilDilation {
    if (_pendingAttention > 0) return 1.0; // blocked on user — full dilation
    if (_isThinking) return 0.3;
    if (_hasNewContent) return 0.6;
    return 0.0;
  }

  Color get _accentColor {
    final c = _settingsService.settings.accentColor;
    return Color(c != 0 ? c : 0xFF00FF88);
  }

  Color get _eyeColor {
    if (_pendingAttention > 0) return _pendingOrange;
    return _settingsService.settings.privacyMode ? _accentColor : _redEye;
  }

  void toggleVisibility(bool visible) {
    if (visible) {
      // Restore to last visible state and resize window accordingly
      setState(() => _state = _lastVisibleState);
      _settingsService.setHudState(_lastVisibleState);
      _windowService.showWindow();
      _resizeWindowForState(_lastVisibleState);
    } else {
      _lastVisibleState = _state;
      setState(() => _state = HudState.hidden);
      _settingsService.setHudState(HudState.hidden);
      _windowService.hideWindow();
    }
  }

  void toggleChat() {
    if (_state == HudState.chat) {
      _transitionTo(HudState.eye);
    } else {
      _transitionTo(HudState.chat);
    }
  }

  /// Cycle through visible states: Eye → Controls → Chat → Eye.
  void cycleState() {
    switch (_state) {
      case HudState.eye:
        _transitionTo(HudState.controls);
      case HudState.controls:
        _transitionTo(HudState.chat);
      case HudState.chat:
        _transitionTo(HudState.eye);
      case HudState.hidden:
        // Unhide to eye first
        toggleVisibility(true);
    }
  }

  /// Reset window position to default bottom-right corner.
  /// Clears persisted position so next launch uses native default.
  void resetPosition() {
    _settingsService.setEyePosition(-1, -1);
    if (_state != HudState.eye) _transitionTo(HudState.eye);
    // The native AppDelegate sets default position on launch.
    // For runtime reset, we ask native to re-position via a special method.
    _windowService.resetToDefaultPosition();
  }

  /// Transition to Chat state and focus the command input.
  void focusInput() {
    if (_state != HudState.chat) {
      _transitionTo(HudState.chat);
    }
    // Delay to let the widget tree rebuild before requesting focus
    Future.delayed(const Duration(milliseconds: 200), () {
      _commandFocusNode.requestFocus();
    });
  }

  Future<void> _persistEyePosition() async {
    final frame = await _windowService.getWindowFrame();
    if (frame != null && mounted) {
      _settingsService.setEyePosition(frame['x']!, frame['y']!);
    }
  }

  void _transitionTo(HudState target) {
    if (_state == target) return;
    HudTooltip.dismissAll();
    setState(() => _state = target);
    _settingsService.setHudState(target);
    _resizeWindowForState(target);

    if (target == HudState.chat) {
      _windowService.makeKeyWindow();
    } else {
      _windowService.resignKeyWindow();
    }
  }

  Future<void> _resizeWindowForState(HudState state) async {
    final frame = await _windowService.getWindowFrame();
    if (frame == null) return;

    final eyeRight = frame['x']! + frame['w']!;
    final eyeBottom = frame['y']!;

    switch (state) {
      case HudState.eye:
        _windowService.setWindowFrame(eyeRight - 48, eyeBottom, 48, 48);
      case HudState.controls:
        const controlsW = 360.0;
        _windowService.setWindowFrame(
          eyeRight - controlsW,
          eyeBottom,
          controlsW,
          48,
        );
      case HudState.chat:
        final chatW = _settingsService.settings.chatWidth;
        final chatH = _settingsService.settings.chatHeight;
        _windowService.setWindowFrame(
          eyeRight - chatW,
          eyeBottom,
          chatW,
          chatH,
        );
      case HudState.hidden:
        break;
    }
  }

  /// Send a follow-up message to a region's agent thread (stable per-ROI
  /// session core-side) and flip its eye badge to working.
  void _sendToRegionThread(String regionId, String text) {
    setState(() => _startedRegionThreads.add(regionId));
    context.read<WebSocketService>().sendSpawnCommand(text, regionId: regionId);
    _regionEyes?.markWorking(regionId);
  }

  /// Switch the chat to a thread tab (null = MAIN feed).
  void _selectThread(String? id) {
    final ws = context.read<WebSocketService>();
    setState(() {
      _activeThread = id;
      if (id == null) {
        _activeRegion = null;
      } else if (_activeRegion?.id != id) {
        // Re-resolve the live region for the banner (null if expired)
        RegionHighlight? live;
        for (final r in ws.regions) {
          if (r.id == id) live = r;
        }
        _activeRegion = live;
      }
    });
    _syncBusyState();
  }

  void _closeThread(String id) {
    context.read<WebSocketService>().closeRegionThread(id);
    ThreadTerminalSession.close(id); // kill the thread's PTY, if any
    setState(() {
      _terminalThreads.remove(id);
      if (_activeThread == id) {
        _activeThread = null;
        _activeRegion = null;
      }
    });
    _syncBusyState();
  }

  /// Tab key for the terminal toggle — MAIN uses a stable pseudo-id so the
  /// spike can be exercised without waiting for a region thread.
  String get _activeTabKey => _activeThread ?? 'main';

  /// Tell core whether the user is conversing in a terminal right now.
  /// Visible terminal → hold ambient escalations (refreshed by the 30s
  /// heartbeat); anything else → release the quiet window immediately so
  /// returning to chat doesn't leave a stale ~3 min suppression tail.
  void _syncBusyState() {
    final ws = context.read<WebSocketService>();
    if (_terminalThreads.contains(_activeTabKey) && _state != HudState.hidden) {
      ws.sendUserBusy();
    } else {
      ws.sendUserBusy(0);
    }
  }

  /// Open (or surface) the terminal for a tab: MAIN gets the escalation-lane
  /// agent seeded with the current digest; a region tab gets the spawn-lane
  /// agent seeded with the composed region context — the same seeds chat
  /// mode uses. run.sh resolves lanes/profiles; the session is cached, so
  /// re-opening an existing tab just switches the view back.
  void _openTerminalForTab(String tabKey) {
    final runSh = ThreadTerminalSession.findRunSh();
    final isMain = tabKey == 'main';
    ThreadTerminalSession.of(
      tabKey,
      command: runSh != null ? 'bash' : null,
      args: runSh != null
          ? [
              runSh,
              if (isMain) '--interactive-main' else '--interactive-region',
              if (!isMain) tabKey,
            ]
          : null,
      banner: runSh == null
          ? '⚠ sinain-agent/run.sh not found — plain shell. '
              'Dev builds need SINAIN_AGENT_RUNSH=<repo>/sinain-agent/run.sh'
          : null,
    );
    context.read<WebSocketService>().sendUserBusy();
    setState(() {
      if (!isMain) _startedRegionThreads.add(tabKey);
      _terminalThreads.add(tabKey);
    });
  }

  /// True while any spawn task for this region is still in flight.
  bool _regionWorking(WebSocketService ws, String regionId) {
    for (final t in ws.spawnTasks.values) {
      if (t.regionId == regionId && !t.isTerminal) return true;
    }
    return false;
  }

  /// Horizontal tab bar: MAIN + one pill per region thread. Hidden until the
  /// first region conversation exists.
  Widget _buildThreadTabs(WebSocketService ws) {
    final ids = <String>{
      ...ws.regionThreads.keys,
      ...ws.regionThreadLabels.keys,
      if (_activeRegion != null) _activeRegion!.id,
    }.toList();
    // SPIKE: with the terminal enabled the row is always shown so the ⌨
    // toggle is reachable from MAIN even before any region thread exists.
    if (ids.isEmpty && !terminalSpikeEnabled) return const SizedBox.shrink();

    String labelFor(String id) {
      var label = ws.regionThreadLabels[id];
      if (label == null || label.isEmpty) {
        for (final r in ws.regions) {
          if (r.id == id) {
            label = r.issue;
            break;
          }
        }
      }
      if ((label == null || label.isEmpty) && _activeRegion?.id == id) {
        label = _activeRegion!.issue;
      }
      label ??= 'region';
      return label.length > 18 ? '${label.substring(0, 18)}…' : label;
    }

    Widget pill({
      required String text,
      required bool selected,
      required VoidCallback onTap,
      VoidCallback? onClose,
    }) {
      final accent = _accentColor;
      return Padding(
        padding: const EdgeInsets.only(right: 4),
        child: MouseRegion(
          cursor: SystemMouseCursors.click,
          child: GestureDetector(
            onTap: onTap,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: selected
                    ? accent.withValues(alpha: 0.15)
                    : Colors.white.withValues(alpha: 0.04),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                  color: selected
                      ? accent.withValues(alpha: 0.5)
                      : Colors.white.withValues(alpha: 0.12),
                ),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    text,
                    style: TextStyle(
                      fontFamily: 'JetBrainsMono',
                      fontSize: 9,
                      color: selected
                          ? accent
                          : Colors.white.withValues(alpha: 0.55),
                      fontWeight:
                          selected ? FontWeight.bold : FontWeight.normal,
                    ),
                  ),
                  if (onClose != null) ...[
                    const SizedBox(width: 5),
                    GestureDetector(
                      onTap: onClose,
                      child: Icon(Icons.close,
                          size: 9,
                          color: Colors.white.withValues(alpha: 0.4)),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      );
    }

    return Container(
      height: 26,
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
      child: Row(children: [
        Expanded(
            child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            pill(
              text: 'MAIN',
              selected: _activeThread == null,
              onTap: () => _selectThread(null),
            ),
            for (final id in ids)
              pill(
                // ⟳ while this region's task is in flight — visible feedback
                // that the agent is working even if the eye expired meanwhile
                text:
                    '${_regionWorking(ws, id) ? "⟳" : "👁"} ${labelFor(id)}',
                selected: _activeThread == id,
                onTap: () => _selectThread(id),
                onClose: () => _closeThread(id),
              ),
          ],
        ),
            )),
        // Fork MAIN into a new thread (visible only on the MAIN tab): the
        // new thread starts from the MAIN transcript + digest and runs its
        // own agent session, chat or terminal.
        if (_activeThread == null)
          pill(
            text: '⑂',
            selected: false,
            onTap: () {
              _awaitingFork = true;
              context.read<WebSocketService>().forkMain();
            },
          ),
        // Chat ⇄ terminal toggle for the ACTIVE tab — pinned at the right
        // edge, outside the scrolling tab strip, so a crowd of tabs can
        // never squeeze it out of sight. Term→chat closes the PTY so one
        // session never has two concurrent writers (P3 exclusivity).
        if (terminalSpikeEnabled)
          pill(
            text: _terminalThreads.contains(_activeTabKey)
                ? '💬 chat'
                : '⌨ term',
            selected: _terminalThreads.contains(_activeTabKey),
            onTap: () {
              if (_terminalThreads.contains(_activeTabKey)) {
                ThreadTerminalSession.close(_activeTabKey);
                setState(() => _terminalThreads.remove(_activeTabKey));
              } else {
                _openTerminalForTab(_activeTabKey);
              }
              _syncBusyState();
            },
          ),
      ]),
    );
  }

  /// Move the HUD next to a region eye (top-left-origin screen point) and
  /// open the chat there. Used by region eye taps — the chat becomes the
  /// viewport for that region's conversation.
  Future<void> _openChatNearRegion(double x, double y) async {
    if (_state == HudState.hidden) toggleVisibility(true);

    final screen = await _windowService.getScreenSize();
    final chatW = _settingsService.settings.chatWidth;
    final chatH = _settingsService.settings.chatHeight;
    if (screen != null) {
      final screenW = screen['w']!;
      final screenH = screen['h']!;
      // Chat below the eye, right edge roughly aligned with it
      final left = (x + 48 - chatW).clamp(8.0, screenW - chatW - 8);
      final top = (y + 56).clamp(8.0, screenH - chatH - 8);
      final macY = screenH - top - chatH; // top-left → macOS bottom-left origin
      await _windowService.setWindowFrame(left, macY, chatW, chatH);
    }

    if (_state != HudState.chat) {
      HudTooltip.dismissAll();
      setState(() => _state = HudState.chat);
      _settingsService.setHudState(HudState.chat);
    }
    _windowService.makeKeyWindow();
  }

  @override
  void dispose() {
    _busyTimer?.cancel();
    _regionEyes?.dispose();
    _thinkingSub?.cancel();
    _forkSub?.cancel();
    _contentSub?.cancel();
    _contentResetTimer?.cancel();
    if (_wsForListener != null && _wsListener != null) {
      _wsForListener!.removeListener(_wsListener!);
    }
    _commandFocusNode.dispose();
    super.dispose();
  }

  void _onDragStart(DragStartDetails details) {
    if (_isMacOS) _windowService.beginNativeDrag();
  }

  void _onDragUpdate(DragUpdateDetails details) {
    if (_isMacOS) return; // native handles it
    _windowService.moveWindowBy(details.delta.dx, -details.delta.dy);
  }

  void _toggleDemoMode() {
    final nowPrivate = !_settingsService.settings.privacyMode;
    _settingsService.setPrivacyModeTransient(nowPrivate);
    _windowService.setPrivacyMode(nowPrivate);
  }

  void _openSettings() {
    final ws = context.read<WebSocketService>();
    ws.sendCommand('open_settings');
  }

  /// Open the sinain-core knowledge web UI in the user's default browser.
  /// URL is derived from the configured WebSocket URL — swap ws://→http://,
  /// wss://→https://, then append /knowledge/ui. Uses externalApplication
  /// mode so the browser takes focus rather than embedding in a webview.
  Future<void> _openKnowledgeUI() async {
    final ws = _settingsService.settings.wsUrl;
    // Dart's String.replaceFirst doesn't interpret $1 as a capture group —
    // that's replaceFirstMapped. A literal startsWith ladder is clearer
    // anyway and handles all three cases (wss, ws, anything else).
    final String httpUrl;
    if (ws.startsWith('wss://')) {
      httpUrl = 'https://${ws.substring(6)}';
    } else if (ws.startsWith('ws://')) {
      httpUrl = 'http://${ws.substring(5)}';
    } else {
      httpUrl = ws;
    }
    final uri = Uri.parse('$httpUrl/knowledge/ui');
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    }
  }

  @override
  Widget build(BuildContext context) {
    // Legacy onboarding (connecting → permissions → orientation/hotkeys) is
    // retired — the packaged DMG's first-run wizard handles setup, and macOS
    // requests permissions on demand. This removes the "You're all set / hotkeys"
    // screen that trapped users after the wizard.
    context
        .watch<SettingsService>(); // rebuild on privacy mode change (eye color)
    if (_state == HudState.hidden) {
      return const SizedBox.shrink();
    }

    switch (_state) {
      case HudState.eye:
        return EyeWidget(
          // Pending permission shortcuts past Controls — one click to land
          // on TSK-with-Allow/Deny (auto-switch already moved the tab).
          onTap: () => _transitionTo(
            _pendingAttention > 0 ? HudState.chat : HudState.controls,
          ),
          onLongPress: () => toggleVisibility(false),
          onDragEnd: _persistEyePosition,
          pupilDilation: _pupilDilation,
          eyeColor: _eyeColor,
        );
      case HudState.controls:
        return _buildControlsBar();
      case HudState.chat:
        return _buildChatPanel();
      case HudState.hidden:
        return const SizedBox.shrink();
    }
  }

  // ── State 2: Controls Bar ──────────────────────────────────────────────────

  Widget _buildControlsBar() {
    final ws = context.watch<WebSocketService>();

    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth < 300 || constraints.maxHeight < 48) {
          return const SizedBox.shrink();
        }
        return GestureDetector(
          onPanStart: _onDragStart,
          onPanUpdate: _onDragUpdate,
          onPanEnd: _isMacOS ? null : (_) => _persistEyePosition(),
          child: Container(
            height: 48,
            decoration: BoxDecoration(
              color: Colors.black.withValues(alpha: 0.85),
              borderRadius: BorderRadius.circular(24),
            ),
            child: Row(
              children: [
                const SizedBox(width: 8),
                _quitIcon(small: true),
                const SizedBox(width: 4),
                _toggleIcon(
                  icon: ws.screenState == 'active'
                      ? Icons.visibility
                      : Icons.visibility_off,
                  active: ws.screenState == 'active',
                  onTap: () => ws.sendCommand('toggle_screen'),
                  small: true,
                  tooltip: 'Toggle screen capture',
                ),
                _toggleIcon(
                  icon: ws.audioState == 'active'
                      ? Icons.volume_up_rounded
                      : Icons.volume_off_rounded,
                  active: ws.audioState == 'active',
                  onTap: () => ws.sendCommand('toggle_audio'),
                  small: true,
                  tooltip: 'Toggle audio capture',
                ),
                _toggleIcon(
                  icon: ws.micState == 'active' ? Icons.mic : Icons.mic_off,
                  active: ws.micState == 'active',
                  onTap: () => ws.sendCommand('toggle_mic'),
                  small: true,
                  tooltip: 'Toggle microphone',
                ),
                _toggleIcon(
                  // Both the icon AND its active-tint reflect the combined state:
                  // active only when escalation is running AND at least one agent
                  // is registered. Empty roster → dim, flash_off — signals
                  // "nothing is answering" even if escalation mode isn't explicitly
                  // paused.
                  icon: (ws.escalationState == 'active' &&
                          ws.availableAgents.isNotEmpty)
                      ? Icons.flash_on
                      : Icons.flash_off,
                  active: ws.escalationState == 'active' &&
                      ws.availableAgents.isNotEmpty,
                  onTap: () =>
                      setState(() => _showAgentPicker = !_showAgentPicker),
                  small: true,
                  tooltip: 'Agent selector — which agent handles each lane',
                ),
                const Spacer(),
                // Cost counter (replaces DEMO badge when cost > 0)
                if (ws.totalCost > 0)
                  _costText(ws.totalCost)
                // Demo badge (only when no cost data yet)
                else if (!_settingsService.settings.privacyMode)
                  HudTooltip(
                    message: 'Toggle privacy mode',
                    child: GestureDetector(
                      onTap: _toggleDemoMode,
                      child: MouseRegion(
                        cursor: SystemMouseCursors.click,
                        child: Padding(
                          padding: const EdgeInsets.only(right: 4),
                          child: Text(
                            'DEMO',
                            style: TextStyle(
                              fontFamily: 'JetBrainsMono',
                              fontSize: 9,
                              fontWeight: FontWeight.bold,
                              color: _redEye.withValues(alpha: 0.8),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                _plainIcon(
                  Icons.psychology_outlined,
                  _openKnowledgeUI,
                  small: true,
                  tooltip: 'Open knowledge browser',
                ),
                _plainIcon(
                  Icons.settings,
                  _openSettings,
                  small: true,
                  tooltip: 'Settings',
                ),
                _plainIcon(
                  Icons.chevron_left,
                  () => _transitionTo(HudState.eye),
                  small: true,
                  tooltip: 'Collapse',
                ),
                _plainIcon(
                  Icons.open_in_full,
                  () => _transitionTo(HudState.chat),
                  small: true,
                  tooltip: 'Expand to chat',
                ),
                const SizedBox(width: 4),
                // Eye animation
                HudTooltip(
                  message: 'Collapse to eye',
                  child: GestureDetector(
                    onTap: () => _transitionTo(HudState.eye),
                    child: Container(
                      width: 40,
                      height: 40,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: Colors.black.withValues(alpha: 0.3),
                      ),
                      child: IdleAnimation(
                        size: 32,
                        pupilDilation: _pupilDilation,
                        color: _eyeColor,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 4),
              ],
            ),
          ),
        );
      },
    );
  }

  // ── State 3: Chat Panel ────────────────────────────────────────────────────

  Widget _buildChatPanel() {
    final ws = context.watch<WebSocketService>();

    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth < 300 || constraints.maxHeight < 180) {
          return const SizedBox.shrink();
        }
        return _buildChatPanelContent(ws);
      },
    );
  }

  Widget _buildChatPanelContent(WebSocketService ws) {
    final chatContent = Container(
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.85),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        children: [
          // Header — draggable, with controls
          GestureDetector(
            onPanStart: _onDragStart,
            onPanUpdate: _onDragUpdate,
            onPanEnd: _isMacOS ? null : (_) => _persistEyePosition(),
            child: Container(
              height: 40,
              padding: const EdgeInsets.symmetric(horizontal: 6),
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.03),
                borderRadius: const BorderRadius.vertical(
                  top: Radius.circular(8),
                ),
              ),
              child: Row(
                children: [
                  _quitIcon(small: true),
                  const SizedBox(width: 4),
                  // Collapse
                  _plainIcon(
                    Icons.expand_more,
                    () => _transitionTo(HudState.controls),
                    small: true,
                    tooltip: 'Collapse to controls',
                  ),
                  const SizedBox(width: 2),
                  // Capture toggles
                  _toggleIcon(
                    icon: ws.screenState == 'active'
                        ? Icons.visibility
                        : Icons.visibility_off,
                    active: ws.screenState == 'active',
                    onTap: () => ws.sendCommand('toggle_screen'),
                    small: true,
                    tooltip: 'Toggle screen capture',
                  ),
                  _toggleIcon(
                    icon: ws.audioState == 'active'
                        ? Icons.volume_up_rounded
                        : Icons.volume_off_rounded,
                    active: ws.audioState == 'active',
                    onTap: () => ws.sendCommand('toggle_audio'),
                    small: true,
                    tooltip: 'Toggle audio capture',
                  ),
                  _toggleIcon(
                    icon: ws.micState == 'active' ? Icons.mic : Icons.mic_off,
                    active: ws.micState == 'active',
                    onTap: () => ws.sendCommand('toggle_mic'),
                    small: true,
                    tooltip: 'Toggle microphone',
                  ),
                  _toggleIcon(
                    icon: (ws.escalationState == 'active' &&
                            ws.availableAgents.isNotEmpty)
                        ? Icons.flash_on
                        : Icons.flash_off,
                    active: ws.escalationState == 'active' &&
                        ws.availableAgents.isNotEmpty,
                    onTap: () =>
                        setState(() => _showAgentPicker = !_showAgentPicker),
                    small: true,
                    tooltip: 'Agent selector — which agent handles each lane',
                  ),
                  // AGT/TSK tab pill removed — Tasks tab deactivated for
                  // launch (permissions surface via PermissionBanner above
                  // chat input; tasks tab added no unique value).
                  const Spacer(),
                  // Cost counter
                  _costText(ws.totalCost),
                  // Demo toggle (clickable in both states)
                  HudTooltip(
                    message: 'Toggle privacy mode',
                    child: GestureDetector(
                      onTap: _toggleDemoMode,
                      child: MouseRegion(
                        cursor: SystemMouseCursors.click,
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 4),
                          child: _settingsService.settings.privacyMode
                              ? Icon(
                                  Icons.videocam_off,
                                  size: 12,
                                  color: Colors.white.withValues(alpha: 0.3),
                                )
                              : Text(
                                  'DEMO',
                                  style: TextStyle(
                                    fontFamily: 'JetBrainsMono',
                                    fontSize: 8,
                                    fontWeight: FontWeight.bold,
                                    color: _redEye.withValues(alpha: 0.8),
                                  ),
                                ),
                        ),
                      ),
                    ),
                  ),
                  // Knowledge browser — opens sinain-core's web UI in the
                  // user's default browser. Mirrors the Controls-bar entry.
                  HudTooltip(
                    message: 'Open knowledge browser',
                    child: MouseRegion(
                      cursor: SystemMouseCursors.click,
                      child: GestureDetector(
                        onTap: _openKnowledgeUI,
                        behavior: HitTestBehavior.opaque,
                        child: Padding(
                          padding: const EdgeInsets.all(4),
                          child: Icon(
                            Icons.psychology_outlined,
                            size: 12,
                            color: Colors.white.withValues(alpha: 0.5),
                          ),
                        ),
                      ),
                    ),
                  ),
                  // Settings — tap toggles display panel, long-press opens .env
                  HudTooltip(
                    message: 'Display settings',
                    child: MouseRegion(
                      cursor: SystemMouseCursors.click,
                      child: GestureDetector(
                        onTap: () => setState(
                          () => _showDisplaySettings = !_showDisplaySettings,
                        ),
                        onLongPress: _openSettings,
                        behavior: HitTestBehavior.opaque,
                        child: Padding(
                          padding: const EdgeInsets.all(4),
                          child: Icon(
                            Icons.settings,
                            size: 12,
                            color: _showDisplaySettings
                                ? _accentColor
                                : Colors.white.withValues(alpha: 0.5),
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 4),
                  // Eye — collapses all the way to State 1
                  HudTooltip(
                    message: 'Collapse to eye',
                    child: GestureDetector(
                      onTap: () => _transitionTo(HudState.eye),
                      child: Container(
                        width: 32,
                        height: 32,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: Colors.black.withValues(alpha: 0.3),
                        ),
                        child: IdleAnimation(
                          size: 28,
                          pupilDilation: _pupilDilation,
                          color: _eyeColor,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 2),
                ],
              ),
            ),
          ),
          // Thread tabs — MAIN + one per region conversation (Grammarly
          // mode). Hidden until the first region thread exists.
          _buildThreadTabs(ws),
          // Tab content with display settings overlay. MAIN shows the agent
          // feed; a region tab shows only that ROI's conversation (main
          // escalations do not pour into region threads).
          Expanded(
            child: Stack(
              children: [
                _terminalThreads.contains(_activeTabKey)
                    ? ThreadTerminalView(
                        key: ValueKey('term-$_activeTabKey'),
                        threadId: _activeTabKey,
                      )
                    : ChatThreadView(
                        key: ValueKey('chat-$_activeTabKey'),
                        ws: ws,
                        threadId: _activeThread,
                        accentColor: _settingsService.settings.accentColor,
                        onSend: (text) {
                          final thread = _activeThread;
                          if (thread != null) {
                            _sendToRegionThread(thread, text);
                          } else {
                            ws.sendUserCommand(text);
                          }
                          _syncBusyState();
                        },
                      ),
                if (_showDisplaySettings)
                  DisplaySettingsPanel(
                    onClose: () => setState(() => _showDisplaySettings = false),
                  ),
                if (_showAgentPicker)
                  AgentSelectorPanel(
                    onClose: () => setState(() => _showAgentPicker = false),
                  ),
              ],
            ),
          ),
          // Region action banner — issue + suggested approach, shown on the
          // region's tab while the region is still detected on screen. The
          // thread only starts from its explicit Run button.
          if (_activeThread != null &&
              _activeRegion != null &&
              _activeRegion!.id == _activeThread)
            RegionActionBanner(
              region: _activeRegion!,
              accentColor: _settingsService.settings.accentColor,
              threadStarted:
                  _startedRegionThreads.contains(_activeRegion!.id),
              onRun: () {
                final region = _activeRegion!;
                setState(() => _startedRegionThreads.add(region.id));
                _regionEyes?.run(region);
              },
              // SPIKE: interactive terminal variant of Run — the PTY launches
              // run.sh --interactive-region, which resolves the spawn-lane
              // agent and seeds it with the same composed region context the
              // headless Run sends (GET /region/:id/task on core).
              onTerminal: terminalSpikeEnabled
                  ? () => _openTerminalForTab(_activeRegion!.id)
                  : null,
              onDismiss: () => setState(() => _activeRegion = null),
            ),
          // Permission banner — visible above the input field whenever an
          // agent task is blocked waiting for user approval. Hidden (zero
          // height) when no tasks are pending. Mirrors Tasks tab — does not
          // remove tasks from that view.
          const _AgentAvailabilityBanner(),
          const _SystemAlertBanner(),
          const PermissionBanner(),
          // Input lives in the chat surface now (flyer composer) — terminal
          // tabs type directly into the PTY. CommandInput retired with the
          // chat-threads redesign (spawn input mode removed with it).
        ],
      ),
    );

    // Wrap in a Stack with resize handles on edges
    return Stack(
      children: [
        chatContent,
        _resizeHandle(
          Alignment.centerLeft,
          SystemMouseCursors.resizeLeft,
          'left',
          (dx, dy) => _windowService.resizeWindowBy(-dx, 0, anchorRight: true),
        ),
        _resizeHandle(
          Alignment.centerRight,
          SystemMouseCursors.resizeRight,
          'right',
          (dx, dy) => _windowService.resizeWindowBy(dx, 0),
        ),
        _resizeHandle(
          Alignment.topCenter,
          SystemMouseCursors.resizeUp,
          'top',
          (dx, dy) => _windowService.resizeWindowBy(0, -dy),
        ),
        _resizeHandle(
          Alignment.bottomCenter,
          SystemMouseCursors.resizeDown,
          'bottom',
          (dx, dy) => _windowService.resizeWindowBy(0, dy, anchorTop: true),
        ),
      ],
    );
  }

  Widget _resizeHandle(
    Alignment alignment,
    MouseCursor cursor,
    String nativeEdge,
    void Function(double dx, double dy) onDragFallback,
  ) {
    final isHorizontal =
        alignment == Alignment.centerLeft || alignment == Alignment.centerRight;
    return Align(
      alignment: alignment,
      child: MouseRegion(
        cursor: cursor,
        child: GestureDetector(
          onPanStart: _isMacOS
              ? (_) => _windowService.beginNativeResize(nativeEdge)
              : null,
          onPanUpdate: _isMacOS
              ? (_) {} // keep alive for gesture arena, native handles tracking
              : (details) {
                  if (details.delta.dx.abs() < 1.0 &&
                      details.delta.dy.abs() < 1.0) {
                    return;
                  }
                  onDragFallback(details.delta.dx, details.delta.dy);
                },
          onPanEnd: _isMacOS ? null : (_) => _persistChatSize(),
          child: Container(
            width: isHorizontal ? 6 : double.infinity,
            height: isHorizontal ? double.infinity : 6,
            color: Colors.transparent,
          ),
        ),
      ),
    );
  }

  Future<void> _persistChatSize() async {
    final frame = await _windowService.getWindowFrame();
    if (frame != null && mounted) {
      _settingsService.setChatSize(frame['w']!, frame['h']!);
    }
  }

  // ── Shared icon helpers ────────────────────────────────────────────────────

  Widget _toggleIcon({
    required IconData icon,
    required bool active,
    required VoidCallback onTap,
    bool small = false,
    String? tooltip,
  }) {
    final size = small ? 12.0 : 16.0;
    final pad = small ? 4.0 : 8.0;
    Widget child = MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: Padding(
          padding: EdgeInsets.all(pad),
          child: Icon(
            icon,
            size: size,
            color: active ? _accentColor : Colors.white.withValues(alpha: 0.3),
          ),
        ),
      ),
    );
    if (tooltip != null) {
      child = HudTooltip(message: tooltip, child: child);
    }
    return child;
  }

  Widget _costText(double cost) {
    if (cost <= 0) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(right: 4),
      child: Text(
        '\$${cost.toStringAsFixed(4)}',
        style: TextStyle(
          fontFamily: 'JetBrainsMono',
          fontSize: 9,
          color: Colors.white.withValues(alpha: 0.35),
        ),
      ),
    );
  }

  Widget _quitIcon({bool small = false}) {
    final dot = small ? 13.0 : 16.0;
    final iconSize = small ? 8.0 : 10.0;
    final pad = small ? 5.0 : 7.0;
    Widget child = MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: quitApp,
        behavior: HitTestBehavior.opaque,
        child: Padding(
          padding: EdgeInsets.all(pad),
          child: Container(
            width: dot,
            height: dot,
            decoration: const BoxDecoration(
              color: Color(0xFFFF5F57),
              shape: BoxShape.circle,
            ),
            child: Icon(
              Icons.close,
              size: iconSize,
              color: Colors.black.withValues(alpha: 0.55),
            ),
          ),
        ),
      ),
    );
    return HudTooltip(message: 'Quit Sinain', child: child);
  }

  Widget _plainIcon(
    IconData icon,
    VoidCallback onTap, {
    bool small = false,
    String? tooltip,
  }) {
    final size = small ? 12.0 : 16.0;
    final pad = small ? 4.0 : 8.0;
    Widget child = MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: Padding(
          padding: EdgeInsets.all(pad),
          child: Icon(
            icon,
            size: size,
            color: Colors.white.withValues(alpha: 0.5),
          ),
        ),
      ),
    );
    if (tooltip != null) {
      child = HudTooltip(message: tooltip, child: child);
    }
    return child;
  }
}

class _AgentAvailabilityBanner extends StatelessWidget {
  const _AgentAvailabilityBanner();

  @override
  Widget build(BuildContext context) {
    final ws = context.watch<WebSocketService>();
    final text = _warningText(ws);
    if (text == null) return const SizedBox.shrink();
    final showStartButton = _showStartButton(ws);

    const color = Color(0xFFFFAA00);
    return Container(
      height: 38,
      margin: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: color.withValues(alpha: 0.30)),
      ),
      child: Row(
        children: [
          Icon(Icons.flash_off, size: 13, color: color.withValues(alpha: 0.9)),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              text,
              style: TextStyle(
                fontFamily: 'JetBrainsMono',
                fontSize: 10,
                color: color.withValues(alpha: 0.95),
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (showStartButton) ...[
            const SizedBox(width: 6),
            _startButton(ws, color),
          ],
        ],
      ),
    );
  }

  Widget _startButton(WebSocketService ws, Color color) {
    final agent = ws.escalationAgent;
    final label = agent.isEmpty ? 'Start local agent' : 'Start $agent';
    return HudTooltip(
      message: label,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          onTap: () {
            ws.startLocalAgent(agent);
            ws.showSystemAlert(
              agent.isEmpty
                  ? 'Starting local escalation agent...'
                  : 'Starting local escalation agent: $agent',
              priority: FeedPriority.high,
            );
          },
          behavior: HitTestBehavior.opaque,
          child: Container(
            width: 26,
            height: 24,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.16),
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: color.withValues(alpha: 0.38)),
            ),
            child: Icon(
              Icons.play_arrow_rounded,
              size: 16,
              color: color.withValues(alpha: 0.95),
            ),
          ),
        ),
      ),
    );
  }

  String? _warningText(WebSocketService ws) {
    if (!ws.connected) return null;
    if (ws.escalationState != 'active') return 'Escalation is paused';
    if (ws.availableAgents.isEmpty) return 'No escalation agent connected';
    if (ws.escalationAgent.isEmpty) return 'No escalation agent selected';
    if (!ws.agentRegistered) {
      return 'Escalation agent not connected: ${ws.escalationAgent}';
    }
    return null;
  }

  bool _showStartButton(WebSocketService ws) {
    if (!ws.connected || ws.escalationState != 'active' || ws.agentRegistered) {
      return false;
    }
    return ws.escalationAgent.isNotEmpty || ws.availableAgents.isEmpty;
  }
}

class _SystemAlertBanner extends StatelessWidget {
  const _SystemAlertBanner();

  @override
  Widget build(BuildContext context) {
    final ws = context.watch<WebSocketService>();
    final text = ws.systemAlertText;
    if (text == null || text.isEmpty) return const SizedBox.shrink();

    final urgent = ws.systemAlertPriority == FeedPriority.urgent;
    final color = urgent ? const Color(0xFFFF3344) : const Color(0xFFFFAA00);

    return Container(
      height: 44,
      margin: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: color.withValues(alpha: 0.38)),
      ),
      child: Row(
        children: [
          Icon(Icons.error_outline, size: 14, color: color),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              text,
              style: TextStyle(
                fontFamily: 'JetBrainsMono',
                fontSize: 10,
                color: color,
                height: 1.2,
              ),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: 6),
          HudTooltip(
            message: 'Dismiss',
            child: GestureDetector(
              onTap: ws.clearSystemAlert,
              behavior: HitTestBehavior.opaque,
              child: MouseRegion(
                cursor: SystemMouseCursors.click,
                child: Padding(
                  padding: const EdgeInsets.all(3),
                  child: Icon(
                    Icons.close,
                    size: 12,
                    color: color.withValues(alpha: 0.75),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
