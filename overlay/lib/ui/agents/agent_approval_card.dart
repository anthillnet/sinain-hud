import 'package:flutter/material.dart';

import '../../core/models/agent_session.dart';

class AgentApprovalCard extends StatelessWidget {
  final AgentApprovalRequest request;
  final ValueChanged<String> onReply;
  final VoidCallback? onDismiss;
  final String? branch;
  final String? resolution;

  const AgentApprovalCard({
    super.key,
    required this.request,
    required this.onReply,
    this.onDismiss,
    this.branch,
    this.resolution,
  });

  static const _amber = Color(0xFFD9A21B);

  String get _elapsed {
    final seconds = request.elapsed.inSeconds.clamp(0, 359999);
    if (seconds < 60) return '${seconds}s';
    if (seconds < 3600) return '${seconds ~/ 60}m';
    return '${seconds ~/ 3600}h';
  }

  @override
  Widget build(BuildContext context) {
    if (resolution != null) {
      final denied = resolution == 'Denied';
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          color: const Color(0xFF232427),
          borderRadius: BorderRadius.circular(7),
          border: Border.all(color: Colors.white.withValues(alpha: 0.1)),
        ),
        child: Row(children: [
          _dot(denied ? const Color(0xFFB3361C) : const Color(0xFF1F8039)),
          const SizedBox(width: 7),
          Text(resolution!, style: const TextStyle(color: Color(0xFFE8EAEE), fontSize: 11, fontWeight: FontWeight.w700)),
          const SizedBox(width: 8),
          Expanded(child: Text(request.command, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontFamily: 'JetBrainsMono', color: Color(0xFFA8ADBD), fontSize: 10))),
        ]),
      );
    }
    return Container(
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
                boxShadow: [BoxShadow(color: Color(0x66D9A21B), blurRadius: 3, spreadRadius: 3)],
              ),
            ),
            const SizedBox(width: 8),
            Expanded(child: Text(request.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Color(0xFFE8EAEE), fontSize: 12, fontWeight: FontWeight.w700))),
            if (onDismiss != null)
              GestureDetector(onTap: onDismiss, child: const Padding(padding: EdgeInsets.all(3), child: Text('✕', style: TextStyle(color: Color(0xFF6C707E), fontSize: 11)))),
          ]),
          const SizedBox(height: 9),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(9),
            decoration: BoxDecoration(color: const Color(0xFF232427), borderRadius: BorderRadius.circular(7)),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(request.command, maxLines: 3, overflow: TextOverflow.ellipsis, style: const TextStyle(fontFamily: 'JetBrainsMono', color: Color(0xFFE8EAEE), fontSize: 11)),
              const SizedBox(height: 7),
              Wrap(spacing: 5, crossAxisAlignment: WrapCrossAlignment.center, children: [
                Text('$_elapsed in', style: const TextStyle(fontFamily: 'JetBrainsMono', color: Color(0xFFA8ADBD), fontSize: 10)),
                if (request.source.isNotEmpty) _chip(request.source),
                if (branch?.isNotEmpty ?? false) _chip('⎇ $branch'),
              ]),
            ]),
          ),
          const SizedBox(height: 9),
          Row(children: [
            _button('Allow', () => onReply('allow'), filled: true),
            const SizedBox(width: 6),
            _button('Always', () => onReply('always'), bordered: true),
            const Spacer(),
            _button('Deny', () => onReply('deny'), quiet: true),
          ]),
        ],
      ),
    );
  }

  Widget _button(String text, VoidCallback onTap, {bool filled = false, bool bordered = false, bool quiet = false}) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: 28,
        alignment: Alignment.center,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          color: filled ? const Color(0xFF1F8039) : Colors.transparent,
          borderRadius: BorderRadius.circular(6),
          border: bordered ? Border.all(color: Colors.white.withValues(alpha: 0.25)) : null,
        ),
        child: Text(text, style: TextStyle(color: const Color(0xFFE8EAEE), fontSize: 10, fontWeight: filled ? FontWeight.w700 : FontWeight.normal, decoration: quiet ? TextDecoration.underline : null, decorationColor: const Color(0xFFA8ADBD))),
      ),
    );
  }

  Widget _chip(String text) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
        decoration: BoxDecoration(borderRadius: BorderRadius.circular(4), border: Border.all(color: Colors.white.withValues(alpha: 0.12))),
        child: Text(text, style: const TextStyle(fontFamily: 'JetBrainsMono', color: Color(0xFFA8ADBD), fontSize: 10)),
      );

  Widget _dot(Color color) => Container(width: 7, height: 7, decoration: BoxDecoration(color: color, shape: BoxShape.circle));
}
