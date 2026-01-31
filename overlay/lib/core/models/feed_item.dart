enum FeedPriority { normal, high, urgent }

class FeedItem {
  final String id;
  final String text;
  final FeedPriority priority;
  final DateTime timestamp;
  double opacity;

  FeedItem({
    required this.id,
    required this.text,
    this.priority = FeedPriority.normal,
    DateTime? timestamp,
    this.opacity = 1.0,
  }) : timestamp = timestamp ?? DateTime.now();

  factory FeedItem.fromJson(Map<String, dynamic> json) {
    return FeedItem(
      id: json['id'] as String? ?? DateTime.now().microsecondsSinceEpoch.toString(),
      text: json['text'] as String? ?? '',
      priority: _parsePriority(json['priority'] as String?),
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

  Map<String, dynamic> toJson() => {
        'id': id,
        'text': text,
        'priority': priority.name,
        'timestamp': timestamp.toIso8601String(),
        'opacity': opacity,
      };
}
