/// Work-State Model (WSM/Athium) cockpit payload — mirrors the `{ type:
/// "workstate", view }` message broadcast by sinain-core's WorkStateEngine.
/// See docs/DESIGN-WORK-STATE-MODEL.md (§9 thread bank, §6 P1 cockpit).
///
/// Honesty rule (binding): the cockpit renders qualitative tiers, never the raw
/// scores carried here. `needScore`/`stuckness`/etc. drive ordering, glyphs, and
/// warmth — they are not shown as numbers.
library;

/// Athium need tier — drives the row glyph + ordering (never a number on screen).
enum NeedTier { now, soon, later }

/// A within-surface region-thread (the existing `regionId` layer), nested under
/// the active project-thread (design §9: project → regions). `warmth` (1 = just
/// seen → 0 cooled) color-cools the nested dot, mirroring the project warmth cue.
class RegionThread {
  final String id;
  final String label;
  final double warmth;

  const RegionThread({required this.id, required this.label, this.warmth = 0.5});

  factory RegionThread.fromJson(Map<String, dynamic> j) => RegionThread(
        id: j['id'] as String? ?? '',
        label: j['label'] as String? ?? '',
        warmth: (j['warmth'] as num?)?.toDouble() ?? 0.5,
      );
}

class ThreadCard {
  final String topicId;
  final String label;
  final String activity; // coarse, app-level
  final bool isActive;
  final String? kgContext; // KG sub-focus enrichment (null = unrecognized)
  final double needScore;
  final double staleness;
  final double temperature; // 1 = just attended, → 0 cooled
  final double assistValue;
  final double difficulty;
  final double stuckness; // display-only annotation, never a number on screen
  final int ageMs;
  final int attendCount;
  final String action; // silent | hold | offer-at-breakpoint | offer-now
  final List<double> trajectory; // assist-value history (sparkline)
  final List<String> why;
  final List<RegionThread> regions; // within-surface region-threads (active only)

  const ThreadCard({
    required this.topicId,
    required this.label,
    this.activity = 'working',
    this.isActive = false,
    this.kgContext,
    this.needScore = 0,
    this.staleness = 0,
    this.temperature = 0.5,
    this.assistValue = 0,
    this.difficulty = 0,
    this.stuckness = 0,
    this.ageMs = 0,
    this.attendCount = 0,
    this.action = 'silent',
    this.trajectory = const [],
    this.why = const [],
    this.regions = const [],
  });

  factory ThreadCard.fromJson(Map<String, dynamic> j) => ThreadCard(
        topicId: j['topicId'] as String? ?? '',
        label: j['label'] as String? ?? '',
        activity: j['activity'] as String? ?? 'working',
        isActive: j['isActive'] as bool? ?? false,
        kgContext: j['kgContext'] as String?,
        needScore: (j['needScore'] as num?)?.toDouble() ?? 0,
        staleness: (j['staleness'] as num?)?.toDouble() ?? 0,
        temperature: (j['temperature'] as num?)?.toDouble() ?? 0.5,
        assistValue: (j['assistValue'] as num?)?.toDouble() ?? 0,
        difficulty: (j['difficulty'] as num?)?.toDouble() ?? 0,
        stuckness: (j['stuckness'] as num?)?.toDouble() ?? 0,
        ageMs: (j['ageMs'] as num?)?.toInt() ?? 0,
        attendCount: (j['attendCount'] as num?)?.toInt() ?? 0,
        action: j['action'] as String? ?? 'silent',
        trajectory: (j['trajectory'] as List?)
                ?.map((e) => (e as num).toDouble())
                .toList() ??
            const [],
        why: (j['why'] as List?)?.map((e) => e.toString()).toList() ?? const [],
        regions: (j['regions'] as List?)
                ?.whereType<Map>()
                .map((m) => RegionThread.fromJson(m.cast<String, dynamic>()))
                .toList() ??
            const [],
      );

  /// Qualitative need tier (the only "need" the UI is allowed to show).
  NeedTier get tier {
    if (needScore >= 0.6 || (difficulty >= 0.5 && staleness >= 0.8)) return NeedTier.now;
    if (needScore >= 0.3) return NeedTier.soon;
    return NeedTier.later;
  }

  /// At-risk: cold past its cadence AND left effortful — the resume-hook case.
  bool get atRisk => !isActive && staleness >= 0.8 && difficulty >= 0.35;

  /// Checkable evidence (never affect): prefer the policy reason, else a fact.
  /// Never claims "errors" from the difficulty score alone — an error claim
  /// needs captured evidence, which arrives via the policy `why` strings.
  String get evidence {
    final r = why.where((w) => !w.startsWith('⚠')).toList();
    if (r.isNotEmpty) return r.first;
    if (difficulty >= 0.45) return 'historically effortful';
    if (attendCount > 1) return 'seen $attendCount×';
    return activity;
  }

