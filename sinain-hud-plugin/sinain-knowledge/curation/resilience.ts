/**
 * sinain-knowledge — ResilienceManager + HealthWatchdog
 *
 * Manages retry storm detection, outage tracking, overflow watchdog,
 * and proactive health monitoring. Decoupled from OpenClaw — communicates
 * through the BackendAdapter interface for transcript access and alerts.
 */

import type { Logger } from "../data/schema.js";

// ============================================================================
// Constants
// ============================================================================

export const ERROR_WINDOW_MS = 5 * 60_000;
export const OUTAGE_ERROR_RATE_THRESHOLD = 0.8;
export const OUTAGE_MIN_SAMPLES = 3;
export const FILE_SYNC_DEBOUNCE_MS = 3 * 60_000;
export const PLAYBOOK_GEN_DEBOUNCE_MS = 5 * 60_000;
export const SHORT_FAILURE_THRESHOLD_MS = 10_000;
export const LONG_FAILURE_THRESHOLD_MS = 3 * 60_000;

export const OVERFLOW_CONSECUTIVE_THRESHOLD = 5;
export const OVERFLOW_TRANSCRIPT_MIN_BYTES = 1_000_000;
export const OVERFLOW_ERROR_PATTERN = /overloaded|context.*too.*long|token.*limit|extra usage is required/i;

export const SESSION_HYGIENE_SIZE_BYTES = 2_000_000;
export const SESSION_HYGIENE_AGE_MS = 24 * 60 * 60 * 1000;

export const WATCHDOG_INTERVAL_MS = 5 * 60_000;
export const ALERT_COOLDOWN_MS = 15 * 60_000;
export const STALENESS_WARNING_MS = 10 * 60_000;
export const STALENESS_CRITICAL_MS = 15 * 60_000;
export const SESSION_SIZE_WARNING_BYTES = 1_500_000;
export const SESSION_SIZE_RESTART_BYTES = 2_000_000;
export const AUTO_RESTART_COOLDOWN_MS = 60 * 60_000;

// ============================================================================
// Types
// ============================================================================

export type ErrorRateResult = {
  rate: number;
  total: number;
  failures: number;
};

export type HealthCheckResult = {
  transcriptMB: number | null;
  staleSec: number;
  errorRate: number;
  errorTotal: number;
  overflowCount: number;
  resetRecently: boolean;
  issues: string[];
};

export interface TranscriptInfo {
  path: string;
  bytes: number;
}

/**
 * Interface for backend operations needed by the resilience layer.
 * Avoids direct coupling to OpenClaw or any specific backend.
 */
export interface ResilienceBackend {
  getTranscriptSize(): TranscriptInfo | null;
  performOverflowReset(): boolean;
  sendAlert(alertType: string, title: string, body: string): Promise<void>;
}

// ============================================================================
// ResilienceManager
// ============================================================================

export class ResilienceManager {
  recentOutcomes: Array<{ ts: number; success: boolean; error?: string }> = [];
  lastSuccessTs = 0;
  consecutiveFailures = 0;
  outageDetected = false;
  outageStartTs = 0;
  consecutiveOverflowErrors = 0;
  consecutiveHeartbeatSkips = 0;
  lastResetTs = 0;
  lastAutoRestartTs = 0;

  // Debounce timestamps
  lastPlaybookGenTs = 0;
  lastFileSyncTs = 0;
  lastEvalReportDate: string | null = null;

  computeErrorRate(): ErrorRateResult {
    const cutoff = Date.now() - ERROR_WINDOW_MS;
    while (this.recentOutcomes.length > 0 && this.recentOutcomes[0].ts < cutoff) {
      this.recentOutcomes.shift();
    }
    const total = this.recentOutcomes.length;
    if (total === 0) return { rate: 0, total: 0, failures: 0 };
    const failures = this.recentOutcomes.filter((o) => !o.success).length;
    return { rate: failures / total, total, failures };
  }

  recordSuccess(backend: ResilienceBackend, logger: Logger): void {
    const wasOutage = this.outageDetected;
    const outageDurationMs = this.outageStartTs > 0 ? Date.now() - this.outageStartTs : 0;
    this.consecutiveFailures = 0;
    this.outageDetected = false;
    this.lastSuccessTs = Date.now();
    if (wasOutage) {
      logger.info(
        `sinain-hud: OUTAGE RECOVERED — resumed after ${Math.round(outageDurationMs / 1000)}s`,
      );
      backend.sendAlert("recovery", "✅ *sinain-hud* recovered",
        `• Gateway up, first run succeeded\n• Downtime: ~${Math.round(outageDurationMs / 60_000)}min`);
    }
  }

  recordShortFailure(backend: ResilienceBackend, logger: Logger): void {
    this.consecutiveFailures++;
    const { rate, total } = this.computeErrorRate();
    if (!this.outageDetected && total >= OUTAGE_MIN_SAMPLES && rate >= OUTAGE_ERROR_RATE_THRESHOLD) {
      this.outageDetected = true;
      this.outageStartTs = Date.now();
      logger.warn(
        `sinain-hud: OUTAGE DETECTED — ${Math.round(rate * 100)}% error rate over ${total} samples, ${this.consecutiveFailures} consecutive failures`,
      );
      backend.sendAlert("outage", "🔴 *sinain-hud* OUTAGE DETECTED",
        `• ${Math.round(rate * 100)}% error rate over ${total} samples\n• ${this.consecutiveFailures} consecutive failures`);
    }
  }

