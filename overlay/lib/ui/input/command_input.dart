import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import '../../core/constants.dart';
import '../../core/services/settings_service.dart';

/// Compact command input field for injecting user commands into escalation context.
/// Auto-focuses on mount. Enter sends to main session, Shift+Enter spawns background agent.
/// Escape dismisses.
class CommandInput extends StatefulWidget {
  final void Function(String text) onSubmit;
  final void Function(String text)? onSpawn;
  final VoidCallback? onDismiss;
  final FocusNode? externalFocusNode;

  const CommandInput({
    super.key,
    required this.onSubmit,
    this.onSpawn,
    this.onDismiss,
    this.externalFocusNode,
  });

  @override
  State<CommandInput> createState() => _CommandInputState();
}

class _CommandInputState extends State<CommandInput> {
  final _controller = TextEditingController();
  late final FocusNode _focusNode;

  @override
  void initState() {
    super.initState();
    _focusNode = widget.externalFocusNode ?? FocusNode();
    // Delay focus request to ensure the native window is key before Flutter
    // tries to route keyboard events to this TextField.
    Future.delayed(const Duration(milliseconds: 100), () {
      if (mounted) _focusNode.requestFocus();
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    if (widget.externalFocusNode == null) _focusNode.dispose();
    super.dispose();
  }

  void _submit() {
    final text = _controller.text.trim();
    if (text.isNotEmpty) {
      widget.onSubmit(text);
    }
    _controller.clear();
    widget.onDismiss?.call();
  }

  void _spawn() {
    final text = _controller.text.trim();
    if (text.isNotEmpty && widget.onSpawn != null) {
      widget.onSpawn!(text);
    }
    _controller.clear();
    widget.onDismiss?.call();
  }

  @override
  Widget build(BuildContext context) {
    final s = context.watch<SettingsService>().settings;
    final fs = s.fontSize;
    final accent = Color(s.accentColor != 0 ? s.accentColor : 0xFF00FF88);
    return KeyboardListener(
      focusNode: FocusNode(), // outer listener for Escape + Shift+Enter
      onKeyEvent: (event) {
        if (event is KeyDownEvent) {
          if (event.logicalKey == LogicalKeyboardKey.escape) {
            widget.onDismiss?.call();
          } else if (event.logicalKey == LogicalKeyboardKey.enter &&
              HardwareKeyboard.instance.isShiftPressed) {
            _spawn();
          }
        }
      },
      child: Container(
        height: 32,
        padding: const EdgeInsets.symmetric(horizontal: 8),
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: 0.95),
          border: Border(
            top: BorderSide(
              color: accent.withValues(alpha: 0.4),
              width: 1,
            ),
          ),
        ),
        child: Row(
          children: [
            Text(
              '⌘ ',
              style: TextStyle(
                fontFamily: HudConstants.monoFont,
                fontFamilyFallback: HudConstants.monoFontFallbacks,
                fontSize: fs,
                color: accent.withValues(alpha: 0.6),
              ),
            ),
            Expanded(
              child: TextField(
                controller: _controller,
                focusNode: _focusNode,
                style: TextStyle(
                  fontFamily: HudConstants.monoFont,
                  fontFamilyFallback: HudConstants.monoFontFallbacks,
                  fontSize: fs,
                  color: Colors.white,
                ),
                cursorColor: accent,
                decoration: InputDecoration(
                  hintText: widget.onSpawn != null
                      ? 'Enter = send  |  Shift+Enter = spawn agent'
                      : 'command for next escalation…',
                  hintStyle: TextStyle(
                    fontFamily: HudConstants.monoFont,
                    fontFamilyFallback: HudConstants.monoFontFallbacks,
                    fontSize: fs,
                    color: Colors.white.withValues(alpha: 0.3),
                  ),
                  border: InputBorder.none,
                  isDense: true,
                  contentPadding: const EdgeInsets.symmetric(vertical: 8),
                ),
                onSubmitted: (_) => _submit(),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
