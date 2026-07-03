// Calibrated resumption scorer (Layer 5, DESIGN-WSM-prediction.md §10) — MVP.
// Retrieval yields CANDIDATES (what similar past returns actually did); the
// heuristic yields a cold-start prediction. This fuses them under a conservative
// calibration gate: actual history overrides the heuristic ONLY with enough
// qualified neighbors and a clear modal outcome — else the heuristic stands. No
// scores are ever surfaced; retrieval only sharpens band + loudness, with an
// evidence chip ("N similar returns") when it drives the card.

import { BANDS, type Band } from "./tokenizer.js";
import type { RetrievalCandidate } from "./retrieval.js";

const MIN_QUALIFIED = 8; // real-return neighbors needed to trust retrieval
const MIN_MAJORITY = 0.4; // the modal band must hold this share of support

/** Replace the heuristic band with the retrieval mode when it's well-supported. */
export function fuseBand(heuristic: Band, r: RetrievalCandidate): { band: Band; fromData: boolean } {
  if (r.qualifiedN < MIN_QUALIFIED || !r.topBand) return { band: heuristic, fromData: false };
  const total = Object.values(r.bandDist).reduce((a, b) => a + b, 0);
  const share = total > 0 ? (r.bandDist[r.topBand] ?? 0) / total : 0;
  if (share < MIN_MAJORITY) return { band: heuristic, fromData: false };
  const band = BANDS.find((b) => b.code === r.topBand);
  return band ? { band, fromData: true } : { band: heuristic, fromData: false };
}

/** Loudness from observed continuation, once retrieval is trustworthy; else null
 *  (keep the heuristic's loudness). continuation_probability stays INTERNAL. */
export function loudnessFromRetrieval(r: RetrievalCandidate): "low" | "quiet" | "compact" | "full" | null {
  if (r.qualifiedN < MIN_QUALIFIED) return null;
  if (r.continuationRate >= 0.7) return "full";
  if (r.continuationRate >= 0.45) return "compact";
  if (r.continuationRate >= 0.2) return "quiet";
  return "low";
}
