// Estimator — RawFeatures × pretrained prior × surface embedding → WorkStateVector.
// Pure scoring; the embedding is the only (already-paid, in-process) cost.

import type { PriorStore } from "./prior.js";
import type { Dim, MatchedTopic, RawFeatures, Verdict, WorkStateVector } from "./types.js";

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const dim = (value: number, verdict: Verdict): Dim => ({ value: clamp01(value), verdict });

// Switch-rate (per min) → fragmentation. ~4+ switches/min reads as fully fragmented.
const FRAGMENT_FULL = 4;
// KG match must clear this to *enrich* a thread — below it the match is noise
// (it was mislabeling new work onto the nearest stale topic at ~0.37).
const ENRICH_MIN = 0.45;

export type EmbedFn = (text: string) => Promise<Float32Array | null>;

export async function estimate(
  features: RawFeatures,
  prior: PriorStore,
  embed: EmbedFn,
): Promise<WorkStateVector> {
  // Memory-grounded topic match (RELIABLE axis — Sinain's strongest).
  let topicAffinity = 0;
  let matchedTopic: WorkStateVector["matchedTopic"];
  let matchedTopics: MatchedTopic[] = [];
  let frictionPrior = 0;
  if (prior.ready && features.surfaceText.length > 8) {
    const surface = await embed(features.surfaceText);
    if (surface) {
      const matches = prior.topMatches(surface, 4, ENRICH_MIN);
      if (matches.length) {
        const best = matches[0];
        // cosine in MiniLM space typically lands 0.1–0.6 for real matches;
        // rescale so a 0.6 similarity reads as a strong affinity.
        topicAffinity = clamp01(best.similarity / 0.6);
        frictionPrior = best.topic.frictionPrior;
        matchedTopics = matches.map((m) => ({
          id: m.topic.id,
          label: m.topic.label,
          similarity: Math.round(m.similarity * 1000) / 1000,
          recurrence: m.topic.recurrence,
          distinctDays: m.topic.distinctDays,
          frictionPrior: m.topic.frictionPrior,
          ageDays: m.topic.ageDays,
        }));
        matchedTopic = matchedTopics[0];
      }
    }
  }

  const fragmentation = clamp01(features.switchRate / FRAGMENT_FULL);
  const focusStability = clamp01(1 - fragmentation);
  // Availability = how interruptible. Active speech (meeting/call) lowers it.
  const availability = clamp01(1 - features.vadDensity);

  // PARTIAL: difficulty blends historical friction with the one specific live
  // signal (repeated-same-issue, semantic-sourced). Surface as a soft indicator only.
  const difficulty = clamp01(0.6 * frictionPrior + (features.recurringIssue ? 0.4 : 0));

  // ASPIRATIONAL: stuckness — confounded with productive grind; internal only.
  // High dwell + issue recurrence + low topic novelty as a *hypothesis*.
  const longDwell = clamp01((features.dwellMs - 90_000) / 180_000); // ramps after 1.5min
  const stuckness = clamp01(0.5 * (features.recurringIssue ? 1 : 0) + 0.5 * longDwell);

  return {
    ts: features.ts,
    app: features.app,
    windowTitle: features.windowTitle,
    activity: features.activityHint,
    focusStability: dim(focusStability, "reliable"),
    fragmentation: dim(fragmentation, "reliable"),
    availability: dim(availability, "reliable"),
    topicAffinity: dim(topicAffinity, "reliable"),
    difficulty: dim(difficulty, "partial"),
    historicalFriction: dim(frictionPrior, "partial"),
    stuckness: dim(stuckness, "aspirational"),
    matchedTopic,
    matchedTopics,
  };
}
