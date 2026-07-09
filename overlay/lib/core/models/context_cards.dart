/// Deliberate-capture card payloads (sinain-core → overlay).
///
/// Three WS message types back the new HUD gestures:
///   `context_brief` — "Call AI on my last N minutes" → situation brief
///   `enrich_card`   — "Context from clipboard/screen" → a single `context`
///                     paragraph (no next-step suggestions by design)
///   `save_receipt`  — save lifecycle: saving → saved (+undo) → committed
library;

enum CardStatus { working, ready, error }

CardStatus _statusFrom(String? s) => switch (s) {
      'ready' => CardStatus.ready,
      'error' => CardStatus.error,
      _ => CardStatus.working,
    };

class BriefTimelineEntry {
  final String at;
  final String what;
  const BriefTimelineEntry({required this.at, required this.what});

  factory BriefTimelineEntry.fromJson(Map<String, dynamic> json) =>
      BriefTimelineEntry(
        at: json['at'] as String? ?? '',
        what: json['what'] as String? ?? '',
      );
}

class ContextBrief {
  final String requestId;
  final CardStatus status;
  final int minutes;
  final String coverage;
  final List<BriefTimelineEntry> timeline;
  final String goal;
  final List<String> problems;
  final List<String> entities;
  final bool partial;
  final int? latencyMs;
  final String? error;

  const ContextBrief({
    required this.requestId,
    required this.status,
    required this.minutes,
    required this.coverage,
    this.timeline = const [],
    this.goal = '',
    this.problems = const [],
    this.entities = const [],
    this.partial = false,
    this.latencyMs,
    this.error,
  });

  factory ContextBrief.fromJson(Map<String, dynamic> json) {
    final brief = json['brief'] as Map<String, dynamic>? ?? const {};
    return ContextBrief(
      requestId: json['requestId'] as String? ?? '',
      status: _statusFrom(json['status'] as String?),
      minutes: (json['minutes'] as num?)?.toInt() ?? 0,
      coverage: json['coverage'] as String? ?? '',
      timeline: (brief['timeline'] as List? ?? const [])
          .whereType<Map>()
          .map((m) => BriefTimelineEntry.fromJson(m.cast<String, dynamic>()))
          .toList(),
      goal: brief['goal'] as String? ?? '',
      problems:
          (brief['problems'] as List? ?? const []).map((e) => '$e').toList(),
      entities:
          (brief['entities'] as List? ?? const []).map((e) => '$e').toList(),
      partial: json['partial'] as bool? ?? false,
      latencyMs: (json['latencyMs'] as num?)?.toInt(),
      error: json['error'] as String?,
    );
  }
}

class EnrichCard {
  final String requestId;
  final CardStatus status;
  final String focus;
  final String context;
  final int? latencyMs;
  final String? error;

  const EnrichCard({
    required this.requestId,
    required this.status,
    required this.focus,
    this.context = '',
    this.latencyMs,
    this.error,
  });

  factory EnrichCard.fromJson(Map<String, dynamic> json) {
    final card = json['card'] as Map<String, dynamic>? ?? const {};
    return EnrichCard(
      requestId: json['requestId'] as String? ?? '',
      status: _statusFrom(json['status'] as String?),
      focus: json['focus'] as String? ?? '',
      context: card['context'] as String? ?? '',
      latencyMs: (json['latencyMs'] as num?)?.toInt(),
      error: json['error'] as String?,
    );
  }
}

enum SaveStatus { saving, saved, committed, undone, error }

class SaveReceipt {
  final String saveId;
  final SaveStatus status;
  final int minutes;
  final String coverage;
  final int? facts;
  final int? entities;
  final double? cost;
  final int? undoSeconds;
  final String? error;

  const SaveReceipt({
    required this.saveId,
    required this.status,
    required this.minutes,
    required this.coverage,
    this.facts,
    this.entities,
    this.cost,
    this.undoSeconds,
    this.error,
  });

  factory SaveReceipt.fromJson(Map<String, dynamic> json) => SaveReceipt(
        saveId: json['saveId'] as String? ?? '',
        status: switch (json['status'] as String?) {
          'saved' => SaveStatus.saved,
          'committed' => SaveStatus.committed,
          'undone' => SaveStatus.undone,
          'error' => SaveStatus.error,
          _ => SaveStatus.saving,
        },
        minutes: (json['minutes'] as num?)?.toInt() ?? 0,
        coverage: json['coverage'] as String? ?? '',
        facts: (json['facts'] as num?)?.toInt(),
        entities: (json['entities'] as num?)?.toInt(),
        cost: (json['cost'] as num?)?.toDouble(),
        undoSeconds: (json['undoSeconds'] as num?)?.toInt(),
        error: json['error'] as String?,
      );
}

enum VoiceStatus { starting, live, ended, error }

enum VoiceMode { webview, bridge, meet }

/// "Call sinain" session state (WS `voice_session`).
class VoiceSession {
  final VoiceStatus status;
  final VoiceMode mode;
  final int minutes;
  final String coverage;
  final String? message;
  final String? error;

  const VoiceSession({
    required this.status,
    required this.mode,
    required this.minutes,
    required this.coverage,
    this.message,
    this.error,
  });

  factory VoiceSession.fromJson(Map<String, dynamic> json) => VoiceSession(
        status: switch (json['status'] as String?) {
          'live' => VoiceStatus.live,
          'ended' => VoiceStatus.ended,
          'error' => VoiceStatus.error,
          _ => VoiceStatus.starting,
        },
        mode: switch (json['mode'] as String?) {
          'meet' => VoiceMode.meet,
          'bridge' => VoiceMode.bridge,
          _ => VoiceMode.webview,
        },
        minutes: (json['minutes'] as num?)?.toInt() ?? 0,
        coverage: json['coverage'] as String? ?? '',
        message: json['message'] as String?,
        error: json['error'] as String?,
      );

  bool get isActive =>
      status == VoiceStatus.starting || status == VoiceStatus.live;
}

/// One option of the save/summon range chooser (GET /window/coverage).
class RangeOption {
  final int minutes;
  final String covers;
  final int availableMinutes;

  const RangeOption({
    required this.minutes,
    required this.covers,
    required this.availableMinutes,
  });

  factory RangeOption.fromJson(Map<String, dynamic> json) => RangeOption(
        minutes: (json['minutes'] as num?)?.toInt() ?? 0,
        covers: json['covers'] as String? ?? '',
        availableMinutes: (json['availableMinutes'] as num?)?.toInt() ?? 0,
      );
}
