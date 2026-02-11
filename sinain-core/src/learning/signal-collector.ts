import type { FeedbackSignals, FeedbackRecord } from "../types.js";
import type { FeedbackStore } from "./feedback-store.js";
import type { AgentLoop } from "../agent/loop.js";
import type { SenseBuffer } from "../buffers/sense-buffer.js";
import { log, warn } from "../log.js";

const TAG = "signal-collector";

/** Error patterns matching scorer.ts */
const ERROR_PATTERNS = [
  "error", "failed", "failure", "exception", "crash", "traceback",
  "typeerror", "referenceerror", "syntaxerror", "cannot read", "undefined is not",
  "exit code", "segfault", "panic", "fatal", "enoent",
];

function hasErrorPattern(text: string): boolean {
  const lower = text.toLowerCase();
  return ERROR_PATTERNS.some(p => lower.includes(p));
}

interface PendingCollection {
  recordId: string;
  recordTs: number;
  recordDate: string;       // YYYY-MM-DD for file lookup
  escalationReasons: string[];
  digestAtEscalation: string;
  timers: ReturnType<typeof setTimeout>[];
}

/**
 * Deferred signal backfill for feedback records.
 *
 * After each escalation, schedules checks at 60s, 120s, and 300s
 * to read from existing buffers and compute feedback signals.
 * At 300s (the final check), writes the composite score and persists.
 */
export class SignalCollector {
  private pending = new Map<string, PendingCollection>();

  constructor(
    private feedbackStore: FeedbackStore,
    private agentLoop: AgentLoop,
    private senseBuffer: SenseBuffer,
  ) {}

  /** Schedule signal collection for a feedback record. */
  schedule(record: FeedbackRecord): void {
    const date = new Date(record.ts).toISOString().slice(0, 10);
    const entry: PendingCollection = {
      recordId: record.id,
      recordTs: record.ts,
      recordDate: date,
      escalationReasons: record.escalationReasons,
      digestAtEscalation: record.digest,
      timers: [],
    };

    // Schedule partial collections at 60s and 120s, final at 300s
    entry.timers.push(setTimeout(() => this.collect(entry, "partial"), 60_000));
    entry.timers.push(setTimeout(() => this.collect(entry, "partial"), 120_000));
    entry.timers.push(setTimeout(() => this.collect(entry, "final"), 300_000));

    this.pending.set(record.id, entry);
    log(TAG, `scheduled signal collection for record ${record.id} (tick #${record.tickId})`);
  }

  /** Cancel all pending collections. Called on shutdown. */
  destroy(): void {
    for (const entry of this.pending.values()) {
      for (const t of entry.timers) clearTimeout(t);
    }
    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  // ── Private ──

  private collect(entry: PendingCollection, phase: "partial" | "final"): void {
    try {
      const signals = this.computeSignals(entry);

      const updated = this.feedbackStore.updateSignals(
        entry.recordId,
        entry.recordDate,
        signals,
      );

      if (phase === "final") {
        this.pending.delete(entry.recordId);
        log(TAG, `final signals for ${entry.recordId}: score=${signals.compositeScore.toFixed(2)}, err=${signals.errorCleared}, reesc=${signals.noReEscalation}`);
      }

      if (!updated && phase === "final") {
        warn(TAG, `could not update signals for ${entry.recordId} — record not found in ${entry.recordDate}.jsonl`);
      }
    } catch (err: any) {
      warn(TAG, `signal collection error for ${entry.recordId}: ${err.message}`);
      if (phase === "final") {
        this.pending.delete(entry.recordId);
      }
    }
  }

  private computeSignals(entry: PendingCollection): FeedbackSignals {
    const now = Date.now();
    const elapsedMs = now - entry.recordTs;

    // ── errorCleared: check if error patterns are absent in recent digests ──
    let errorCleared: boolean | null = null;
    const hadError = entry.escalationReasons.some(r => r.startsWith("error:"));
    if (hadError) {
      // Look at the 3 most recent agent entries
      const recentEntries = this.agentLoop.getHistory(3);
      if (recentEntries.length > 0) {
        // All recent entries should be free of error patterns
        errorCleared = recentEntries.every(e => !hasErrorPattern(e.digest));
      }
    }

    // ── noReEscalation: same reasons haven't fired within 5 min ──
    // We check by looking at recent feedback records for overlapping reasons
    let noReEscalation: boolean | null = null;
    if (elapsedMs >= 60_000) {
      const recentRecords = this.feedbackStore.queryRecent(10);
      const reEscalated = recentRecords.some(r =>
        r.id !== entry.recordId &&
        r.ts > entry.recordTs &&
        r.ts <= entry.recordTs + 300_000 &&
        r.escalationReasons.some(reason => entry.escalationReasons.includes(reason))
      );
      noReEscalation = !reEscalated;
    }

    // ── dwellTimeMs: time from escalation until the next HUD push ──
    let dwellTimeMs: number | null = null;
    const historyEntries = this.agentLoop.getHistory(20);
    for (const e of historyEntries) {
      if (e.ts > entry.recordTs && e.pushed) {
        dwellTimeMs = e.ts - entry.recordTs;
        break;
      }
    }

    // ── quickAppSwitch: app changed within 10s of escalation ──
    let quickAppSwitch: boolean | null = null;
    const appHistory = this.senseBuffer.appHistory(entry.recordTs);
    if (appHistory.length >= 2) {
      // Check if there was an app switch within 10s of escalation
      const earlySwitch = appHistory.find(a =>
        a.ts > entry.recordTs && a.ts <= entry.recordTs + 10_000
      );
      quickAppSwitch = earlySwitch !== undefined;
    }

    // ── compositeScore: weighted combination ──
    const compositeScore = this.computeComposite({
      errorCleared,
      noReEscalation,
      dwellTimeMs,
      quickAppSwitch,
    });

    return {
      errorCleared,
      noReEscalation,
      dwellTimeMs,
      quickAppSwitch,
      compositeScore,
    };
  }

  private computeComposite(signals: {
    errorCleared: boolean | null;
    noReEscalation: boolean | null;
    dwellTimeMs: number | null;
    quickAppSwitch: boolean | null;
  }): number {
    let score = 0;
    let weight = 0;

    // Error cleared: strong positive (+0.5)
    if (signals.errorCleared !== null) {
      score += signals.errorCleared ? 0.5 : -0.3;
      weight += 0.5;
    }

    // No re-escalation: positive (+0.3)
    if (signals.noReEscalation !== null) {
      score += signals.noReEscalation ? 0.3 : -0.2;
      weight += 0.3;
    }

    // Dwell time: weak positive if > 60s
    if (signals.dwellTimeMs !== null) {
      if (signals.dwellTimeMs > 60_000) {
        score += 0.15;
      } else if (signals.dwellTimeMs < 10_000) {
        score -= 0.1;
      }
      weight += 0.15;
    }

    // Quick app switch: weak negative
    if (signals.quickAppSwitch !== null) {
      score += signals.quickAppSwitch ? -0.15 : 0.05;
      weight += 0.1;
    }

    // Normalize if we have signals, otherwise return 0
    if (weight === 0) return 0;

    // Clamp to [-1, 1]
    return Math.max(-1, Math.min(1, score));
  }
}
