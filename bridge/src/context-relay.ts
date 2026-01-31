import type { BridgeConfig } from "./types.js";
import { ContextManager } from "./context-manager.js";
import { OpenClawClient } from "./openclaw-client.js";
import { log, warn } from "./log.js";

const TAG = "relay";

const TRANSCRIPT_SOURCES = new Set(["aws", "gemini", "openrouter", "whisper"]);

/**
 * Context Relay: receives transcript chunks, deduplicates,
 * batches, and forwards to Sinain via OpenClaw at controlled intervals.
 *
 * MVP: simple pass-through with dedup and rate limiting.
 * Future: LLM-based filtering and importance scoring.
 */
export class ContextRelay {
  private contextManager: ContextManager;
  private openclawClient: OpenClawClient;
  private minIntervalMs: number;
  private lastEscalationTs: number = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private recentHashes: Set<string> = new Set();
  private hashCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    contextManager: ContextManager,
    openclawClient: OpenClawClient,
    config: BridgeConfig
  ) {
    this.contextManager = contextManager;
    this.openclawClient = openclawClient;
    this.minIntervalMs = config.relayMinIntervalMs;

    // Clean up dedup hashes every 2 minutes
    this.hashCleanupTimer = setInterval(() => {
      this.recentHashes.clear();
    }, 120_000);
  }

  /**
   * Ingest a transcript chunk. Deduplicates and schedules relay.
   */
  ingest(text: string, source: string = "transcript"): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;

    // Dedup: hash the normalized text
    const hash = this.simpleHash(trimmed.toLowerCase());
    if (this.recentHashes.has(hash)) {
      log(TAG, `dedup: skipping duplicate chunk`);
      return false;
    }
    this.recentHashes.add(hash);

    // Log transcript-specific ingestion
    if (TRANSCRIPT_SOURCES.has(source)) {
      log(TAG, `📝 transcript ingested [${source}]: "${trimmed.slice(0, 80)}${trimmed.length > 80 ? "..." : ""}"`);
    }

    // Store in context manager
    this.contextManager.add(trimmed, source);

    // Schedule escalation
    this.scheduleEscalation();
    return true;
  }

  /**
   * Immediately relay a direct user message (bypass rate limiting).
   */
  async relayDirect(text: string): Promise<boolean> {
    log(TAG, `direct relay: ${text.slice(0, 80)}`);
    return this.openclawClient.sendMessage(text);
  }

  /**
   * Force-flush: send current context summary to Sinain now.
   */
  async flush(): Promise<boolean> {
    return this.escalate();
  }

  /** Schedule an escalation respecting the minimum interval */
  private scheduleEscalation(): void {
    if (this.pendingTimer) return; // already scheduled

    const elapsed = Date.now() - this.lastEscalationTs;
    const remaining = Math.max(0, this.minIntervalMs - elapsed);

    if (remaining === 0) {
      // Can send immediately
      this.escalate();
    } else {
      log(TAG, `scheduling escalation in ${Math.round(remaining / 1000)}s`);
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        this.escalate();
      }, remaining);
    }
  }

  /** Package and send context to Sinain */
  private async escalate(): Promise<boolean> {
    const summary = this.contextManager.summarize(15);
    if (summary === "(no recent context)") {
      log(TAG, "nothing to escalate");
      return false;
    }

    const contextPackage = this.formatContextPackage(summary);
    log(TAG, `escalating context (${contextPackage.length} chars)`);

    const success = await this.openclawClient.sendMessage(contextPackage);
    if (success) {
      this.lastEscalationTs = Date.now();
    } else {
      warn(TAG, "escalation failed, will retry next interval");
    }
    return success;
  }

  /**
   * Format a context package for Sinain.
   * Future: use LLM to summarize and filter.
   */
  private formatContextPackage(summary: string): string {
    const entryCount = this.contextManager.size;
    return [
      `Context update (${entryCount} entries):`,
      summary,
    ].join("\n");
  }

  /** Simple string hash for dedup */
  private simpleHash(s: string): string {
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      hash = ((hash << 5) - hash + ch) | 0;
    }
    return hash.toString(36);
  }

  /** Graceful shutdown */
  destroy(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.hashCleanupTimer) {
      clearInterval(this.hashCleanupTimer);
      this.hashCleanupTimer = null;
    }
  }
}
