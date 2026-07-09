import type { WindowStats } from "./window-ops.js";
import { log } from "../log.js";

/**
 * Burst-lane instrumentation (perf/burst-instrumentation).
 *
 * Measures what each Cerebras gesture actually costs and, from the window
 * composition, how much two not-yet-built levers would save — WITHOUT
 * changing any prompt or output. Zero behavioural effect: it reads the same
 * WindowStats assembleWindow already computes, emits one structured log line
 * per gesture, and keeps a rolling per-gesture aggregate.
 *
 *   [burst-metric] {"gesture":"summon","tokensIn":21874,...}   ← per call
 *   [burst-metric] summary ...                                 ← every 60s
 *
 * Lever headroom is MEASURED, not guessed:
 *   L2 (real dedup)  → nearDupOcrChars: OCR that survives the exact-consecutive
 *                      filter but is >=0.9 shingle-similar to a recent frame.
 *   L1 (semantic)    → ocrChars - semanticAltChars: what raw OCR costs over the
 *                      dense semantic representation already in the buffer.
 * Projected tokens use this call's own chars→token ratio (tokensIn/totalChars),
 * so the estimate is calibrated to the real tokenizer, not a 4-chars constant.
 */

const TAG = "burst-metric";

export type BurstGesture = "summon" | "enrich" | "preview" | "voice-seed";

export interface BurstMetricEntry {
  gesture: BurstGesture;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  cacheKey?: string;
  /** null for gestures that don't assemble a window (none today, kept honest). */
  stats?: WindowStats | null;
}

interface GestureAgg {
  n: number;
  tokensIn: number;
  tokensInMax: number;
  tokensOut: number;
  latencyMs: number;
  latencyMaxMs: number;
  // window-composition sums (for lever sizing)
  totalChars: number;
  ocrChars: number;
  nearDupOcrChars: number;   // L2 headroom
  semanticAltChars: number;  // L1: what OCR events would cost as semantic text
  semanticEvents: number;
  ocrEvents: number;
  truncatedChars: number;
}

function emptyAgg(): GestureAgg {
  return {
    n: 0, tokensIn: 0, tokensInMax: 0, tokensOut: 0, latencyMs: 0, latencyMaxMs: 0,
    totalChars: 0, ocrChars: 0, nearDupOcrChars: 0, semanticAltChars: 0,
    semanticEvents: 0, ocrEvents: 0, truncatedChars: 0,
  };
}

export class BurstMetrics {
  private aggs = new Map<BurstGesture, GestureAgg>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = Date.now();

  record(entry: BurstMetricEntry): void {
    const s = entry.stats ?? null;
    // Per-gesture structured line — greppable, one JSON object, exact numbers.
    log(TAG, JSON.stringify({
      gesture: entry.gesture,
      tokensIn: entry.tokensIn,
      tokensOut: entry.tokensOut,
      latencyMs: entry.latencyMs,
      cacheKey: entry.cacheKey,
      minutes: s?.minutes,
      lineCount: s?.lineCount,
      totalChars: s?.totalChars,
      ocrChars: s?.ocrChars,
      ocrEvents: s?.ocrEvents,
      exactDupDropped: s?.exactDupDropped,
      nearDupOcrChars: s?.nearDupOcrChars,     // L2 headroom
      semanticEvents: s?.semanticEvents,
      semanticAltChars: s?.semanticAltChars,   // L1 dense alt cost
      truncatedChars: s?.truncatedChars,
    }));

    let agg = this.aggs.get(entry.gesture);
    if (!agg) this.aggs.set(entry.gesture, (agg = emptyAgg()));
    agg.n += 1;
    agg.tokensIn += entry.tokensIn;
    agg.tokensInMax = Math.max(agg.tokensInMax, entry.tokensIn);
    agg.tokensOut += entry.tokensOut;
    agg.latencyMs += entry.latencyMs;
    agg.latencyMaxMs = Math.max(agg.latencyMaxMs, entry.latencyMs);
    if (s) {
      agg.totalChars += s.totalChars;
      agg.ocrChars += s.ocrChars;
      agg.nearDupOcrChars += s.nearDupOcrChars;
      agg.semanticAltChars += s.semanticAltChars;
      agg.semanticEvents += s.semanticEvents;
      agg.ocrEvents += s.ocrEvents;
      agg.truncatedChars += s.truncatedChars;
    }
  }

  /** Per-gesture rollup with L1/L2 token projections (calibrated per gesture). */
  snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [gesture, a] of this.aggs) {
      // chars→token ratio from what we actually billed. Falls back to 0.25
      // (~4 chars/token) only when a gesture logged no window chars.
      const ratio = a.totalChars > 0 ? a.tokensIn / a.totalChars : 0.25;
      const l2SaveTok = Math.round(a.nearDupOcrChars * ratio);
      const l1SaveTok = Math.round(Math.max(0, a.ocrChars - a.semanticAltChars) * ratio);
      out[gesture] = {
        n: a.n,
        tokensIn_avg: Math.round(a.tokensIn / a.n),
        tokensIn_max: a.tokensInMax,
        tokensIn_total: a.tokensIn,
        tokensOut_avg: Math.round(a.tokensOut / a.n),
        latencyMs_avg: Math.round(a.latencyMs / a.n),
        latencyMs_max: a.latencyMaxMs,
        ocrShareOfChars: a.totalChars > 0 ? +(a.ocrChars / a.totalChars).toFixed(2) : 0,
        projected: {
          l2_dedup_saveTok_avg: a.n > 0 ? Math.round(l2SaveTok / a.n) : 0,
          l1_semantic_saveTok_avg: a.n > 0 ? Math.round(l1SaveTok / a.n) : 0,
          l1_l2_combined_pct: a.tokensIn > 0
            ? +(((l1SaveTok + l2SaveTok) / a.tokensIn) * 100).toFixed(0) : 0,
        },
      };
    }
    return out;
  }

  startPeriodicLog(ms: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.aggs.size === 0) return;
      const mins = ((Date.now() - this.startedAt) / 60_000).toFixed(1);
      log(TAG, `summary (${mins}m):`, JSON.stringify(this.snapshot()));
    }, ms);
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

/** Process-wide singleton — every burst call site records into the same rollup. */
export const burstMetrics = new BurstMetrics();
