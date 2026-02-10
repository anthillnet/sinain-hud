import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/models/spawn_task.dart';
import '../../core/services/websocket_service.dart';

class TasksView extends StatefulWidget {
  const TasksView({super.key});

  @override
  State<TasksView> createState() => _TasksViewState();
}

class _TasksViewState extends State<TasksView> {
  static const _taskTtlSeconds = 300; // 5 minutes — keep completed tasks visible
  final List<SpawnTask> _tasks = [];
  StreamSubscription<SpawnTask>? _taskSub;
  Timer? _tickTimer;
  Timer? _fadeTimer;
  int _dotCycle = 0; // 0, 1, 2 for animated ·  ··  ···

  @override
  void initState() {
    super.initState();
    // 1-second tick for elapsed time + dot animation
    _tickTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      final hasActive = _tasks.any((t) => !t.isTerminal);
      if (hasActive) {
        setState(() => _dotCycle = (_dotCycle + 1) % 3);
      }
    });
    // 30-second sweep for pruning completed tasks
    _fadeTimer = Timer.periodic(const Duration(seconds: 30), (_) => _pruneOld());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final ws = context.read<WebSocketService>();
    _taskSub ??= ws.spawnTaskStream.listen(_onTask);
  }

  void _onTask(SpawnTask incoming) {
    setState(() {
      final idx = _tasks.indexWhere((t) => t.taskId == incoming.taskId);
      if (idx >= 0) {
        // Upsert — update mutable fields
        final existing = _tasks[idx];
        existing.status = incoming.status;
        existing.completedAt = incoming.completedAt;
        existing.resultPreview = incoming.resultPreview;
      } else {
        _tasks.add(incoming);
      }
    });
  }

  void _pruneOld() {
    if (!mounted) return;
    final now = DateTime.now();
    setState(() {
      _tasks.removeWhere((t) {
        if (!t.isTerminal) return false;
        final age = now.difference(t.completedAt ?? now).inSeconds;
        return age > _taskTtlSeconds;
      });
    });
  }

  String _statusIndicator(SpawnTask task) {
    if (task.status == SpawnTaskStatus.spawned ||
        task.status == SpawnTaskStatus.polling) {
      const dots = ['·', '··', '···'];
      return dots[_dotCycle];
    }
    if (task.status == SpawnTaskStatus.completed) return 'OK';
    return 'ERR'; // failed or timeout
  }

  Color _statusColor(SpawnTask task) {
    if (task.status == SpawnTaskStatus.spawned ||
        task.status == SpawnTaskStatus.polling) {
      return const Color(0xFF88CCFF);
    }
    if (task.status == SpawnTaskStatus.completed) return const Color(0xFF00FF88);
    return const Color(0xFFFF3344);
  }

  String _formatElapsed(Duration d) {
    final m = d.inMinutes.toString().padLeft(2, '0');
    final s = (d.inSeconds % 60).toString().padLeft(2, '0');
    return '$m:$s';
  }

  /// Gradual fade: terminal tasks start at full opacity and fade to 0.3
  /// over the last 60 seconds of their TTL.
  double _terminalOpacity(SpawnTask task) {
    if (!task.isTerminal) return 1.0;
    final age = DateTime.now()
        .difference(task.completedAt ?? DateTime.now())
        .inSeconds;
    // Full opacity for first (TTL - 60) seconds, then linear fade
    const fadeStart = _taskTtlSeconds - 60;
    if (age <= fadeStart) return 1.0;
    final t = (age - fadeStart) / 60.0; // 0.0 → 1.0 over 60 seconds
    return (1.0 - t * 0.7).clamp(0.3, 1.0);
  }

  @override
  void dispose() {
    _taskSub?.cancel();
    _tickTimer?.cancel();
    _fadeTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_tasks.isEmpty) {
      return Center(
        child: Text(
          'no active tasks',
          style: TextStyle(
            fontFamily: 'JetBrainsMono',
            fontSize: 11,
            color: Colors.white.withValues(alpha: 0.2),
          ),
        ),
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      itemCount: _tasks.length,
      itemBuilder: (context, index) {
        final task = _tasks[index];
        final sColor = _statusColor(task);

        return Opacity(
          opacity: _terminalOpacity(task),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                // Main row: status | label | elapsed
                Row(
                  children: [
                    // Status indicator (fixed width for alignment)
                    SizedBox(
                      width: 28,
                      child: Text(
                        _statusIndicator(task),
                        style: TextStyle(
                          fontFamily: 'JetBrainsMono',
                          fontSize: 11,
                          color: sColor,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                    const SizedBox(width: 4),
                    // Label
                    Expanded(
                      child: Text(
                        task.label.length > 35
                            ? '${task.label.substring(0, 35)}…'
                            : task.label,
                        style: const TextStyle(
                          fontFamily: 'JetBrainsMono',
                          fontSize: 12,
                          color: Colors.white,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    const SizedBox(width: 8),
                    // Elapsed time
                    Text(
                      _formatElapsed(task.elapsed),
                      style: TextStyle(
                        fontFamily: 'JetBrainsMono',
                        fontSize: 10,
                        color: Colors.white.withValues(alpha: 0.4),
                      ),
                    ),
                  ],
                ),
                // Result preview (terminal tasks)
                if (task.isTerminal)
                  Padding(
                    padding: const EdgeInsets.only(left: 32, top: 1),
                    child: Text(
                      task.resultPreview ??
                          (task.status == SpawnTaskStatus.failed
                              ? 'task failed'
                              : task.status == SpawnTaskStatus.timeout
                                  ? 'timed out'
                                  : 'done'),
                      style: TextStyle(
                        fontFamily: 'JetBrainsMono',
                        fontSize: 10,
                        color: task.status == SpawnTaskStatus.completed
                            ? Colors.white.withValues(alpha: 0.4)
                            : const Color(0xFFFF3344).withValues(alpha: 0.5),
                      ),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }
}
