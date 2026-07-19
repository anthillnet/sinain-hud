class AgentSession {
  final String sessionId;
  final String? threadId;
  final bool candidate;
  final String source;
  final String name;
  final String? cwd;
  final String? model;
  final String? branch;
  final String state;
  final String? toolLine;
  final DateTime startedAt;
  final DateTime lastEventAt;
  final DateTime? endedAt;
  final String? summary;
  final Map<String, dynamic> term;

  const AgentSession({
    required this.sessionId,
    required this.source,
    required this.name,
    required this.state,
    required this.startedAt,
    required this.lastEventAt,
    this.threadId,
    this.candidate = false,
    this.cwd,
    this.model,
    this.branch,
    this.toolLine,
    this.endedAt,
    this.summary,
    this.term = const {},
  });

  factory AgentSession.fromJson(Map<String, dynamic> json) {
    final now = DateTime.now();
    final startedAt = _dateFromEpoch(json['startedAt']) ?? now;
    return AgentSession(
      sessionId: json['sessionId'] as String? ?? '',
      threadId: json['threadId'] as String?,
      candidate: json['candidate'] as bool? ?? false,
      source: json['source'] as String? ?? '',
      name: json['name'] as String? ?? 'agent',
      cwd: json['cwd'] as String?,
      model: json['model'] as String?,
      branch: json['branch'] as String?,
      state: json['state'] as String? ?? 'done',
      toolLine: json['toolLine'] as String?,
      startedAt: startedAt,
      lastEventAt: _dateFromEpoch(json['lastEventAt']) ?? startedAt,
      endedAt: _dateFromEpoch(json['endedAt']),
      summary: json['summary'] as String?,
      term: json['term'] is Map
          ? Map<String, dynamic>.from(json['term'] as Map)
          : const {},
    );
  }

  Duration get elapsed => (endedAt ?? DateTime.now()).difference(startedAt);

  static DateTime? _dateFromEpoch(dynamic value) =>
      value is num ? DateTime.fromMillisecondsSinceEpoch(value.toInt()) : null;
}

class AgentApprovalRequest {
  final String id;
  final String sessionId;
  final String source;
  final String title;
  final String command;
  final String? cwd;
  final DateTime createdAt;

  const AgentApprovalRequest({
    required this.id,
    required this.sessionId,
    required this.source,
    required this.title,
    required this.command,
    required this.createdAt,
    this.cwd,
  });

  factory AgentApprovalRequest.fromJson(Map<String, dynamic> json) {
    return AgentApprovalRequest(
      id: json['id'] as String? ?? '',
      sessionId: json['sessionId'] as String? ?? '',
      source: json['source'] as String? ?? '',
      title: json['title'] as String? ?? 'Agent approval requested',
      command: json['command'] as String? ?? '',
      cwd: json['cwd'] as String?,
      createdAt:
          AgentSession._dateFromEpoch(json['createdAt']) ?? DateTime.now(),
    );
  }

  Duration get elapsed => DateTime.now().difference(createdAt);
}
