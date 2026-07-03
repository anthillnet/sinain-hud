// WorkState tokenizer (Layer 1, DESIGN-WSM-prediction.md §6) — converts a
// return-situation feature snapshot into stable, bucketed *behavioral tokens*.
// These (tokens_before) + the observed outcome tokens (tokens_after) are the
// training corpus every downstream layer (retrieval, semantic-IDs, sequence
// model, calibrated scorer) is fitted on. No identity leakage beyond a coarse
// project/app slug; buckets keep the vocabulary small and generalizable.

/** The situation at a thread-return, derived from the WSM ThreadState. */
export interface ReturnFeatures {
  threadId: string;
  label: string;
  app: string;
  gapMinutes: number; // time the thread was cooled
  interruptions: number; // threads switched-to since leaving
  agentOutputs: number; // agent/openclaw feed items since leaving
  attendCount: number;
  ageMs: number; // thread lifetime
  trajectoryLen: number;
  difficulty: number; // 0..1
  hasError: boolean;
  openRegions: number; // ROI issues open at leave
  frozen: boolean; // a lastWork snapshot was captured
  roiEngaged: number;
  unresolved: boolean;
  longThread: boolean;
  topicAffinity: number; // 0..1
  recurrence: number;
  surfaceMatch: string; // same_project | same_project_same_doc | ...
  returnConfidence: string; // high (hysteresis-committed) | ...
}

// ── Duration bands (5, §3.3 / §12) ───────────────────────────────────────────
export interface Band { code: string; label: string; display: string; hiMin: number }
export const BANDS: Band[] = [
  { code: "2_5m", label: "Quick return", display: "~2–5 min", hiMin: 5 },
  { code: "5_15m", label: "Short continuation", display: "~5–15 min", hiMin: 15 },
  { code: "15_30m", label: "Work block", display: "~15–25 min", hiMin: 30 },
  { code: "30_60m", label: "Deep continuation", display: "~30–60 min", hiMin: 60 },
  { code: "60m_plus", label: "Large block", display: "~60+ min", hiMin: Infinity },
];

/** Predicted band from the re-entry tier, nudged by thread size. */
export function bandForTier(tier: "low" | "medium" | "high", longThread: boolean): Band {
  if (tier === "low") return longThread ? BANDS[1] : BANDS[0];
  if (tier === "medium") return BANDS[2];
  return longThread ? BANDS[4] : BANDS[3];
}

/** Observed band from an actual active duration (the outcome label). */
export function bandForMinutes(min: number): Band {
  return BANDS.find((b) => min < b.hiMin) ?? BANDS[BANDS.length - 1];
}

// ── Bucketing ────────────────────────────────────────────────────────────────
const slug = (s: string): string =>
  s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "UNKNOWN";

function gapBucket(min: number): string {
  if (min < 5) return "GAP_LT_5M";
  if (min < 15) return "GAP_5_15M";
  if (min < 60) return "GAP_15_60M";
  if (min < 240) return "GAP_1_4H";
  return "GAP_GT_4H";
}
function interruptBucket(n: number): string {
  if (n <= 0) return "INTERRUPTIONS_0";
  if (n <= 2) return "INTERRUPTIONS_1_2";
  if (n <= 5) return "INTERRUPTIONS_3_5";
  return "INTERRUPTIONS_GT_5";
}
function backlogBucket(n: number): string {
  if (n <= 0) return "AGENT_BACKLOG_0";
  if (n === 1) return "AGENT_BACKLOG_1";
  if (n === 2) return "AGENT_BACKLOG_2";
  return "AGENT_BACKLOG_3PLUS";
}
function affinityBucket(a: number): string {
  if (a >= 0.6) return "AFFINITY_HIGH";
  if (a >= 0.3) return "AFFINITY_MED";
  return "AFFINITY_LOW";
}

/** The situation token sequence (tokens_before). */
export function workStateTokens(f: ReturnFeatures): string[] {
  const t: string[] = ["RETURN_TO_THREAD"];
  t.push(`PROJECT_${slug(f.label)}`);
  if (f.app) t.push(`APP_${slug(f.app)}`);
  t.push(gapBucket(f.gapMinutes));
  t.push(interruptBucket(f.interruptions));
  t.push(f.longThread ? "THREAD_LEN_LONG" : f.attendCount >= 4 ? "THREAD_LEN_MED" : "THREAD_LEN_SHORT");
  t.push(backlogBucket(f.agentOutputs));
  t.push(f.hasError ? "STATE_UNRESOLVED_ERROR" : f.unresolved ? "STATE_UNRESOLVED_DECISION" : "STATE_CLEAR");
  t.push(f.roiEngaged >= 2 ? "ROI_REPEATED" : f.roiEngaged === 1 ? "ROI_SINGLE" : "ROI_NONE");
  t.push(f.frozen ? "LASTWORK_EXISTS" : "LASTWORK_MISSING");
  t.push(affinityBucket(f.topicAffinity));
  return t;
}

/** Outcome token for how long the user actually stayed (or abandonment). */
export function continuationToken(activeMin: number, accepted: boolean): string {
  if (activeMin < 2 && !accepted) return "OUTCOME_ABANDONED";
  return `OUTCOME_CONTINUED_${bandForMinutes(activeMin).code.toUpperCase()}`;
}

/** Map the card's internal loudness → the §16 support_mode label. */
export function supportMode(loudness: string): string {
  switch (loudness) {
    case "low": return "low_confidence_card";
    case "quiet": return "quiet_chip";
    case "full": return "full_resume_card";
    default: return "compact_resume_card";
  }
}
