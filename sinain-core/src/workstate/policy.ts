// Athium v1 — the mixed-initiative decision gate (dossier §C, firmest ground).
//
// assist iff  value-of-information − cost-of-interruption > τ  (Horvitz VOI).
// Score form is ADDITIVE-with-threshold + per-factor clip (dossier §D — the
// multiplicative interest×difficulty×goal form is a soft-AND that zeros on any
// noisy factor and compounds noise). Three field-tested corrections baked in:
//   1. don't interrupt focus → QUEUE to the next breakpoint (scene cut), not suppress
//   2. back off hard after a rejection (~62% re-dismissal)
//   3. keep a silent-stuck exception (momentum-gating misses a quietly-stuck user)
//
// Honesty rule (dossier §A/§F): only RELIABLE + PARTIAL dims may *gate*.
// `stuckness` (ASPIRATIONAL) is logged as a hypothesis, never gates, until its
// head is calibrated against captured labels.

import type { AthiumDecision, RawFeatures, WorkStateVector } from "./types.js";

const TAU = 0.15; // value must clear cost by this margin to act
const REJECT_COOLDOWN_MS = 5 * 60_000;

export interface PolicyContext {
  lastRejectTs: number; // 0 if never
}

export function decide(
  v: WorkStateVector,
  f: RawFeatures,
  ctx: PolicyContext,
): AthiumDecision {
  const why: string[] = [];

  // Value of assisting (additive over gating-eligible dims only).
  const relevance = v.topicAffinity.value; // RELIABLE
  const difficulty = v.difficulty.value; // PARTIAL
  const goalAlignment = clamp01(relevance * 0.7 + (v.matchedTopic ? Math.min(1, v.matchedTopic.recurrence / 100) : 0) * 0.3);
  const assistValue = clamp01(0.45 * relevance + 0.35 * difficulty + 0.2 * goalAlignment);
  if (relevance > 0.4) why.push(`relevant to "${v.matchedTopic?.label}" (seen ${v.matchedTopic?.recurrence}×)`);
  if (difficulty > 0.3) why.push(f.recurringIssue ? "unresolved issue persisting on screen" : "historically effortful topic");

  // Cost of interrupting: high focus and active speech both raise it.
  const interruptCost = clamp01(0.25 + 0.45 * v.focusStability.value + 0.4 * f.vadDensity);
  if (v.focusStability.value > 0.6) why.push("user is focused");
  if (f.vadDensity > 0.5) why.push("active conversation");

  const margin = assistValue - interruptCost;

  // (2) Backoff window after a rejection.
  if (ctx.lastRejectTs && f.ts - ctx.lastRejectTs < REJECT_COOLDOWN_MS) {
    why.push("backing off (recent decline)");
    return { action: "silent", assistValue, interruptCost, why };
  }

  if (margin <= TAU) {
    // Not worth it now. (3) Silent-stuck exception is computed but, per the
    // honesty rule, only *noted* — it cannot gate until stuckness is calibrated.
    if (v.stuckness.value > 0.7 && relevance > 0.4) {
      why.push("⚠ silent-stuck hypothesis (not gating until calibrated)");
    }
    return { action: margin > 0 ? "hold" : "silent", assistValue, interruptCost, why };
  }

  // Worth it. (1) Time it: fire now only at a breakpoint, else queue to one.
  if (f.sceneCut || v.focusStability.value < 0.4) {
    why.push("at a breakpoint");
    return { action: "offer-now", assistValue, interruptCost, why };
  }
  why.push("deferring to next breakpoint");
  return { action: "offer-at-breakpoint", assistValue, interruptCost, why };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
