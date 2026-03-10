import { EventEmitter } from "node:events";
import type { TranscriptionConfig, AudioChunk, TranscriptResult } from "../types.js";
import type { Profiler } from "../profiler.js";
import type { TranscriptionBackend } from "./transcription-backend.js";
import { LocalTranscriptionBackend } from "./transcription-local.js";
import { OpenRouterTranscriptionBackend } from "./transcription-openrouter.js";
import { isDuplicateTranscript, bigramSimilarity } from "../util/dedup.js";
import { log, warn, error, debug } from "../log.js";

const TAG = "transcribe";

/** Detect repeated-token hallucinations like "kuch kuch kuch kuch..." */
function isHallucination(text: string): boolean {
  const words = text.split(/[\s,]+/).filter(Boolean);
  if (words.length < 6) return false;
  const freq = new Map<string, number>();
  for (const w of words) {
    const lw = w.toLowerCase();
    freq.set(lw, (freq.get(lw) || 0) + 1);
  }
  const maxFreq = Math.max(...freq.values());
  return maxFreq / words.length > 0.6;
}

/**
 * Transcription service — sends audio chunks to the configured backend for transcription.
 *
 * Events: 'transcript' (TranscriptResult)
 */
export class TranscriptionService extends EventEmitter {
  private config: TranscriptionConfig;
  private backend: TranscriptionBackend;
  private destroyed: boolean = false;
  private pendingRequests: number = 0;
  private readonly MAX_CONCURRENT = 5;

  private latencies: number[] = [];
  private cumulativeLatencies: number[] = [];
  private latencyStatsTimer: ReturnType<typeof setInterval> | null = null;
  private totalAudioDurationMs: number = 0;
  private profiler: Profiler | null = null;
  private errorCount: number = 0;
  private dropCount: number = 0;
  private totalCalls: number = 0;

  // Per-source dedup: track last 3 transcripts per source
  private recentSystemTranscripts: string[] = [];
  private recentMicTranscripts: string[] = [];

  setProfiler(p: Profiler): void { this.profiler = p; }

  constructor(config: TranscriptionConfig) {
    super();
    this.config = config;

    if (config.backend === "local") {
      this.backend = new LocalTranscriptionBackend(config.local);
    } else {
      if (!config.openrouterApiKey) {
        warn(TAG, "OpenRouter API key not set — transcription will fail");
      }
      this.backend = new OpenRouterTranscriptionBackend({
        openrouterApiKey: config.openrouterApiKey,
        geminiModel: config.geminiModel,
        language: config.language,
        languages: config.languages,
      });
    }

    log(TAG, `initialized: backend=${config.backend} model=${config.geminiModel} language=${config.language}`);

    this.latencyStatsTimer = setInterval(() => this.logStats(), 60_000);
  }

