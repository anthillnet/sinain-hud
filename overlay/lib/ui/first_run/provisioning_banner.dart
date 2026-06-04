import 'package:flutter/material.dart';

import '../../core/services/provisioning_service.dart';

/// SEED-001 — compact "Setting up…" panel shown over the HUD while local-mode
/// components download (Python / speech model / local SLMs). Reads live state
/// from [ProvisioningService]. Draggable so it never traps the user.
class ProvisioningBanner extends StatelessWidget {
  const ProvisioningBanner({
    super.key,
    required this.service,
    this.onDrag,
  });

  final ProvisioningService service;
  final ValueChanged<DragUpdateDetails>? onDrag;

  static const Color _accent = Color(0xFF00FF88);
  static const Color _err = Color(0xFFFF6B6B);

  @override
  Widget build(BuildContext context) {
    final items = service.items;
    return GestureDetector(
      behavior: HitTestBehavior.translucent,
      onPanUpdate: onDrag,
      child: Container(
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: 0.92),
          borderRadius: BorderRadius.circular(12),
        ),
        padding: const EdgeInsets.all(16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                const SizedBox(
                  width: 12,
                  height: 12,
                  child: CircularProgressIndicator(strokeWidth: 1.6, color: _accent),
                ),
                const SizedBox(width: 8),
                Text(
                  'Setting up Sinain',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: Colors.white.withValues(alpha: 0.9),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            for (final item in items) ...[
              _row(item),
              const SizedBox(height: 8),
            ],
            Text(
              'You can keep working — this runs in the background and only happens once.',
              style: TextStyle(
                fontSize: 9.5,
                height: 1.3,
                color: Colors.white.withValues(alpha: 0.4),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _row(ProvisioningItem item) {
    final color = item.error ? _err : _accent;
    final trailing = item.error
        ? '!'
        : item.state == 'done'
            ? '✓'
            : item.pct != null
                ? '${item.pct}%'
                : '…';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Expanded(
              child: Text(
                item.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 11,
                  color: Colors.white.withValues(alpha: 0.8),
                ),
              ),
            ),
            const SizedBox(width: 8),
            Text(trailing, style: TextStyle(fontSize: 11, color: color)),
          ],
        ),
        const SizedBox(height: 4),
        ClipRRect(
          borderRadius: BorderRadius.circular(2),
          child: LinearProgressIndicator(
            minHeight: 3,
            value: item.state == 'done'
                ? 1.0
                : item.pct != null
                    ? item.pct! / 100.0
                    : null, // indeterminate
            backgroundColor: Colors.white.withValues(alpha: 0.08),
            valueColor: AlwaysStoppedAnimation(color),
          ),
        ),
      ],
    );
  }
}
