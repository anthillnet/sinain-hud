// Work-State Model (WSM) — shared types. See docs/DESIGN-WORK-STATE-MODEL.md.
//
// Every latent dimension carries a `verdict` tag (dossier §A/§F). The Athium
// policy may only *act on* RELIABLE + PARTIAL dimensions until an ASPIRATIONAL
// dimension's head is calibrated against captured labels — so the type system
// keeps us honest about what is measured vs hypothesized.

export type Verdict = "reliable" | "partial" | "aspirational";

export interface Dim {
  value: number; // 0..1
  verdict: Verdict;
}

export interface MatchedTopic {
  id: string;
  label: string;
  similarity: number; // raw cosine (used for routing)
  recurrence: number;
  distinctDays: number; // for return-cadence
  frictionPrior: number;
  ageDays: number | null;
}

export interface WorkStateVector {
  ts: number;
  app: string;
  windowTitle?: string;
  activity: string; // coarse, app-level (dossier §B ceiling)

  // RELIABLE — measured descriptors
  focusStability: Dim;
  fragmentation: Dim;
  availability: Dim;
  topicAffinity: Dim; // memory-grounded — Sinain's strongest axis

  // PARTIAL — coarse personalized indicators
  difficulty: Dim;
  historicalFriction: Dim;

  // ASPIRATIONAL — internal only, never surfaced, never gates until calibrated
  stuckness: Dim;

  matchedTopic?: MatchedTopic; // best by similarity (drives difficulty/friction)
  matchedTopics?: MatchedTopic[]; // top-K (project umbrella + sub-focuses)
}

// ── Pretrained prior (emitted by prior_builder.py) ──────────────────────────

export interface PriorTopic {
  id: string;
  label: string;
  centroid: number[]; // 384-dim, L2-normalized
  recurrence: number;
  distinctDays: number;
  frictionPrior: number;
  lastSeen: string | null;
  ageDays: number | null;
  sampleFacts: string[];
}

export interface PriorModel {
  version: number;
  builtAt: string;
  factCount: number;
  spanDays: number;
  globalReturnRate: number;
  activityBaseRates: Record<string, number>;
  topics: PriorTopic[];
}

// ── Live features (extractor output) ────────────────────────────────────────

export interface RawFeatures {
  ts: number;
  app: string;
  windowTitle?: string;
  surfaceText: string; // recent OCR + transcript
  switchRate: number; // app switches per minute over the window
  dwellMs: number; // time on the current app
  /** Repeated-same-issue (the one specific signal, §B) — from SEMANTIC sources
   *  only (has_error flags / a persistent LLM-detected region-issue), never OCR
   *  keyword matching (domain-blind rule, design §2). */
  recurringIssue: boolean;
  vadDensity: number; // 0..1 audio-presence proxy
  activityHint: string;
  sceneCut: boolean; // app changed vs previous tick — a breakpoint (§8)
  /** Structural thread identity — repo / conversation / page / app. The unit a
   *  thread is keyed by; the KG match only *enriches* it, never defines it. */
  projectKey: string;
  projectLabel: string;
}

// ── Athium policy output ────────────────────────────────────────────────────

export type AthiumAction = "silent" | "hold" | "offer-at-breakpoint" | "offer-now";

export interface AthiumDecision {
  action: AthiumAction;
  assistValue: number;
  interruptCost: number;
  why: string[];
}

// ── Parallel work-states (the thread bank, §9) ──────────────────────────────

/** A within-surface region-thread (the existing `regionId` layer) nested under
 *  the active project-thread — the cockpit renders these inside the active card
 *  (design §9 nesting: project → regions). `warmth` (1 = just seen → 0 cooled)
 *  drives the nested dot color, mirroring the project-thread warmth cue. */
export interface RegionThreadLite {
  id: string;
  label: string;
  warmth: number; // 0..1, recency of the last detection
}

/** One project-thread on the attention board — a cooled snapshot ranked by how
 *  much it warrants the user's attention right now. `stuckness` is carried for
 *  display only (ASPIRATIONAL — never scored into `needScore` until calibrated). */
export interface ThreadBoardEntry {
  topicId: string;
  label: string;
  activity: string;
  isActive: boolean; // the thread the user is attending right now
  kgContext: string | null; // KG sub-focus enrichment (null = unrecognized work)
  needScore: number; // ranking key (RELIABLE+PARTIAL only)
  staleness: number; // time-since-attended vs expected cadence (0..1)
  temperature: number; // working-memory warmth (1 = just attended)
  assistValue: number;
  difficulty: number;
  stuckness: number; // display-only annotation
  ageMs: number; // since last attended
  attendCount: number;
  action: AthiumAction;
  trajectory: number[]; // recent assistValue history (sparkline)
  why: string[];
  /** Within-surface region-threads, nested under the project-thread. Populated
   *  only for the active entry (regions belong to the surface in focus). */
  regions?: RegionThreadLite[];
}

// ── Calibrated Resume Card (P5) — see docs/DESIGN-WSM-SIGNAL-INVENTORY.md §6 ──

/** Per-thread "last work" snapshot, frozen at the switch-away breakpoint so the
 *  return card can show where-you-left-off before the global digest moves on.
 *  Supplied by index.ts via `engine.setLastWorkSource` (digest/hud are global-
 *  latest; OCR/regions are the surface at leave). */
export interface LastWork {
  ts: number;
  digest: string | null; // the agent digest as it was at leave (already paid)
  hud: string | null;
  ocrLines: string[]; // top lines of the last surface
  transcriptTail: string | null; // last utterance(s), if any
  regions: { issue: string; tip: string }[]; // open ROI issues at leave
  errorReasons: string[]; // escalation reasons / has_error markers
}

export type ReentryTier = "low" | "medium" | "high";
export type Reliability = "low" | "medium" | "good";
export type Loudness = "low" | "quiet" | "compact" | "full";

/** One predicted next step (closed vocabulary → top-k chips, never one order). */
export interface NextAction {
  action:
    | "read" | "continue_implementation" | "review_agent_output" | "make_decision"
    | "fix_blocker" | "respond" | "summarize_defer" | "archive_close" | "create_task" | "ask_agent";
  label: string;
}

/** The calibrated re-entry instrument. Predictions choose timing/shape; every
 *  surfaced claim carries evidence. `continuation_probability` is INTERNAL —
 *  it only sets `loudness`, never shown as a number. */
export interface ResumeCard {
  threadId: string;
  label: string;
  brief: string; // resume_brief — softened by reliability
  reliability: Reliability;
  reentryTier: ReentryTier; // reentry_cost — Low/Medium/High, never a score
  drivers: string[]; // evidence raising re-entry cost (why this card is shown)
  reducers: string[]; // evidence easing re-entry (snapshot, ROI engagement)
  focusBand: { label: string; display: string }; // estimated_focus_time — a band
  nextActions: NextAction[]; // next_likely_action — top-k
  changedWhileAway: string | null;
  loudness: Loudness; // from continuation_probability (INTERNAL)
}

export interface WorkStateView {
  activeThreadId: string | null;
  active: { vector: WorkStateVector; decision: AthiumDecision } | null;
  board: ThreadBoardEntry[];
  /** Set the moment the user returns to a cooled thread (§9 resume breakpoint).
   *  Drives the overlay's "Back to…" dashed marker → resumption card. Null when
   *  there's nothing to resume. */
  resumeThreadId: string | null;
  /** The calibrated card for the armed resume thread, or null. */
  resumeCard: ResumeCard | null;
}