  /// Human age ("5m" / "8h" / "1d").
  String get ageLabel {
    const h = 3600000, d = 86400000;
    if (ageMs < h) return '${(ageMs / 60000).round()}m';
    if (ageMs < d) return '${(ageMs / h).round()}h';
    return '${(ageMs / d).round()}d';
  }
}

/// One predicted next step (closed vocab → top-k chips). See ResumeCard.
class NextAction {
  final String action;
  final String label;
  const NextAction({required this.action, required this.label});
  factory NextAction.fromJson(Map<String, dynamic> j) =>
      NextAction(action: j['action'] as String? ?? '', label: j['label'] as String? ?? '');
}

/// The Calibrated Resume Card (P5) — a re-entry instrument, not a summary.
/// Predictions choose timing/shape; every surfaced claim carries evidence.
/// `loudness` (from continuation_probability) is INTERNAL — never shown.
class ResumeCard {
  final String threadId;
  final String label;
  final String brief; // resume_brief, softened by reliability
  final String reliability; // low | medium | good
  final String reentryTier; // low | medium | high
  final List<String> drivers; // evidence chips (why shown)
  final List<String> reducers;
  final String focusLabel; // estimated_focus_time band label
  final String focusDisplay; // e.g. "~15–25 min"
  final List<NextAction> nextActions;
  final String? changedWhileAway;
  final String loudness; // low | quiet | compact | full

  const ResumeCard({
    required this.threadId,
    required this.label,
    required this.brief,
    this.reliability = 'medium',
    this.reentryTier = 'medium',
    this.drivers = const [],
    this.reducers = const [],
    this.focusLabel = '',
    this.focusDisplay = '',
    this.nextActions = const [],
    this.changedWhileAway,
    this.loudness = 'compact',
  });

  factory ResumeCard.fromJson(Map<String, dynamic> j) {
    final band = (j['focusBand'] as Map?)?.cast<String, dynamic>() ?? const {};
    return ResumeCard(
      threadId: j['threadId'] as String? ?? '',
      label: j['label'] as String? ?? '',
      brief: j['brief'] as String? ?? '',
      reliability: j['reliability'] as String? ?? 'medium',
      reentryTier: j['reentryTier'] as String? ?? 'medium',
      drivers: (j['drivers'] as List?)?.map((e) => e.toString()).toList() ?? const [],
      reducers: (j['reducers'] as List?)?.map((e) => e.toString()).toList() ?? const [],
      focusLabel: band['label'] as String? ?? '',
      focusDisplay: band['display'] as String? ?? '',
      nextActions: (j['nextActions'] as List?)
              ?.whereType<Map>()
              .map((m) => NextAction.fromJson(m.cast<String, dynamic>()))
              .toList() ??
          const [],
      changedWhileAway: j['changedWhileAway'] as String?,
      loudness: j['loudness'] as String? ?? 'compact',
    );
  }
}

class WorkStateView {
  final String? activeThreadId;
  final String activeAction; // active thread's Athium action
  final List<ThreadCard> board; // ranked by need, descending
  final String? resumeThreadId; // set on return-to-cooled-thread (§9 marker)
  final ResumeCard? resumeCard; // calibrated card for the armed resume thread

  const WorkStateView({
    this.activeThreadId,
    this.activeAction = 'silent',
    this.board = const [],
    this.resumeThreadId,
    this.resumeCard,
  });

  factory WorkStateView.fromJson(Map<String, dynamic> j) {
    final active = j['active'] as Map<String, dynamic>?;
    final decision = active?['decision'] as Map<String, dynamic>?;
    return WorkStateView(
      activeThreadId: j['activeThreadId'] as String?,
      activeAction: decision?['action'] as String? ?? 'silent',
      board: (j['board'] as List?)
              ?.whereType<Map>()
              .map((m) => ThreadCard.fromJson(m.cast<String, dynamic>()))
              .toList() ??
          const [],
      resumeThreadId: j['resumeThreadId'] as String?,
      resumeCard: (j['resumeCard'] as Map?) != null
          ? ResumeCard.fromJson((j['resumeCard'] as Map).cast<String, dynamic>())
          : null,
    );
  }

  /// The thread the user just returned to, if the engine armed the resume
  /// marker and the board still carries it. Null = nothing to resume.
  ThreadCard? get resumeThread {
    if (resumeThreadId == null) return null;
    for (final t in board) {
      if (t.topicId == resumeThreadId) return t;
    }
    return null;
  }

  /// The currently-attended thread (pinned to the board's bottom in the UI).
  ThreadCard? get active {
    for (final t in board) {
      if (t.isActive) return t;
    }
    return null;
  }

  /// Background threads (everything except the active one), need-descending.
  List<ThreadCard> get background => board.where((t) => !t.isActive).toList();

  /// The single thread that has crossed into the "now" tier, if any — drives
  /// the ambient pill. Highest-need background thread at tier `now`.
  ThreadCard? get topAlert {
    for (final t in background) {
      if (t.tier == NeedTier.now) return t;
    }
    return null;
  }
}
