enum SpawnTaskStatus { spawned, polling, completed, failed, timeout }

class SpawnTask {
  final String taskId;
  final String label;
  SpawnTaskStatus status;
  final DateTime startedAt;
  DateTime? completedAt;
  String? resultPreview;
  double opacity;

  SpawnTask({
    required this.taskId,
    required this.label,
    required this.status,
    required this.startedAt,
    this.completedAt,
    this.resultPreview,
    this.opacity = 1.0,
  });

  factory SpawnTask.fromJson(Map<String, dynamic> json) {
    return SpawnTask(
      taskId: json['taskId'] as String? ?? '',
      label: json['label'] as String? ?? 'Background task',
      status: _parseStatus(json['status'] as String?),
      startedAt: json['startedAt'] is num
          ? DateTime.fromMillisecondsSinceEpoch((json['startedAt'] as num).toInt())
          : DateTime.now(),
      completedAt: json['completedAt'] is num
          ? DateTime.fromMillisecondsSinceEpoch((json['completedAt'] as num).toInt())
          : null,
      resultPreview: json['resultPreview'] as String?,
    );
  }

  bool get isTerminal =>
      status == SpawnTaskStatus.completed ||
      status == SpawnTaskStatus.failed ||
      status == SpawnTaskStatus.timeout;

  Duration get elapsed =>
      (completedAt ?? DateTime.now()).difference(startedAt);

  static SpawnTaskStatus _parseStatus(String? value) {
    switch (value) {
      case 'spawned':
        return SpawnTaskStatus.spawned;
      case 'polling':
        return SpawnTaskStatus.polling;
      case 'completed':
        return SpawnTaskStatus.completed;
      case 'failed':
        return SpawnTaskStatus.failed;
      case 'timeout':
        return SpawnTaskStatus.timeout;
      default:
        return SpawnTaskStatus.spawned;
    }
  }
}