  async processChunk(chunk: AudioChunk): Promise<void> {
    if (this.destroyed) return;
    this.totalCalls++;

    if (this.pendingRequests >= this.MAX_CONCURRENT) {
      this.dropCount++;
      this.profiler?.gauge("transcription.drops", this.dropCount);
      warn(TAG, `dropping chunk: ${this.pendingRequests} requests already pending`);
      return;
    }

    this.pendingRequests++;
    this.profiler?.gauge("transcription.pending", this.pendingRequests);
    try {
      await this.transcribeViaBackend(chunk);
    } catch (err) {
      this.errorCount++;
      this.profiler?.gauge("transcription.errors", this.errorCount);
      error(TAG, "transcription failed:", err instanceof Error ? err.message : err);
    } finally {
      this.pendingRequests--;
      this.profiler?.gauge("transcription.pending", this.pendingRequests);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.backend.destroy();
    if (this.latencyStatsTimer) { clearInterval(this.latencyStatsTimer); this.latencyStatsTimer = null; }
    this.logStats();
    this.removeAllListeners();
    log(TAG, "destroyed");
  }

  private logStats(): void {
    if (this.latencies.length === 0) return;

    const sorted = [...this.latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;

    log(TAG, `latency stats (n=${sorted.length}): p50=${Math.round(p50)}ms p95=${Math.round(p95)}ms avg=${Math.round(avg)}ms`);

    if (this.totalAudioDurationMs > 0) {
      const audioMinutes = this.totalAudioDurationMs / 60_000;
      const tokensConsumed = this.getTokensConsumed();
      const costPerMToken = 0.075;
      const estimatedCost = (tokensConsumed / 1_000_000) * costPerMToken;
      const costPerMinute = audioMinutes > 0 ? estimatedCost / audioMinutes : 0;
      log(TAG, `cost stats: ${tokensConsumed} tokens, ${audioMinutes.toFixed(1)} audio-min, ~$${estimatedCost.toFixed(6)} total, ~$${costPerMinute.toFixed(6)}/audio-min`);
    }

    this.latencies = [];
  }

  /** Get cumulative profiling stats for /health. */
  getProfilingStats(): Record<string, unknown> {
    const sorted = [...this.cumulativeLatencies].sort((a, b) => a - b);
    const n = sorted.length;
    const p50 = n > 0 ? sorted[Math.floor(n / 2)] : 0;
    const p95 = n > 0 ? sorted[Math.floor(n * 0.95)] : 0;
    const avg = n > 0 ? sorted.reduce((a, b) => a + b, 0) / n : 0;
    const audioMinutes = this.totalAudioDurationMs / 60_000;
    const tokensConsumed = this.getTokensConsumed();
    const costPerMToken = 0.075;
    const estimatedCost = (tokensConsumed / 1_000_000) * costPerMToken;

    return {
      backend: this.config.backend,
      calls: this.totalCalls,
      p50Ms: Math.round(p50),
      p95Ms: Math.round(p95),
      avgMs: Math.round(avg),
      totalAudioMinutes: Math.round(audioMinutes * 10) / 10,
      estimatedCost: Math.round(estimatedCost * 1_000_000) / 1_000_000,
      errors: this.errorCount,
      drops: this.dropCount,
    };
  }

  // ── Unified backend dispatch ──

  private async transcribeViaBackend(chunk: AudioChunk): Promise<void> {
    const startTs = Date.now();
    const result = await this.backend.transcribe(chunk);
    const elapsed = Date.now() - startTs;

    this.latencies.push(elapsed);
    this.cumulativeLatencies.push(elapsed);
    if (this.cumulativeLatencies.length > 1_000) this.cumulativeLatencies.shift();
    this.profiler?.timerRecord("transcription.call", elapsed);
    this.totalAudioDurationMs += chunk.durationMs;

    if (!result) return;

    const { text } = result;

    if (text.length < 3) {
      debug(TAG, `transcript too short, dropping: "${text}"`);
      return;
    }

    if (isHallucination(text)) {
      warn(TAG, `hallucination detected, dropping: "${text.slice(0, 80)}..."`);
      return;
    }

    // Dedup before emitting
    if (this.isDeduplicated(result)) return;

    log(TAG, `transcript (${elapsed}ms): "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`);
    this.emit("transcript", result);
  }

  // ── Dedup ──

  private isDeduplicated(result: TranscriptResult): boolean {
    const isSystem = result.audioSource === "system";
    const recentSame = isSystem ? this.recentSystemTranscripts : this.recentMicTranscripts;

    // Skip near-duplicate transcripts within same source
    if (isDuplicateTranscript(result.text, recentSame)) {
      log(TAG, `transcript deduped (${result.audioSource}): "${result.text.slice(0, 60)}..."`);
      return true;
    }

    // Cross-stream dedup: drop mic transcript if >70% similar to recent system transcript
    if (!isSystem && this.recentSystemTranscripts.length > 0) {
      const trimmed = result.text.trim();
      for (const recent of this.recentSystemTranscripts) {
        if (bigramSimilarity(trimmed, recent) > 0.70) {
          log(TAG, `mic transcript cross-deduped (speakers pickup): "${trimmed.slice(0, 60)}..."`);
          return true;
        }
      }
    }

    // Track recent transcripts (ring buffer of 3 per source)
    recentSame.push(result.text.trim());
    if (recentSame.length > 3) recentSame.shift();

    return false;
  }

  // ── Token tracking ──

  private getTokensConsumed(): number {
    if (this.backend instanceof OpenRouterTranscriptionBackend) {
      return this.backend.getTokensConsumed();
    }
    return 0;
  }
}
