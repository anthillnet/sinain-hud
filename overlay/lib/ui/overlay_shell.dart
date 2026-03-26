import 'dart:io';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../core/models/hud_settings.dart';
import '../core/services/settings_service.dart';
import '../core/services/websocket_service.dart';
import '../core/services/window_service.dart';
import 'eye/eye_widget.dart';
import 'feed/feed_view.dart';
import 'feed/idle_animation.dart';
import 'input/command_input.dart';
import '../core/models/feed_item.dart';

/// Top-level shell managing the 3-state overlay: Eye → Controls → Chat.
class OverlayShell extends StatefulWidget {
  const OverlayShell({super.key});

  @override
  OverlayShellState createState() => OverlayShellState();
}

class OverlayShellState extends State<OverlayShell> {
  HudState _state = HudState.eye;
  HudState _lastVisibleState = HudState.eye;

  late final WindowService _windowService;
  late final SettingsService _settingsService;

  @override
  void initState() {
    super.initState();
    _windowService = context.read<WindowService>();
    _settingsService = context.read<SettingsService>();
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
        const controlsW = 280.0;
        _windowService.setWindowFrame(eyeRight - controlsW, eyeBottom, controlsW, 48);
      case HudState.chat:
        final chatW = _settingsService.settings.chatWidth;
        final chatH = _settingsService.settings.chatHeight;
        _windowService.setWindowFrame(eyeRight - chatW, eyeBottom, chatW, chatH);
      case HudState.hidden:
        break;
    }
  }

  void _onDrag(DragUpdateDetails details) {
    _windowService.moveWindowBy(details.delta.dx, -details.delta.dy);
  }

  void _openSettings() {
    final ws = context.read<WebSocketService>();
    final path = ws.envPath.isNotEmpty
        ? ws.envPath
        : '${Platform.environment['HOME'] ?? '/tmp'}/.sinain/.env';
    _windowService.openFile(path);
  }

  @override
  Widget build(BuildContext context) {
    if (_state == HudState.hidden) {
      return const SizedBox.shrink();
    }

    switch (_state) {
      case HudState.eye:
        return EyeWidget(
          onTap: () => _transitionTo(HudState.controls),
          onLongPress: () => toggleVisibility(false),
          onDragEnd: _persistEyePosition,
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
      onPanUpdate: _onDrag,
      onPanEnd: (_) => _persistEyePosition(),
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
            _actionIcon(Icons.settings, 'settings', _openSettings),
            _actionIcon(Icons.chevron_right, 'collapse', () => _transitionTo(HudState.eye)),
            _actionIcon(Icons.open_in_full, 'expand', () => _transitionTo(HudState.chat)),
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
                child: const IdleAnimation(size: 32),
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
            onPanUpdate: _onDrag,
            onPanEnd: (_) => _persistEyePosition(),
            child: Container(
              height: 36,
              padding: const EdgeInsets.symmetric(horizontal: 6),
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.03),
                borderRadius: const BorderRadius.vertical(top: Radius.circular(8)),
              ),
              child: Row(
                children: [
                  // Collapse
                  _actionIcon(Icons.expand_more, 'collapse', () => _transitionTo(HudState.controls)),
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
                  const Spacer(),
                  // Settings
                  _actionIcon(Icons.settings, 'settings', _openSettings, small: true),
                  const SizedBox(width: 4),
                  // Eye — collapses all the way to State 1
                  GestureDetector(
                    onTap: () => _transitionTo(HudState.eye),
                    child: Container(
                      width: 24,
                      height: 24,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: Colors.black.withValues(alpha: 0.3),
                      ),
                      child: const IdleAnimation(size: 20),
                    ),
                  ),
                  const SizedBox(width: 2),
                ],
              ),
            ),
          ),
          // Feed content
          const Expanded(
            child: FeedView(
              channel: FeedChannel.agent,
              emptyLabel: 'awaiting context…',
            ),
          ),
          // Command input
          CommandInput(
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
        // Left edge resize — grow left, anchor right edge
        _resizeHandle(Alignment.centerLeft, SystemMouseCursors.resizeLeft,
            (dx, dy) => _windowService.resizeWindowBy(-dx, 0, anchorRight: true)),
        // Right edge resize — grow right, anchor left edge
        _resizeHandle(Alignment.centerRight, SystemMouseCursors.resizeRight,
            (dx, dy) => _windowService.resizeWindowBy(dx, 0)),
        // Top edge resize — grow up, anchor top (macOS: keep top edge fixed)
        _resizeHandle(Alignment.topCenter, SystemMouseCursors.resizeUp,
            (dx, dy) => _windowService.resizeWindowBy(0, -dy, anchorTop: true)),
        // Bottom edge resize — grow down, anchor bottom (macOS: origin stays)
        _resizeHandle(Alignment.bottomCenter, SystemMouseCursors.resizeDown,
            (dx, dy) => _windowService.resizeWindowBy(0, dy)),
      ],
    );
  }

  Widget _resizeHandle(
    Alignment alignment,
    MouseCursor cursor,
    void Function(double dx, double dy) onDrag,
  ) {
    final isHorizontal =
        alignment == Alignment.centerLeft || alignment == Alignment.centerRight;
    return Align(
      alignment: alignment,
      child: MouseRegion(
        cursor: cursor,
        child: GestureDetector(
          onPanUpdate: (details) => onDrag(details.delta.dx, details.delta.dy),
          onPanEnd: (_) => _persistChatSize(),
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
                ? const Color(0xFF00FF88)
                : Colors.white.withValues(alpha: 0.3),
          ),
        ),
      ),
    );
  }

  Widget _actionIcon(IconData icon, String tooltip, VoidCallback onTap, {bool small = false}) {
    final size = small ? 12.0 : 16.0;
    final pad = small ? 4.0 : 8.0;
    return Tooltip(
      message: tooltip,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          onTap: onTap,
          behavior: HitTestBehavior.opaque,
          child: Padding(
            padding: EdgeInsets.all(pad),
            child: Icon(icon, size: size, color: Colors.white.withValues(alpha: 0.5)),
          ),
        ),
      ),
    );
  }
}
