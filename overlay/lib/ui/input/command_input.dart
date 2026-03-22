import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../core/constants.dart';

/// Compact command input field for injecting user commands into escalation context.
/// Auto-focuses on mount. Enter sends, Escape dismisses.
class CommandInput extends StatefulWidget {
  final void Function(String text) onSubmit;
  final VoidCallback onDismiss;

  const CommandInput({
    super.key,
    required this.onSubmit,
    required this.onDismiss,
  });

  @override
  State<CommandInput> createState() => _CommandInputState();
}

class _CommandInputState extends State<CommandInput> {
  final _controller = TextEditingController();
  final _focusNode = FocusNode();

  @override
  void initState() {
    super.initState();
    // Delay focus request to ensure the native window is key before Flutter
    // tries to route keyboard events to this TextField.
    Future.delayed(const Duration(milliseconds: 100), () {
      if (mounted) _focusNode.requestFocus();
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  void _submit() {
    final text = _controller.text.trim();
    if (text.isNotEmpty) {
      widget.onSubmit(text);
    }
    widget.onDismiss();
  }

  @override
  Widget build(BuildContext context) {
    return KeyboardListener(
      focusNode: FocusNode(), // outer listener for Escape
      onKeyEvent: (event) {
        if (event is KeyDownEvent &&
            event.logicalKey == LogicalKeyboardKey.escape) {
          widget.onDismiss();
        }
      },
      child: Container(
        height: 32,
        padding: const EdgeInsets.symmetric(horizontal: 8),
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: 0.95),
          border: Border(
            top: BorderSide(
              color: const Color(0xFF00FF88).withValues(alpha: 0.4),
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
                fontSize: 12,
                color: const Color(0xFF00FF88).withValues(alpha: 0.6),
              ),
            ),
            Expanded(
              child: TextField(
                controller: _controller,
                focusNode: _focusNode,
                style: const TextStyle(
                  fontFamily: HudConstants.monoFont,
                  fontFamilyFallback: HudConstants.monoFontFallbacks,
                  fontSize: 12,
                  color: Colors.white,
                ),
                cursorColor: const Color(0xFF00FF88),
                decoration: InputDecoration(
                  hintText: 'command for next escalation…',
                  hintStyle: TextStyle(
                    fontFamily: HudConstants.monoFont,
                    fontFamilyFallback: HudConstants.monoFontFallbacks,
                    fontSize: 12,
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
