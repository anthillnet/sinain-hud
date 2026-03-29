enum FeedPriority { normal, high, urgent }

enum FeedChannel { stream, agent }

enum FeedSender { agent, user, spawn }

class FeedItem {
  final String id;
  final String text;
  final FeedPriority priority;
  final FeedChannel channel;
  final FeedSender sender;
  final DateTime timestamp;
  double opacity;

  FeedItem({
    required this.id,
    required this.text,
    this.priority = FeedPriority.normal,
    this.channel = FeedChannel.stream,
    this.sender = FeedSender.agent,
    DateTime? timestamp,
    this.opacity = 1.0,
  }) : timestamp = timestamp ?? DateTime.now();

  bool get isUser => sender == FeedSender.user;
  bool get isSpawn => sender == FeedSender.spawn;
  /// True if this is a user-originated message (command or spawn)
  bool get isUserOriginated => sender == FeedSender.user || sender == FeedSender.spawn;

  factory FeedItem.fromJson(Map<String, dynamic> json) {
    return FeedItem(
      id: json['id'] as String? ?? DateTime.now().microsecondsSinceEpoch.toString(),
      text: json['text'] as String? ?? '',
      priority: _parsePriority(json['priority'] as String?),
      channel: _parseChannel(json['channel'] as String?),
      sender: _parseSender(json['sender'] as String?),
      timestamp: json['timestamp'] != null
          ? DateTime.tryParse(json['timestamp'] as String) ?? DateTime.now()
          : DateTime.now(),
      opacity: (json['opacity'] as num?)?.toDouble() ?? 1.0,
    );
  }

  static FeedPriority _parsePriority(String? value) {
    switch (value) {
      case 'high':
        return FeedPriority.high;
      case 'urgent':
        return FeedPriority.urgent;
      default:
        return FeedPriority.normal;
    }
  }

  static FeedChannel _parseChannel(String? value) {
    switch (value) {
      case 'agent':
        return FeedChannel.agent;
      default:
        return FeedChannel.stream;
    }
  }

  static FeedSender _parseSender(String? value) {
    switch (value) {
      case 'user':
        return FeedSender.user;
      case 'spawn':
        return FeedSender.spawn;
      default:
        return FeedSender.agent;
    }
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'text': text,
        'priority': priority.name,
        'timestamp': timestamp.toIso8601String(),
        'opacity': opacity,
      };
}
