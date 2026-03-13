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

/** Extended negative-sentiment markers for digestSentiment signal */
const NEG_PATTERNS = [
  ...ERROR_PATTERNS,
  "blocked", "stuck", "cannot", "not working", "waiting", "timeout",
];

function countNegPatterns(text: string): number {
  const lower = text.toLowerCase();
  return NEG_PATTERNS.filter(p => lower.includes(p)).length;
}

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
  openclawResponse: string;     // stored at schedule time for responseQuality
  responseLatencyMs: number;    // stored at schedule time for responseQuality
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
      openclawResponse: record.openclawResponse,
      responseLatencyMs: record.responseLatencyMs,
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

  /**
   * Patch a finalized (or in-flight) feedback record with new signal values.
   * Called for async signals arriving outside the scheduled collection windows
   * (e.g. spawnCompleted, hudEngagement).
   */
  patchRecord(recordId: string, date: string, patch: Partial<Omit<FeedbackSignals, "compositeScore">>): void {
    const existing = this.feedbackStore.readSignals(recordId, date);
    if (!existing) return;
    const merged: FeedbackSignals = { ...existing, ...patch };
    merged.compositeScore = this.computeComposite(merged);
    this.feedbackStore.updateSignals(recordId, date, merged);
    log(TAG, `patched record ${recordId}: score=${merged.compositeScore.toFixed(2)}, patch=${JSON.stringify(patch)}`);
  }

  /**
   * Register a HUD engagement event from the overlay.
   * Finds the most recent pending or finalized record within a 5-minute window
   * and patches its hudEngagement signal.
   */
  registerEngagement(action: "copy" | "scroll" | "dismissed", eventTs: number): void {
    const windowMs = 5 * 60_000;

    // Search pending records first (most common case)
    let target: PendingCollection | null = null;
    for (const entry of this.pending.values()) {
      if (eventTs - entry.recordTs <= windowMs && eventTs >= entry.recordTs) {
        if (!target || entry.recordTs > target.recordTs) target = entry;
      }
    }

    if (target) {
      this.patchRecord(target.recordId, target.recordDate, { hudEngagement: action });
      log(TAG, `hud_engagement action=${action} linked to pending record ${target.recordId}`);
      return;
    }

    // Record already finalized — query feedbackStore for most recent record
    const recent = this.feedbackStore.queryRecent(1);
    if (recent.length > 0 && eventTs - recent[0].ts <= windowMs) {
      const date = new Date(recent[0].ts).toISOString().slice(0, 10);
      this.patchRecord(recent[0].id, date, { hudEngagement: action });
      log(TAG, `hud_engagement action=${action} linked to finalized record ${recent[0].id}`);
    } else {
      log(TAG, `hud_engagement action=${action} — no recent record within ${windowMs}ms window`);
    }
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
        log(TAG, `final signals for ${entry.recordId}: score=${signals.compositeScore.toFixed(2)}, err=${signals.errorCleared}, reesc=${signals.noReEscalation}, sentiment=${signals.digestSentiment}, quality=${signals.responseQuality}`);
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
      const recentEntries = this.agentLoop.getHistory(3);
      if (recentEntries.length > 0) {
        errorCleared = recentEntries.every(e => !hasErrorPattern(e.digest));
      }
    }

    // ── digestSentiment: negative-marker trend across ALL escalations ──
    let digestSentiment: FeedbackSignals["digestSentiment"] = null;
    const atEscalation = countNegPatterns(entry.digestAtEscalation);
    const recentForSentiment = this.agentLoop.getHistory(3);
    if (recentForSentiment.length === 0 || atEscalation === 0) {
      digestSentiment = "neutral";
    } else {
      const recentAvg = recentForSentiment.reduce((s, e) => s + countNegPatterns(e.digest), 0) / recentForSentiment.length;
      digestSentiment = recentAvg < atEscalation * 0.5 ? "improving"
                      : recentAvg > atEscalation * 1.5 ? "worsening"
                      : "neutral";
    }

    // ── responseQuality: heuristic from stored escalation response data ──
    let responseQuality: number | null = null;
    if (elapsedMs >= 60_000) {
      if (entry.responseLatencyMs > 30_000) {
        responseQuality = -0.05;   // timeout
      } else if (entry.openclawResponse.trim().length === 0) {
        responseQuality = -0.1;    // no content
      } else if (entry.openclawResponse.trim().length > 200) {
        responseQuality = 0.1;     // substantive response
      } else {
        responseQuality = 0.05;    // short but present
      }
    }

    // ── noReEscalation: same reasons haven't fired within 5 min ──
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
      const earlySwitch = appHistory.find(a =>
        a.ts > entry.recordTs && a.ts <= entry.recordTs + 10_000
      );
      quickAppSwitch = earlySwitch !== undefined;
    }

    // ── Preserve existing async patches (spawnCompleted, hudEngagement) ──
    // Read existing signals so we don't overwrite values patched between collections
    const existing = this.feedbackStore.readSignals(entry.recordId, entry.recordDate);
    const spawnCompleted = existing?.spawnCompleted ?? null;
    const hudEngagement = existing?.hudEngagement ?? null;

    // ── compositeScore: weighted combination ──
    const compositeScore = this.computeComposite({
      errorCleared,
      noReEscalation,
      dwellTimeMs,
      quickAppSwitch,
      digestSentiment,
      responseQuality,
      spawnCompleted,
      hudEngagement,
    });

    return {
      errorCleared,
      noReEscalation,
      dwellTimeMs,
      quickAppSwitch,
      compositeScore,
      digestSentiment,
      responseQuality,
      spawnCompleted,
      hudEngagement,
    };
  }

  private computeComposite(signals: {
    errorCleared: boolean | null;
    noReEscalation: boolean | null;
    dwellTimeMs: number | null;
    quickAppSwitch: boolean | null;
    digestSentiment?: FeedbackSignals["digestSentiment"];
    responseQuality?: number | null;
    spawnCompleted?: boolean | null;
    hudEngagement?: FeedbackSignals["hudEngagement"];
  }): number {
    let score = 0;

    // Error cleared: strong positive (+0.5) — only for error: escalations
    if (signals.errorCleared !== null) {
      score += signals.errorCleared ? 0.5 : -0.3;
    }

    // No re-escalation: positive (+0.3)
    if (signals.noReEscalation !== null) {
      score += signals.noReEscalation ? 0.3 : -0.2;
    }

    // Dwell time: weak positive if > 60s
    if (signals.dwellTimeMs !== null) {
      if (signals.dwellTimeMs > 60_000) {
        score += 0.15;
      } else if (signals.dwellTimeMs < 10_000) {
        score -= 0.1;
      }
    }

    // Quick app switch: reduced negative (was -0.15)
    if (signals.quickAppSwitch !== null) {
      score += signals.quickAppSwitch ? -0.05 : 0.05;
    }

    // Digest sentiment: broad resolution signal for all escalations
    if (signals.digestSentiment != null) {
      if (signals.digestSentiment === "improving") score += 0.25;
      else if (signals.digestSentiment === "worsening") score -= 0.2;
      // "neutral" contributes 0
    }

    // Response quality: heuristic from response length + latency
    if (signals.responseQuality != null) {
      score += Math.max(-0.1, Math.min(0.1, signals.responseQuality));
    }

    // Spawn completed: strong signal — linked background task succeeded
    if (signals.spawnCompleted === true) {
      score += 0.3;
    }

    // HUD engagement: direct signal from user interaction with the overlay
    if (signals.hudEngagement != null) {
      if (signals.hudEngagement === "copy") score += 0.3;
      else if (signals.hudEngagement === "scroll") score += 0.15;
      else if (signals.hudEngagement === "dismissed") score -= 0.1;
    }

    // Clamp to [-1, 1]
    return Math.max(-1, Math.min(1, score));
  }
}
