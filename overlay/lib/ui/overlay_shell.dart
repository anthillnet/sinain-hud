import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../core/models/hud_settings.dart';
import '../core/services/settings_service.dart';
import '../core/services/window_service.dart';
import 'eye/eye_widget.dart';

/// Top-level shell managing the 3-state overlay: Eye → Controls → Chat.
/// Replaces the old HudShell with its 4-mode system.
class OverlayShell extends StatefulWidget {
  const OverlayShell({super.key});

  @override
  OverlayShellState createState() => OverlayShellState();
}

class OverlayShellState extends State<OverlayShell> {
  HudState _state = HudState.eye;
  HudState _lastVisibleState = HudState.eye;

  /// Called from main.dart hotkey handler.
  void toggleVisibility(bool visible) {
    final settings = context.read<SettingsService>();
    if (visible) {
      setState(() => _state = _lastVisibleState);
      settings.setHudState(_lastVisibleState);
    } else {
      _lastVisibleState = _state;
      setState(() => _state = HudState.hidden);
      settings.setHudState(HudState.hidden);
    }
  }

  /// Called from main.dart hotkey handler — jump between Eye ↔ Chat.
  void toggleChat() {
    if (_state == HudState.chat) {
      _transitionTo(HudState.eye);
    } else {
      _transitionTo(HudState.chat);
    }
  }

  void _transitionTo(HudState target) {
    if (_state == target) return;
    final windowService = context.read<WindowService>();
    final settings = context.read<SettingsService>();

    setState(() => _state = target);
    settings.setHudState(target);

    // Resize window to match new state
    _resizeWindowForState(target, windowService, settings);

    // Make key window when entering chat (for text input)
    if (target == HudState.chat) {
      windowService.makeKeyWindow();
    } else {
      windowService.resignKeyWindow();
    }
  }

  Future<void> _resizeWindowForState(
    HudState state,
    WindowService windowService,
    SettingsService settings,
  ) async {
    final frame = await windowService.getWindowFrame();
    if (frame == null) return;

    // Keep the eye position as anchor (bottom-right of current frame)
    final eyeRight = frame['x']! + frame['w']!;
    final eyeBottom = frame['y']!;

    switch (state) {
      case HudState.eye:
        windowService.setWindowFrame(
          eyeRight - 48,
          eyeBottom,
          48,
          48,
        );
      case HudState.controls:
        const controlsW = 280.0;
        windowService.setWindowFrame(
          eyeRight - controlsW,
          eyeBottom,
          controlsW,
          48,
        );
      case HudState.chat:
        final chatW = settings.settings.chatWidth;
        final chatH = settings.settings.chatHeight;
        windowService.setWindowFrame(
          eyeRight - chatW,
          eyeBottom,
          chatW,
          chatH,
        );
      case HudState.hidden:
        // Don't resize — just hide via native
        break;
    }
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
        );
      case HudState.controls:
        // Phase 2 — for now, show a placeholder that expands/collapses
        return _buildControlsPlaceholder();
      case HudState.chat:
        // Phase 3 — for now, show a placeholder
        return _buildChatPlaceholder();
      case HudState.hidden:
        return const SizedBox.shrink();
    }
  }

  // Temporary placeholders for Phase 2 and 3
  Widget _buildControlsPlaceholder() {
    return Container(
      height: 48,
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.85),
        borderRadius: BorderRadius.circular(24),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(width: 8),
          // Placeholder icons
          _iconButton(Icons.visibility, 'screen', () {}),
          _iconButton(Icons.volume_up, 'audio', () {}),
          _iconButton(Icons.mic, 'mic', () {}),
          const SizedBox(width: 4),
          // Collapse
          _iconButton(Icons.chevron_right, 'collapse', () {
            _transitionTo(HudState.eye);
          }),
          // Expand
          _iconButton(Icons.open_in_full, 'expand', () {
            _transitionTo(HudState.chat);
          }),
          const SizedBox(width: 4),
          // Eye
          GestureDetector(
            onTap: () => _transitionTo(HudState.eye),
            child: const SizedBox(
              width: 40,
              height: 40,
              child: Center(
                child: Text('◎', style: TextStyle(fontSize: 20, color: Color(0xFF00FF88))),
              ),
            ),
          ),
          const SizedBox(width: 4),
        ],
      ),
    );
  }

  Widget _iconButton(IconData icon, String tooltip, VoidCallback onTap) {
    return Tooltip(
      message: tooltip,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(8),
          child: Icon(icon, size: 16, color: Colors.white.withValues(alpha: 0.6)),
        ),
      ),
    );
  }

  Widget _buildChatPlaceholder() {
    return Container(
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.85),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        children: [
          // Header with collapse
          Container(
            height: 32,
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Row(
              children: [
                GestureDetector(
                  onTap: () => _transitionTo(HudState.controls),
                  child: Icon(Icons.expand_more, size: 16, color: Colors.white.withValues(alpha: 0.6)),
                ),
                const Spacer(),
                Text(
                  'SINAIN',
                  style: TextStyle(
                    fontFamily: 'JetBrainsMono',
                    fontSize: 10,
                    color: Colors.white.withValues(alpha: 0.4),
                    letterSpacing: 2,
                  ),
                ),
                const Spacer(),
                GestureDetector(
                  onTap: () => _transitionTo(HudState.eye),
                  child: const Text('◎', style: TextStyle(fontSize: 14, color: Color(0xFF00FF88))),
                ),
              ],
            ),
          ),
          // Content area — will be FeedView in Phase 3
          Expanded(
            child: Center(
              child: Text(
                'Chat panel (Phase 3)',
                style: TextStyle(
                  fontFamily: 'JetBrainsMono',
                  fontSize: 12,
                  color: Colors.white.withValues(alpha: 0.3),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
