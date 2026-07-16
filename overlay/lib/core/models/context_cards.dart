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

  /// "user_save" | "offered_save" — who initiated (absent on old cores).
  final String? provenance;
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
    this.provenance,
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
        provenance: json['provenance'] as String?,
        error: json['error'] as String?,
      );
}

/// Proactive breakpoint save offer (WS `save_offer`, DESIGN-SAVE-OFFER.md):
/// "Save these 47 min? IntelliJ, Chrome". Sinain proposes, the user disposes.
class SaveOffer {
  final String offerId;
  final int minutes;
  final List<String> apps;
  final String coverage;
  final String threadId;

  /// "mostly: …" context line — present only when the engine is confident.
  final String? threadLabel;

  /// Honest idle tail — named on the card, never hidden.
  final int? idleTailMinutes;
  final int endedTs;
  final int expirySeconds;

  const SaveOffer({
    required this.offerId,
    required this.minutes,
    required this.apps,
    required this.coverage,
    required this.threadId,
    this.threadLabel,
    this.idleTailMinutes,
    required this.endedTs,
    required this.expirySeconds,
  });

  factory SaveOffer.fromJson(Map<String, dynamic> json) => SaveOffer(
        offerId: json['offerId'] as String? ?? '',
        minutes: (json['minutes'] as num?)?.toInt() ?? 0,
        apps: (json['apps'] as List? ?? const []).map((e) => '$e').toList(),
        coverage: json['coverage'] as String? ?? '',
        threadId: json['threadId'] as String? ?? '',
        threadLabel: json['threadLabel'] as String?,
        idleTailMinutes: (json['idleTailMinutes'] as num?)?.toInt(),
        endedTs: (json['endedTs'] as num?)?.toInt() ?? 0,
        expirySeconds: (json['expirySeconds'] as num?)?.toInt() ?? 45,
      );
}

/// Session Sense (WS `session_nudge`, DESIGN-SESSION-SENSE.md): the live
/// workflow nudge — "Looks like: applying for a job — track from 11:02?".
/// Credit-led card: the retroactive-credit sliver is visible before the tap.
class SessionNudge {
  final String nudgeId;

  /// Confidence grade: `personal` ("Back on: …"), `stock` ("Looks like: …"),
  /// `unlabeled` ("Session in progress" — a statement, never a hedge).
  final String grade;

  /// Absent when unlabeled (medium confidence or category floor).
  final String? label;
  final String threadId;

  /// Retroactive credit start — "11:02 — credited from here".
  final int candidateStartTs;
  final int elapsedMinutes;
  final List<String> apps;

  /// "Wrong?" picker rows (classifier's next candidates; may be empty).
  final List<String> alternates;

  /// Help-forward variant A (§8): goal + next steps composed before consent
  /// on the burst lane. Empty when the lane was unavailable or slow — the
  /// card renders bare, never waits.
  final String goal;
  final List<String> steps;

  /// Bookmark return (§9): "Resume this session?" — the ⚑ marks the user's
  /// own promise, not the classifier's guess.
  final bool resume;

  /// "bookmarked yesterday · 2 sessions · 1h 19m so far" (resume only).
  final String? resumeMeta;
  final int expirySeconds;

  const SessionNudge({
    required this.nudgeId,
    required this.grade,
    this.label,
    required this.threadId,
    required this.candidateStartTs,
    required this.elapsedMinutes,
    required this.apps,
    required this.alternates,
    this.goal = '',
    this.steps = const [],
    this.resume = false,
    this.resumeMeta,
    required this.expirySeconds,
  });

  factory SessionNudge.fromJson(Map<String, dynamic> json) => SessionNudge(
        nudgeId: json['nudgeId'] as String? ?? '',
        grade: json['grade'] as String? ?? 'unlabeled',
        label: json['label'] as String?,
        threadId: json['threadId'] as String? ?? '',
        candidateStartTs: (json['candidateStartTs'] as num?)?.toInt() ?? 0,
        elapsedMinutes: (json['elapsedMinutes'] as num?)?.toInt() ?? 0,
        apps: (json['apps'] as List? ?? const []).map((e) => '$e').toList(),
        alternates:
            (json['alternates'] as List? ?? const []).map((e) => '$e').toList(),
        goal: json['goal'] as String? ?? '',
        steps: (json['steps'] as List? ?? const []).map((e) => '$e').toList(),
        resume: json['resume'] as bool? ?? false,
        resumeMeta: json['resumeMeta'] as String?,
        expirySeconds: (json['expirySeconds'] as num?)?.toInt() ?? 45,
      );
}