  checkOverflow(
    isSuccess: boolean,
    error: string | undefined,
    durationMs: number,
    backend: ResilienceBackend,
    logger: Logger,
  ): void {
    if (!isSuccess && OVERFLOW_ERROR_PATTERN.test(error ?? "")) {
      this.consecutiveOverflowErrors++;
      logger.warn(
        `sinain-hud: overflow watchdog — error #${this.consecutiveOverflowErrors}/${OVERFLOW_CONSECUTIVE_THRESHOLD}`,
      );
      if (this.consecutiveOverflowErrors >= OVERFLOW_CONSECUTIVE_THRESHOLD) {
        logger.warn("sinain-hud: OVERFLOW THRESHOLD REACHED — attempting transcript reset");
        if (backend.performOverflowReset()) {
          this._resetAfterOverflow(backend);
        }
      }
    } else if (isSuccess) {
      this.consecutiveOverflowErrors = 0;
    }

    // Duration-gated: long failure + overflow pattern = stuck retry loop
    const isLongFailure = !isSuccess && durationMs > LONG_FAILURE_THRESHOLD_MS;
    if (isLongFailure && OVERFLOW_ERROR_PATTERN.test(error ?? "")) {
      logger.warn(
        `sinain-hud: long failure (${Math.round(durationMs / 1000)}s) with overflow error — immediate reset`,
      );
      if (backend.performOverflowReset()) {
        this._resetAfterOverflow(backend, `• ${Math.round(durationMs / 1000)}s failed run with overflow error\n• Transcript truncated, next heartbeat should recover`);
      }
    }
  }

  private _resetAfterOverflow(backend: ResilienceBackend, body?: string): void {
    this.lastResetTs = Date.now();
    this.consecutiveOverflowErrors = 0;
    this.outageDetected = false;
    this.consecutiveFailures = 0;
    this.outageStartTs = 0;
    backend.sendAlert(
      "overflow_reset",
      body ? "⚠️ *sinain-hud* overflow reset (stuck retry)" : "⚠️ *sinain-hud* overflow reset triggered",
      body ?? `• ${OVERFLOW_CONSECUTIVE_THRESHOLD} consecutive overflow errors\n• Transcript truncated`,
    );
  }

  isFileSyncDue(): boolean {
    return this.lastFileSyncTs === 0 || (Date.now() - this.lastFileSyncTs) >= FILE_SYNC_DEBOUNCE_MS;
  }

  markFileSynced(): void {
    this.lastFileSyncTs = Date.now();
  }

  isPlaybookGenDue(): boolean {
    return this.lastPlaybookGenTs === 0 || (Date.now() - this.lastPlaybookGenTs) >= PLAYBOOK_GEN_DEBOUNCE_MS;
  }

  markPlaybookGenerated(): void {
    this.lastPlaybookGenTs = Date.now();
  }

  resetAll(): void {
    this.recentOutcomes.length = 0;
    this.lastSuccessTs = 0;
    this.lastPlaybookGenTs = 0;
    this.lastFileSyncTs = 0;
    this.outageDetected = false;
    this.consecutiveFailures = 0;
    this.outageStartTs = 0;
    this.consecutiveHeartbeatSkips = 0;
    this.consecutiveOverflowErrors = 0;
    this.lastResetTs = 0;
    this.lastAutoRestartTs = 0;
    this.lastEvalReportDate = null;
  }
}

// ============================================================================
// HealthWatchdog
// ============================================================================

