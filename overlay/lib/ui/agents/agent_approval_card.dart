import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/models/agent_session.dart';
import '../../core/services/websocket_service.dart';

class AgentApprovalCard extends StatefulWidget {
  final AgentApprovalRequest request;
  final ValueChanged<String> onReply;
  final void Function(String behavior, {String? answer})? onReplyWithAnswer;
  final VoidCallback? onDismiss;
  final VoidCallback? onSnapRegion;
  final ValueNotifier<String?>? externalAnswerAppend;
  final VoidCallback? onDispose;
  final String? branch;
  final String? resolution;

  const AgentApprovalCard({
    super.key,
    required this.request,
    required this.onReply,
    this.onReplyWithAnswer,
    this.onDismiss,
    this.onSnapRegion,
    this.externalAnswerAppend,
    this.onDispose,
    this.branch,
    this.resolution,
  });

  static const _amber = Color(0xFFD9A21B);

  @override
  State<AgentApprovalCard> createState() => _AgentApprovalCardState();
}

class _AgentApprovalCardState extends State<AgentApprovalCard> {
  final _answerController = TextEditingController();

  static const _amber = AgentApprovalCard._amber;

  @override
  void initState() {
    super.initState();
    widget.externalAnswerAppend?.addListener(_appendExternalAnswer);
  }

