import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../core/models/hud_settings.dart';
import '../core/services/onboarding_service.dart';
import '../core/services/settings_service.dart';
import '../core/services/websocket_service.dart';
import '../core/services/window_service.dart';
import 'eye/eye_widget.dart';
import 'feed/feed_view.dart';
import 'feed/idle_animation.dart';
import 'input/command_input.dart';
import 'onboarding/onboarding_view.dart';
import 'settings/display_settings_panel.dart';
import 'tasks/tasks_view.dart';
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
  StreamSubscription<FeedItem>? _contentSub;
  StreamSubscription<List<RegionHighlight>>? _regionSub;
  StreamSubscription<String>? _regionTapSub;
  List<RegionHighlight> _activeRegions = [];

  // Display settings panel
  bool _showDisplaySettings = false;

  // Command input focus
  final _commandFocusNode = FocusNode();

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

    // Native drag/resize callbacks (macOS only)
    if (_isMacOS) {
      _windowService.setupNativeCallbacks(
        onDragDone: (x, y) => _settingsService.setEyePosition(x, y),
        onResizeDone: (w, h) => _settingsService.setChatSize(w, h),
      );
    }

    final ws = context.read<WebSocketService>();
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
    // Region highlights → spawn native eye windows
    _regionSub = ws.regionHighlightStream.listen((regions) {
      _activeRegions = regions;
      _windowService.removeAllRegionWindows();
      for (var i = 0; i < regions.length; i++) {
        // Position: top-right corner, spaced horizontally
        // TODO: use actual bbox from sense ROI when wired
        final x = 1400.0 - (i * 60);
        final y = 80.0;
        _windowService.createRegionWindow('region-$i', x, y);
      }
    });
    // Region tap → post issue to feed + spawn command
    _regionTapSub = _windowService.regionTapStream.listen((id) {
      final idx = int.tryParse(id.replaceFirst('region-', '')) ?? -1;
      if (idx >= 0 && idx < _activeRegions.length) {
        final r = _activeRegions[idx];
        // Post to HUD feed
        ws.send({
          'type': 'spawn_command',
          'text': '${r.action ?? "help"}: ${r.tip}',
        });
      }
    });
  }

  static const _redEye = Color(0xFFFF3344);

  double get _pupilDilation {
    if (_isThinking) return 0.3;
    if (_hasNewContent) return 0.6;
    return 0.0;
  }

  Color get _accentColor {
    final c = _settingsService.settings.accentColor;
    return Color(c != 0 ? c : 0xFF00FF88);
  }

  Color get _eyeColor =>
      _settingsService.settings.privacyMode ? _accentColor : _redEye;

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
        const controlsW = 320.0;
        _windowService.setWindowFrame(eyeRight - controlsW, eyeBottom, controlsW, 48);
      case HudState.chat:
        final chatW = _settingsService.settings.chatWidth;
        final chatH = _settingsService.settings.chatHeight;
        _windowService.setWindowFrame(eyeRight - chatW, eyeBottom, chatW, chatH);
      case HudState.hidden:
        break;
    }
  }

  @override
  void dispose() {
    _thinkingSub?.cancel();
    _contentSub?.cancel();
    _regionSub?.cancel();
    _regionTapSub?.cancel();
    _windowService.removeAllRegionWindows();
    _contentResetTimer?.cancel();
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

  @override
  Widget build(BuildContext context) {
    // Show onboarding if not complete
    final onboarding = context.watch<OnboardingService>();
    if (!onboarding.isComplete) {
      return const SizedBox(
        width: 320,
        height: 380,
        child: OnboardingView(),
      );
    }

    context.watch<SettingsService>(); // rebuild on privacy mode change (eye color)
    if (_state == HudState.hidden) {
      return const SizedBox.shrink();
    }

    switch (_state) {
      case HudState.eye:
        return EyeWidget(
          onTap: () => _transitionTo(HudState.controls),
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
            _toggleIcon(
              icon: ws.screenState == 'active' ? Icons.visibility : Icons.visibility_off,
              active: ws.screenState == 'active',
              onTap: () => ws.sendCommand('toggle_screen'),
            ),
            _toggleIcon(
              icon: ws.audioState == 'active' ? Icons.volume_up_rounded : Icons.volume_off_rounded,
              active: ws.audioState == 'active',
              onTap: () => ws.sendCommand('toggle_audio'),
            ),
            _toggleIcon(
              icon: ws.micState == 'active' ? Icons.mic : Icons.mic_off,
              active: ws.micState == 'active',
              onTap: () => ws.sendCommand('toggle_mic'),
            ),
            const Spacer(),
            // Cost counter (replaces DEMO badge when cost > 0)
            if (ws.totalCost > 0)
              _costText(ws.totalCost)
            // Demo badge (only when no cost data yet)
            else if (!_settingsService.settings.privacyMode)
              GestureDetector(
                onTap: _toggleDemoMode,
                child: MouseRegion(
                  cursor: SystemMouseCursors.click,
                  child: Padding(
                    padding: const EdgeInsets.only(right: 4),
                    child: Text('DEMO', style: TextStyle(
                      fontFamily: 'JetBrainsMono', fontSize: 9, fontWeight: FontWeight.bold,
                      color: _redEye.withValues(alpha: 0.8),
                    )),
                  ),
                ),
              ),
            _plainIcon(Icons.settings, _openSettings),
            _plainIcon(Icons.chevron_left, () => _transitionTo(HudState.eye)),
            _plainIcon(Icons.open_in_full, () => _transitionTo(HudState.chat)),
            const SizedBox(width: 4),
            // Eye animation
            GestureDetector(
              onTap: () => _transitionTo(HudState.eye),
              child: Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: Colors.black.withValues(alpha: 0.3),
                ),
                child: IdleAnimation(size: 32, pupilDilation: _pupilDilation, color: _eyeColor),
              ),
            ),
            const SizedBox(width: 4),
          ],
        ),
      ),
    );
  }

  // ── State 3: Chat Panel ────────────────────────────────────────────────────

  Widget _buildChatPanel() {
    final ws = context.watch<WebSocketService>();

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
                borderRadius: const BorderRadius.vertical(top: Radius.circular(8)),
              ),
              child: Row(
                children: [
                  // Collapse
                  _plainIcon(Icons.expand_more, () => _transitionTo(HudState.controls), small: true),
                  const SizedBox(width: 2),
                  // Capture toggles
                  _toggleIcon(
                    icon: ws.screenState == 'active' ? Icons.visibility : Icons.visibility_off,
                    active: ws.screenState == 'active',
                    onTap: () => ws.sendCommand('toggle_screen'),
                    small: true,
                  ),
                  _toggleIcon(
                    icon: ws.audioState == 'active' ? Icons.volume_up_rounded : Icons.volume_off_rounded,
                    active: ws.audioState == 'active',
                    onTap: () => ws.sendCommand('toggle_audio'),
                    small: true,
                  ),
                  _toggleIcon(
                    icon: ws.micState == 'active' ? Icons.mic : Icons.mic_off,
                    active: ws.micState == 'active',
                    onTap: () => ws.sendCommand('toggle_mic'),
                    small: true,
                  ),
                  const SizedBox(width: 4),
                  // Tab indicator (clickable)
                  Consumer<SettingsService>(
                    builder: (_, settings, __) => GestureDetector(
                      onTap: () => _settingsService.cycleTab(),
                      child: MouseRegion(
                        cursor: SystemMouseCursors.click,
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(3),
                            color: Colors.white.withValues(alpha: 0.06),
                          ),
                          child: Text(
                            settings.settings.activeTab == HudTab.agent ? 'AGT' : 'TSK',
                            style: TextStyle(
                              fontFamily: 'JetBrainsMono', fontSize: 9,
                              color: Colors.white.withValues(alpha: 0.4),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                  const Spacer(),
                  // Cost counter
                  _costText(ws.totalCost),
                  // Demo toggle (clickable in both states)
                  GestureDetector(
                    onTap: _toggleDemoMode,
                    child: MouseRegion(
                      cursor: SystemMouseCursors.click,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        child: _settingsService.settings.privacyMode
                            ? Icon(Icons.videocam_off, size: 12,
                                color: Colors.white.withValues(alpha: 0.3))
                            : Text('DEMO', style: TextStyle(
                                fontFamily: 'JetBrainsMono', fontSize: 8,
                                fontWeight: FontWeight.bold,
                                color: _redEye.withValues(alpha: 0.8),
                              )),
                      ),
                    ),
                  ),
                  // Settings — tap toggles display panel, long-press opens .env
                  MouseRegion(
                    cursor: SystemMouseCursors.click,
                    child: GestureDetector(
                      onTap: () => setState(() => _showDisplaySettings = !_showDisplaySettings),
                      onLongPress: _openSettings,
                      behavior: HitTestBehavior.opaque,
                      child: Padding(
                        padding: const EdgeInsets.all(4),
                        child: Icon(Icons.settings, size: 12,
                            color: _showDisplaySettings
                                ? _accentColor
                                : Colors.white.withValues(alpha: 0.5)),
                      ),
                    ),
                  ),
                  const SizedBox(width: 4),
                  // Eye — collapses all the way to State 1
                  GestureDetector(
                    onTap: () => _transitionTo(HudState.eye),
                    child: Container(
                      width: 32,
                      height: 32,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: Colors.black.withValues(alpha: 0.3),
                      ),
                      child: IdleAnimation(size: 28, pupilDilation: _pupilDilation, color: _eyeColor),
                    ),
                  ),
                  const SizedBox(width: 2),
                ],
              ),
            ),
          ),
          // Display settings panel
          if (_showDisplaySettings)
            DisplaySettingsPanel(
              onClose: () => setState(() => _showDisplaySettings = false),
            ),
          // Tab content (Agent feed / Tasks)
          Expanded(
            child: Consumer<SettingsService>(
              builder: (_, settings, __) => IndexedStack(
                index: settings.settings.activeTab == HudTab.agent ? 0 : 1,
                children: const [
                  FeedView(
                    channel: FeedChannel.agent,
                    emptyLabel: 'awaiting sinain…',
                  ),
                  TasksView(),
                ],
              ),
            ),
          ),
          // Command input
          CommandInput(
            externalFocusNode: _commandFocusNode,
            onSubmit: (text) {
              context.read<WebSocketService>().sendUserCommand(text);
            },
            onSpawn: (text) {
              context.read<WebSocketService>().sendSpawnCommand(text);
            },
          ),
        ],
      ),
    );

    // Wrap in a Stack with resize handles on edges
    return Stack(
      children: [
        chatContent,
        _resizeHandle(Alignment.centerLeft, SystemMouseCursors.resizeLeft, 'left',
            (dx, dy) => _windowService.resizeWindowBy(-dx, 0, anchorRight: true)),
        _resizeHandle(Alignment.centerRight, SystemMouseCursors.resizeRight, 'right',
            (dx, dy) => _windowService.resizeWindowBy(dx, 0)),
        _resizeHandle(Alignment.topCenter, SystemMouseCursors.resizeUp, 'top',
            (dx, dy) => _windowService.resizeWindowBy(0, -dy)),
        _resizeHandle(Alignment.bottomCenter, SystemMouseCursors.resizeDown, 'bottom',
            (dx, dy) => _windowService.resizeWindowBy(0, dy, anchorTop: true)),
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
                  if (details.delta.dx.abs() < 1.0 && details.delta.dy.abs() < 1.0) return;
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
  }) {
    final size = small ? 12.0 : 16.0;
    final pad = small ? 4.0 : 8.0;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: Padding(
          padding: EdgeInsets.all(pad),
          child: Icon(
            icon,
            size: size,
            color: active
                ? _accentColor
                : Colors.white.withValues(alpha: 0.3),
          ),
        ),
      ),
    );
  }

  Widget _costText(double cost) {
    if (cost <= 0) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(right: 4),
      child: Text(
        '\$${cost.toStringAsFixed(4)}',
        style: TextStyle(
          fontFamily: 'JetBrainsMono', fontSize: 9,
          color: Colors.white.withValues(alpha: 0.35),
        ),
      ),
    );
  }

  Widget _plainIcon(IconData icon, VoidCallback onTap, {bool small = false}) {
    final size = small ? 12.0 : 16.0;
    final pad = small ? 4.0 : 8.0;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: Padding(
          padding: EdgeInsets.all(pad),
          child: Icon(icon, size: size, color: Colors.white.withValues(alpha: 0.5)),
        ),
      ),
    );
  }
}
