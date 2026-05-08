import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/models/spawn_task.dart';
import '../../core/services/websocket_service.dart';
import '../hud_tooltip.dart';

/// Persistent banner displayed above the chat text input whenever one or more
/// spawn tasks are awaiting a permission decision. Shows the oldest pending
/// task first with an (N of M) counter when multiple are queued. Approve/Deny
/// dispatch reuses the same [spawn_permission_reply] protocol as TasksView so
/// the two surfaces stay in sync without additional state wiring.
///
/// Hidden (zero height, not rendered) when no permission-awaiting tasks exist.
class PermissionBanner extends StatefulWidget {
  const PermissionBanner({super.key});

  @override
  State<PermissionBanner> createState() => _PermissionBannerState();
}

class _PermissionBannerState extends State<PermissionBanner> {
  // Local ordered list of permission-awaiting tasks.
  // Oldest first (insertion order) — natural queue model.
  final List<SpawnTask> _pending = [];
  StreamSubscription<SpawnTask>? _taskSub;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final ws = context.read<WebSocketService>();
    if (_taskSub == null) {
      // Seed from snapshot so tasks that arrived before this widget was built
      // are not lost (mirrors the pattern in TasksView.didChangeDependencies).
      for (final task in ws.spawnTasks.values) {
        if (task.status == SpawnTaskStatus.awaitingPermission &&
            !_pending.any((t) => t.taskId == task.taskId)) {
          _pending.add(task);
        }
      }
      // Sort oldest first by startedAt after seeding.
      _pending.sort((a, b) => a.startedAt.compareTo(b.startedAt));

      _taskSub = ws.spawnTaskStream.listen(_onTask);
    }
  }

  void _onTask(SpawnTask incoming) {
    if (!mounted) return;
    setState(() {
      if (incoming.status == SpawnTaskStatus.awaitingPermission) {
        // Upsert: keep single entry per taskId, preserve order.
        final idx = _pending.indexWhere((t) => t.taskId == incoming.taskId);
        if (idx < 0) {
          _pending.add(incoming);
        } else {
          _pending[idx] = incoming;
        }
      } else {
        // Task left awaiting_permission state (resolved elsewhere — e.g.
        // Tasks tab, timeout). Remove from our list.
        _pending.removeWhere((t) => t.taskId == incoming.taskId);
      }
    });
  }

  void _sendDecision(String taskId, String decision) {
    final ws = context.read<WebSocketService>();
    ws.send({'type': 'spawn_permission_reply', 'taskId': taskId, 'decision': decision});
    setState(() {
      _pending.removeWhere((t) => t.taskId == taskId);
    });
  }

  @override
  void dispose() {
    _taskSub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_pending.isEmpty) return const SizedBox.shrink();

    final task = _pending.first; // show oldest
    final total = _pending.length;
    final hasPermission = task.permission != null;
    final previewText = hasPermission
        ? task.permission!.preview
        : task.label;

    // Truncate preview to a single line (~60 chars feels right at banner size).
    final truncated = previewText.length > 60
        ? '${previewText.substring(0, 60)}…'
        : previewText;

    return Container(
      // ~48px: comfortable touch target, single-line layout.
      height: 48,
      margin: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        // Warm amber tint — "needs attention" without being alarming.
        color: const Color(0xFFFF8800).withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(
          color: const Color(0xFFFF8800).withValues(alpha: 0.35),
          width: 1,
        ),
      ),
      child: Row(
        children: [
          // Warning icon
          Icon(
            Icons.warning_amber_rounded,
            size: 14,
            color: const Color(0xFFFF8800).withValues(alpha: 0.85),
          ),
          const SizedBox(width: 6),
          // Preview text — expands to fill available space.
          Expanded(
            child: Text(
              truncated,
              style: const TextStyle(
                fontFamily: 'JetBrainsMono',
                fontSize: 10,
                color: Color(0xFFFF8800),
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          // Counter badge when multiple tasks are pending.
          if (total > 1) ...[
            const SizedBox(width: 6),
            Text(
              '($total)',
              style: TextStyle(
                fontFamily: 'JetBrainsMono',
                fontSize: 9,
                color: const Color(0xFFFF8800).withValues(alpha: 0.6),
              ),
            ),
          ],
          const SizedBox(width: 8),
          // Allow button
          HudTooltip(
            message: 'Allow this action',
            child: GestureDetector(
              onTap: () => _sendDecision(task.taskId, 'allow'),
              child: MouseRegion(
                cursor: SystemMouseCursors.click,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: const Color(0xFF00FF88).withValues(alpha: 0.18),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: const Text(
                    'Allow',
                    style: TextStyle(
                      fontFamily: 'JetBrainsMono',
                      fontSize: 9,
                      color: Color(0xFF00FF88),
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(width: 4),
          // YOLO button
          HudTooltip(
            message: 'Allow this + auto-allow all following permissions in this agent session',
            child: GestureDetector(
              onTap: () => _sendDecision(task.taskId, 'yolo'),
              child: MouseRegion(
                cursor: SystemMouseCursors.click,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFFAA00).withValues(alpha: 0.18),
                    borderRadius: BorderRadius.circular(4),
                    border: Border.all(
                      color: const Color(0xFFFFAA00).withValues(alpha: 0.45),
                      width: 1,
                    ),
                  ),
                  child: const Text(
                    'YOLO',
                    style: TextStyle(
                      fontFamily: 'JetBrainsMono',
                      fontSize: 9,
                      color: Color(0xFFFFAA00),
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(width: 4),
          // Deny button
          HudTooltip(
            message: 'Deny this action',
            child: GestureDetector(
              onTap: () => _sendDecision(task.taskId, 'deny'),
              child: MouseRegion(
                cursor: SystemMouseCursors.click,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFF3344).withValues(alpha: 0.18),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: const Text(
                    'Deny',
                    style: TextStyle(
                      fontFamily: 'JetBrainsMono',
                      fontSize: 9,
                      color: Color(0xFFFF3344),
                      fontWeight: FontWeight.bold,
                    ),
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