/// Help-forward assist (WS `session_assist`, §8 C): goal + next steps
/// composed on the track tap — help offered on a fact, not a guess.
class SessionAssist {
  final String sessionId;
  final String status; // working | ready | error
  final String goal;
  final List<String> steps;
  final String? error;

  const SessionAssist({
    required this.sessionId,
    required this.status,
    required this.goal,
    required this.steps,
    this.error,
  });

  bool get ready => status == 'ready';

  factory SessionAssist.fromJson(Map<String, dynamic> json) => SessionAssist(
        sessionId: json['sessionId'] as String? ?? '',
        status: json['status'] as String? ?? 'error',
        goal: json['goal'] as String? ?? '',
        steps: (json['steps'] as List? ?? const []).map((e) => '$e').toList(),
        error: json['error'] as String?,
      );
}

/// The sessions list: what's being tracked right now (possibly several in
/// parallel — warm first) + the ⚑ shelf.
class SessionList {
  final List<SessionChipState> sessions;
  final List<SessionBookmark> bookmarks;
  const SessionList({required this.sessions, required this.bookmarks});
}

/// A bookmarked session thread (§9) — one shelf row.
class SessionBookmark {
  final String threadId;
  final String label;
  final int sessions;
  final int totalMs;
  final int lastTs;

  /// Wiki path for ↗ share (existing KG share mechanic lives on the entity
  /// page); null when the KG doesn't know the thread by name yet.
  final String? kgPath;

  const SessionBookmark({
    required this.threadId,
    required this.label,
    required this.sessions,
    required this.totalMs,
    required this.lastTs,
    this.kgPath,
  });

  String get meta {
    final m = (totalMs / 60000).round();
    final dur = m >= 60 ? '${m ~/ 60}h ${(m % 60).toString().padLeft(2, '0')}m' : '${m}m';
    final ago = DateTime.now().millisecondsSinceEpoch - lastTs;
    final days = ago ~/ 86400000;
    final when = days <= 0 ? 'today' : days == 1 ? 'yesterday' : '${days}d ago';
    return sessions > 0 ? '$sessions session${sessions == 1 ? '' : 's'} · $dur · $when' : when;
  }

  factory SessionBookmark.fromJson(Map<String, dynamic> json) =>
      SessionBookmark(
        threadId: json['threadId'] as String? ?? '',
        label: json['label'] as String? ?? 'session',
        sessions: (json['sessions'] as num?)?.toInt() ?? 0,
        totalMs: (json['totalMs'] as num?)?.toInt() ?? 0,
        lastTs: (json['lastTs'] as num?)?.toInt() ?? 0,
        kgPath: json['kgPath'] as String?,
      );
}

/// Running-session chip state (WS `session_chip`): label · elapsed · paused.
/// `ended` clears the chip.
class SessionChipState {
  final String sessionId;
  final String status; // running | paused | ended
  final String label;
  final int startedTs;
  final int activeMs;

  const SessionChipState({
    required this.sessionId,
    required this.status,
    required this.label,
    required this.startedTs,
    required this.activeMs,
  });

  bool get ended => status == 'ended';
  bool get paused => status == 'paused';

  factory SessionChipState.fromJson(Map<String, dynamic> json) =>
      SessionChipState(
        sessionId: json['sessionId'] as String? ?? '',
        status: json['status'] as String? ?? 'ended',
        label: json['label'] as String? ?? 'session',
        startedTs: (json['startedTs'] as num?)?.toInt() ?? 0,
        activeMs: (json['activeMs'] as num?)?.toInt() ?? 0,
      );
}

/// The symmetric "End workout?" prompt (WS `session_wrap`): ignorable; the
/// grace period auto-wraps server-side, and the countdown line says so.
class SessionWrap {
  final String sessionId;
  final String label;
  final int activeMinutes;
  final int quietMinutes;
  final int graceMinutes;

  const SessionWrap({
    required this.sessionId,
    required this.label,
    required this.activeMinutes,
    required this.quietMinutes,
    required this.graceMinutes,
  });

  factory SessionWrap.fromJson(Map<String, dynamic> json) => SessionWrap(
        sessionId: json['sessionId'] as String? ?? '',
        label: json['label'] as String? ?? 'session',
        activeMinutes: (json['activeMinutes'] as num?)?.toInt() ?? 0,
        quietMinutes: (json['quietMinutes'] as num?)?.toInt() ?? 0,
        graceMinutes: (json['graceMinutes'] as num?)?.toInt() ?? 10,
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
