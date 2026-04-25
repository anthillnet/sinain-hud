enum SpawnTaskStatus { spawned, polling, completed, failed, timeout, awaitingInput, awaitingPermission }

class SpawnTask {
  final String taskId;
  final String label;
  SpawnTaskStatus status;
  final DateTime startedAt;
  DateTime? completedAt;
  String? resultPreview;
  double opacity;
  /// Question the spawn is asking the user (status=awaitingInput)
  String? question;
  /// Tool permission request (status=awaitingPermission)
  SpawnPermission? permission;

  SpawnTask({
    required this.taskId,
    required this.label,
    required this.status,
    required this.startedAt,
    this.completedAt,
    this.resultPreview,
    this.opacity = 1.0,
    this.question,
    this.permission,
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
      question: json['question'] as String?,
      permission: json['permission'] is Map
          ? SpawnPermission.fromJson(json['permission'] as Map<String, dynamic>)
          : null,
    );
  }

  bool get isTerminal =>
      status == SpawnTaskStatus.completed ||
      status == SpawnTaskStatus.failed ||
      status == SpawnTaskStatus.timeout;

  bool get needsInput =>
      status == SpawnTaskStatus.awaitingInput ||
      status == SpawnTaskStatus.awaitingPermission;

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
      case 'awaiting_input':
        return SpawnTaskStatus.awaitingInput;
      case 'awaiting_permission':
        return SpawnTaskStatus.awaitingPermission;
      default:
        return SpawnTaskStatus.spawned;
    }
  }
}

class SpawnPermission {
  final String tool;
  final Map<String, dynamic> input;

  SpawnPermission({required this.tool, required this.input});

  factory SpawnPermission.fromJson(Map<String, dynamic> json) {
    return SpawnPermission(
      tool: json['tool'] as String? ?? 'unknown',
      input: json['input'] is Map ? Map<String, dynamic>.from(json['input'] as Map) : {},
    );
  }

  String get preview {
    if (tool == 'Bash') return 'Bash: ${input['command'] ?? ''}';
    if (tool == 'Edit') return 'Edit: ${input['file_path'] ?? ''}';
    if (tool == 'Write') return 'Write: ${input['file_path'] ?? ''}';
    // Length-guarded preview for unknown tools — input.toString() can be
    // short ("{}" for empty) and an unguarded substring(0, 80) crashed
    // the whole task card with a RangeError. Ellipsis matches the truncation
    // style used elsewhere (e.g., task.label preview in tasks_view.dart).
    final s = input.toString();
    final truncated = s.length > 80 ? '${s.substring(0, 80)}…' : s;
    return '$tool: $truncated';
  }
}