export class HealthWatchdog {
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private resilience: ResilienceManager,
    private backend: ResilienceBackend,
    private logger: Logger,
  ) {}

  runChecks(): HealthCheckResult {
    const transcript = this.backend.getTranscriptSize();
    const transcriptMB = transcript ? +(transcript.bytes / 1_000_000).toFixed(2) : null;
    const staleSec = this.resilience.lastSuccessTs > 0
      ? Math.round((Date.now() - this.resilience.lastSuccessTs) / 1000)
      : 0;
    const { rate, total } = this.resilience.computeErrorRate();
    const resetRecently = this.resilience.lastResetTs > 0
      && (Date.now() - this.resilience.lastResetTs) < STALENESS_CRITICAL_MS * 2;

    const issues: string[] = [];
    if (transcriptMB !== null && transcript!.bytes >= SESSION_SIZE_WARNING_BYTES) {
      issues.push(`transcript ${transcriptMB}MB (threshold ${(SESSION_SIZE_WARNING_BYTES / 1_000_000).toFixed(1)}MB)`);
    }
    if (this.resilience.lastSuccessTs > 0 && (Date.now() - this.resilience.lastSuccessTs) >= STALENESS_WARNING_MS && this.resilience.recentOutcomes.length >= 3) {
      issues.push(`stale ${staleSec}s since last success`);
    }
    if (total >= 5 && rate > 0.5) {
      issues.push(`error rate ${Math.round(rate * 100)}% (${total} samples)`);
    }
    if (this.resilience.consecutiveOverflowErrors >= 3) {
      issues.push(`overflow errors ${this.resilience.consecutiveOverflowErrors}/${OVERFLOW_CONSECUTIVE_THRESHOLD}`);
    }
    if (resetRecently && this.resilience.lastSuccessTs > 0 && this.resilience.lastSuccessTs < this.resilience.lastResetTs) {
      issues.push("post-reset stall (no success since reset)");
    }

    return { transcriptMB, staleSec, errorRate: rate, errorTotal: total, overflowCount: this.resilience.consecutiveOverflowErrors, resetRecently, issues };
  }

  async runWatchdog(): Promise<void> {
    const transcript = this.backend.getTranscriptSize();
    const now = Date.now();

    // Layer 1: Proactive session size check
    if (transcript && transcript.bytes >= SESSION_SIZE_WARNING_BYTES) {
      const sizeMB = (transcript.bytes / 1_000_000).toFixed(1);

      if (transcript.bytes >= SESSION_SIZE_RESTART_BYTES) {
        this.logger.warn(`sinain-hud: watchdog — transcript ${sizeMB}MB, forcing overflow reset`);
      } else {
        this.logger.info(`sinain-hud: watchdog — transcript ${sizeMB}MB, proactive reset`);
      }

      if (this.backend.performOverflowReset()) {
        this.resilience.lastResetTs = now;
        this.resilience.consecutiveOverflowErrors = 0;
        this.backend.sendAlert("proactive_reset", "⚠️ *sinain-hud* proactive session reset",
          `• Transcript was ${sizeMB}MB → truncated\n• No downtime expected`);
      }
    }

    // Staleness check
    if (this.resilience.lastSuccessTs > 0 && this.resilience.recentOutcomes.length >= 3) {
      const staleMs = now - this.resilience.lastSuccessTs;

      if (staleMs >= STALENESS_WARNING_MS && staleMs < STALENESS_CRITICAL_MS) {
        const staleMin = Math.round(staleMs / 60_000);
        this.backend.sendAlert("staleness_warning", "⚠️ *sinain-hud* response stale",
          `• No successful run in ${staleMin}min\n• Error rate: ${Math.round(this.resilience.computeErrorRate().rate * 100)}%`);
      }
    }

    // Layer 2: Emergency restart — reset didn't recover
    if (this.resilience.lastResetTs > 0 && this.resilience.lastSuccessTs > 0 && this.resilience.lastSuccessTs < this.resilience.lastResetTs) {
      const sinceResetMs = now - this.resilience.lastResetTs;
      if (sinceResetMs >= STALENESS_CRITICAL_MS) {
        const canRestart = (now - this.resilience.lastAutoRestartTs) >= AUTO_RESTART_COOLDOWN_MS;
        if (canRestart) {
          const staleMin = Math.round((now - this.resilience.lastSuccessTs) / 60_000);
          this.logger.warn(`sinain-hud: EMERGENCY RESTART — reset ${Math.round(sinceResetMs / 60_000)}min ago, no recovery`);
          await this.backend.sendAlert("emergency_restart", "🔴 *sinain-hud* EMERGENCY RESTART",
            `• Queue jammed — reset didn't recover in ${Math.round(sinceResetMs / 60_000)}min\n• Last success: ${staleMin}min ago\n• Gateway restarting now (~5s)`);
          this.resilience.lastAutoRestartTs = now;
          await new Promise((r) => setTimeout(r, 1000));
          process.exit(1);
        } else {
          this.logger.warn("sinain-hud: watchdog — would restart but cooldown active (max 1/hour)");
        }
      }
    }

    // Error rate alert
    const { rate, total } = this.resilience.computeErrorRate();
    if (total >= 5 && rate > 0.5) {
      this.backend.sendAlert("high_error_rate", "⚠️ *sinain-hud* high error rate",
        `• ${Math.round(rate * 100)}% failures over ${total} samples\n• Consecutive overflow errors: ${this.resilience.consecutiveOverflowErrors}/${OVERFLOW_CONSECUTIVE_THRESHOLD}`);
    }

    // Overflow approaching threshold
    if (this.resilience.consecutiveOverflowErrors >= 3 && this.resilience.consecutiveOverflowErrors < OVERFLOW_CONSECUTIVE_THRESHOLD) {
      this.backend.sendAlert("overflow_warning", "⚠️ *sinain-hud* overflow errors accumulating",
        `• ${this.resilience.consecutiveOverflowErrors}/${OVERFLOW_CONSECUTIVE_THRESHOLD} consecutive overflow errors\n• Auto-reset will trigger at ${OVERFLOW_CONSECUTIVE_THRESHOLD}`);
    }
  }

  start(): void {
    this.interval = setInterval(() => {
      this.runWatchdog().catch((err) => {
        this.logger.warn(`sinain-hud: watchdog error: ${String(err)}`);
      });
    }, WATCHDOG_INTERVAL_MS);
    this.logger.info("sinain-hud: health watchdog started (5-min interval)");
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
