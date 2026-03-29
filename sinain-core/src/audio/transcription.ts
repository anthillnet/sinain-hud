import { EventEmitter } from "node:events";
import type { TranscriptionConfig, AudioChunk, TranscriptResult } from "../types.js";
import type { Profiler } from "../profiler.js";
import type { CostTracker } from "../cost/tracker.js";
import { LocalTranscriptionBackend } from "./transcription-local.js";
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
 * Transcription service — sends audio chunks to OpenRouter (Gemini) for transcription.
 *
 * Events: 'transcript' (TranscriptResult)
 */
export class TranscriptionService extends EventEmitter {
  private config: TranscriptionConfig;
  private destroyed: boolean = false;
  private pendingRequests: number = 0;
  private readonly MAX_CONCURRENT = 5;
  private localBackend: LocalTranscriptionBackend | null = null;

  private latencies: number[] = [];
  private cumulativeLatencies: number[] = [];
  private latencyStatsTimer: ReturnType<typeof setInterval> | null = null;
  private totalAudioDurationMs: number = 0;
  private totalTokensConsumed: number = 0;
  private profiler: Profiler | null = null;
  private errorCount: number = 0;
  private dropCount: number = 0;
  private totalCalls: number = 0;

  private costTracker: CostTracker | null = null;

  setProfiler(p: Profiler): void { this.profiler = p; }
  setCostTracker(ct: CostTracker): void { this.costTracker = ct; }

  constructor(config: TranscriptionConfig) {
    super();
    this.config = config;

    if (config.backend === "local") {
      this.localBackend = new LocalTranscriptionBackend(config.local);
    } else if (!config.openrouterApiKey) {
      warn(TAG, "OpenRouter API key not set \u2014 transcription will fail");
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
      if (this.localBackend) {
        await this.transcribeViaLocal(chunk);
      } else {
        await this.transcribeViaOpenRouter(chunk);
      }
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
    this.localBackend?.destroy();
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
      const costPerMToken = 0.075;
      const estimatedCost = (this.totalTokensConsumed / 1_000_000) * costPerMToken;
      const costPerMinute = audioMinutes > 0 ? estimatedCost / audioMinutes : 0;
      log(TAG, `cost stats: ${this.totalTokensConsumed} tokens, ${audioMinutes.toFixed(1)} audio-min, ~$${estimatedCost.toFixed(6)} total, ~$${costPerMinute.toFixed(6)}/audio-min`);
    }

    this.latencies = [];
  }

  // ── Local whisper backend ──

  private async transcribeViaLocal(chunk: AudioChunk): Promise<void> {
    const startTs = Date.now();
    const result = await this.localBackend!.transcribe(chunk);
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

    this.emit("transcript", result);
  }

  // ── OpenRouter backend ──

  /** Get cumulative profiling stats for /health. */
  getProfilingStats(): Record<string, unknown> {
    const sorted = [...this.cumulativeLatencies].sort((a, b) => a - b);
    const n = sorted.length;
    const p50 = n > 0 ? sorted[Math.floor(n / 2)] : 0;
    const p95 = n > 0 ? sorted[Math.floor(n * 0.95)] : 0;
    const avg = n > 0 ? sorted.reduce((a, b) => a + b, 0) / n : 0;
    const audioMinutes = this.totalAudioDurationMs / 60_000;
    const costPerMToken = 0.075;
    const estimatedCost = (this.totalTokensConsumed / 1_000_000) * costPerMToken;

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

  private async transcribeViaOpenRouter(chunk: AudioChunk): Promise<void> {
    if (!this.config.openrouterApiKey) {
      this.errorCount++;
      this.profiler?.gauge("transcription.errors", this.errorCount);
      error(TAG, "OpenRouter API key not configured");
      return;
    }

    const base64Audio = chunk.buffer.toString("base64");
    const startTs = Date.now();

    debug(TAG, `sending ${chunk.durationMs}ms chunk to OpenRouter (${Math.round(chunk.buffer.length / 1024)}KB)`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.config.openrouterApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.geminiModel,
          messages: [{
            role: "user",
            content: [
              { type: "input_audio", input_audio: { data: base64Audio, format: "wav" } },
              { type: "text", text: `Transcribe this audio in ${this.config.language}. Output ONLY the transcript text, nothing else. If the audio is not in ${this.config.language}, output an empty string.` },
            ],
          }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.errorCount++;
        this.profiler?.gauge("transcription.errors", this.errorCount);
        const body = await response.text().catch(() => "(no body)");
        error(TAG, `OpenRouter error ${response.status}: ${body.slice(0, 300)}`);
        return;
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };

      const text = data.choices?.[0]?.message?.content?.trim();
      const elapsed = Date.now() - startTs;

      this.latencies.push(elapsed);
      this.cumulativeLatencies.push(elapsed);
      if (this.cumulativeLatencies.length > 1_000) this.cumulativeLatencies.shift();
      this.profiler?.timerRecord("transcription.call", elapsed);
      this.totalAudioDurationMs += chunk.durationMs;

      // Track tokens and cost before any early returns — the API call is already billed
      if (data.usage) {
        this.totalTokensConsumed += (data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0);
      }
      if (typeof data.usage?.cost === "number" && data.usage.cost > 0) {
        this.costTracker?.record({
          source: "transcription",
          model: this.config.geminiModel,
          cost: data.usage.cost,
          tokensIn: data.usage?.prompt_tokens || 0,
          tokensOut: data.usage?.completion_tokens || 0,
          ts: Date.now(),
        });
      }

      if (!text) {
        warn(TAG, `OpenRouter returned empty transcript (${elapsed}ms)`);
        return;
      }

      if (text.length < 3) {
        debug(TAG, `transcript too short, dropping: "${text}"`);
        return;
      }

      if (isHallucination(text)) {
        warn(TAG, `hallucination detected, dropping: "${text.slice(0, 80)}..."`);
        return;
      }

      log(TAG, `transcript (${elapsed}ms): "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`);

      const result: TranscriptResult = {
        text,
        source: "openrouter",
        refined: false,
        confidence: 0.8,
        ts: Date.now(),
        audioSource: chunk.audioSource,
      };

      this.emit("transcript", result);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        this.errorCount++;
        this.profiler?.gauge("transcription.errors", this.errorCount);
        warn(TAG, "OpenRouter request timed out (30s)");
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

}