  @override
  void didUpdateWidget(covariant AgentApprovalCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.externalAnswerAppend != widget.externalAnswerAppend) {
      oldWidget.externalAnswerAppend?.removeListener(_appendExternalAnswer);
      widget.externalAnswerAppend?.addListener(_appendExternalAnswer);
    }
  }

  void _appendExternalAnswer() {
    final append = widget.externalAnswerAppend?.value;
    if (append == null || append.isEmpty) return;
    final current = _answerController.text;
    _answerController.text = current.isEmpty ? append : '$current $append';
    _answerController.selection = TextSelection.collapsed(
      offset: _answerController.text.length,
    );
  }

  @override
  void dispose() {
    widget.externalAnswerAppend?.removeListener(_appendExternalAnswer);
    widget.onDispose?.call();
    _answerController.dispose();
    super.dispose();
  }

  void _reply(String behavior) {
    final answer = _answerController.text.trim();
    final callback = widget.onReplyWithAnswer;
    if (callback != null) {
      callback(behavior, answer: answer.isEmpty ? null : answer);
    } else if (answer.isNotEmpty) {
      // Compatibility for hosts that still provide the original one-argument
      // callback: the note must not be dropped while those call sites migrate.
      context.read<WebSocketService>().sendAgentApprovalReply(
            widget.request.id,
            behavior,
            answer: answer,
          );
    } else {
      widget.onReply(behavior);
    }
  }

  String get _elapsed {
    final seconds = widget.request.elapsed.inSeconds.clamp(0, 359999);
    if (seconds < 60) return '${seconds}s';
    if (seconds < 3600) return '${seconds ~/ 60}m';
    return '${seconds ~/ 3600}h';
  }

  @override
  Widget build(BuildContext context) {
    if (widget.resolution != null) {
      final denied = widget.resolution == 'Denied';
      return Material(
        type: MaterialType.transparency,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          decoration: BoxDecoration(
            color: const Color(0xFF232427),
            borderRadius: BorderRadius.circular(7),
            border: Border.all(color: Colors.white.withValues(alpha: 0.1)),
          ),
          child: Row(children: [
            _dot(denied ? const Color(0xFFB3361C) : const Color(0xFF1F8039)),
            const SizedBox(width: 7),
            Text(widget.resolution!,
                style: const TextStyle(
                    color: Color(0xFFE8EAEE),
                    fontSize: 11,
                    fontWeight: FontWeight.w700)),
            const SizedBox(width: 8),
            Expanded(
                child: Text(widget.request.command,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontFamily: 'JetBrainsMono',
                        color: Color(0xFFA8ADBD),
                        fontSize: 10))),
          ]),
        ),
      );
    }
    return Material(
      type: MaterialType.transparency,
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: const Color(0xFF1E1F22),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: Colors.white.withValues(alpha: 0.1)),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              Container(
                width: 8,
                height: 8,
                decoration: const BoxDecoration(
                  color: _amber,
                  shape: BoxShape.circle,
                  boxShadow: [
                    BoxShadow(
                        color: Color(0x66D9A21B),
                        blurRadius: 3,
                        spreadRadius: 3)
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                  child: Text(widget.request.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          color: Color(0xFFE8EAEE),
                          fontSize: 12,
                          fontWeight: FontWeight.w700))),
              if (widget.onDismiss != null)
                GestureDetector(
                    onTap: widget.onDismiss,
                    child: const Padding(
                        padding: EdgeInsets.all(3),
                        child: Text('✕',
                            style: TextStyle(
                                color: Color(0xFF6C707E), fontSize: 11)))),
            ]),
            const SizedBox(height: 9),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(9),
              decoration: BoxDecoration(
                  color: const Color(0xFF232427),
                  borderRadius: BorderRadius.circular(7)),
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(widget.request.command,
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            fontFamily: 'JetBrainsMono',
                            color: Color(0xFFE8EAEE),
                            fontSize: 11)),
                    const SizedBox(height: 7),
                    Wrap(
                        spacing: 5,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          Text('$_elapsed in',
                              style: const TextStyle(
                                  fontFamily: 'JetBrainsMono',
                                  color: Color(0xFFA8ADBD),
                                  fontSize: 10)),
                          if (widget.request.source.isNotEmpty)
                            _chip(widget.request.source),
                          if (widget.branch?.isNotEmpty ?? false)
                            _chip('⎇ ${widget.branch}'),
                        ]),
                  ]),
            ),
            const SizedBox(height: 9),
            Row(children: [
              _button('Allow', () => _reply('allow'), filled: true),
              const SizedBox(width: 6),
              _button('Always', () => _reply('always'), bordered: true),
              const Spacer(),
              _button('Deny', () => _reply('deny'), quiet: true),
            ]),
            const SizedBox(height: 9),
            CustomPaint(
              foregroundPainter:
                  _DashedBorderPainter(_amber.withValues(alpha: 0.48)),
              child: Row(children: [
                Expanded(
                  child: TextField(
                    controller: _answerController,
                    maxLength: 500,
                    maxLines: 1,
                    textInputAction: TextInputAction.done,
                    onSubmitted: (_) => _reply('allow'),
                    style: const TextStyle(
                        fontFamily: 'JetBrainsMono',
                        color: Color(0xFFE8EAEE),
                        fontSize: 10),
                    decoration: const InputDecoration(
                      hintText: 'add a note for the agent…',
                      hintStyle: TextStyle(
                          fontFamily: 'JetBrainsMono',
                          color: Color(0xFF7D7461),
                          fontSize: 10),
                      counterText: '',
                      isDense: true,
                      contentPadding:
                          EdgeInsets.symmetric(horizontal: 9, vertical: 8),
                      border: InputBorder.none,
                    ),
                  ),
                ),
                Tooltip(
                  message: 'Add screen region',
                  child: GestureDetector(
                    onTap: widget.onSnapRegion,
                    child: const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 9),
                      child: Text('⌖',
                          style: TextStyle(color: _amber, fontSize: 13)),
                    ),
                  ),
                ),
              ]),
            ),
          ],
        ),
      ),
    );
  }

  Widget _button(String text, VoidCallback onTap,
      {bool filled = false, bool bordered = false, bool quiet = false}) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: 28,
        alignment: Alignment.center,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          color: filled ? const Color(0xFF1F8039) : Colors.transparent,
          borderRadius: BorderRadius.circular(6),
          border: bordered
              ? Border.all(color: Colors.white.withValues(alpha: 0.25))
              : null,
        ),
        child: Text(text,
            style: TextStyle(
                color: const Color(0xFFE8EAEE),
                fontSize: 10,
                fontWeight: filled ? FontWeight.w700 : FontWeight.normal,
                decoration: quiet ? TextDecoration.underline : null,
                decorationColor: const Color(0xFFA8ADBD))),
      ),
    );
  }

  Widget _chip(String text) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
        decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(4),
            border: Border.all(color: Colors.white.withValues(alpha: 0.12))),
        child: Text(text,
            style: const TextStyle(
                fontFamily: 'JetBrainsMono',
                color: Color(0xFFA8ADBD),
                fontSize: 10)),
      );

  Widget _dot(Color color) => Container(
      width: 7,
      height: 7,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle));
}

class _DashedBorderPainter extends CustomPainter {
  final Color color;
  const _DashedBorderPainter(this.color);

  @override
  void paint(Canvas canvas, Size size) {
    final path = Path()
      ..addRRect(RRect.fromRectAndRadius(
          Offset.zero & size, const Radius.circular(6)));
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    for (final metric in path.computeMetrics()) {
      for (double distance = 0; distance < metric.length; distance += 6) {
        canvas.drawPath(
            metric.extractPath(
                distance, (distance + 3).clamp(0, metric.length)),
            paint);
      }
    }
  }

  @override
  bool shouldRepaint(covariant _DashedBorderPainter oldDelegate) =>
      oldDelegate.color != color;
}
