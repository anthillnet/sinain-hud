import { EventEmitter } from "node:events";
import type { TranscriptionConfig, AudioChunk, TranscriptResult } from "./types.js";
import { log, warn, error } from "./log.js";

const TAG = "transcribe";

/**
 * Transcription service.
 *
 * MVP: OpenRouter backend (send WAV audio to Gemini for transcription).
 * Future: AWS Transcribe Streaming + Gemini refinement hybrid.
 *
 * Events:
 *   'transcript' (TranscriptResult) — emitted when a transcription completes
 */
export class TranscriptionService extends EventEmitter {
  private config: TranscriptionConfig;
  private destroyed: boolean = false;
  private pendingRequests: number = 0;
  private readonly MAX_CONCURRENT = 3;

  // For future AWS+Gemini hybrid: accumulate partials
  private partialAccumulator: string[] = [];
  private refineTimer: ReturnType<typeof setInterval> | null = null;

  // Latency tracking
  private latencies: number[] = [];
  private latencyStatsTimer: ReturnType<typeof setInterval> | null = null;
  private totalAudioDurationMs: number = 0;
  private totalTokensConsumed: number = 0;

  constructor(config: TranscriptionConfig) {
    super();
    this.config = config;

    if (config.backend === "openrouter" && !config.openrouterApiKey) {
      warn(TAG, "OpenRouter API key not set — transcription will fail");
    }

    if (config.backend === "aws-gemini") {
      if (!config.awsAccessKeyId || !config.awsSecretAccessKey) {
        warn(TAG, "AWS credentials not set — falling back to OpenRouter");
      }
      // Start Gemini refinement timer for AWS hybrid mode
      this.refineTimer = setInterval(() => {
        this.refinePartials().catch((err) => {
          warn(TAG, "refinement error:", err instanceof Error ? err.message : err);
        });
      }, config.refineIntervalMs);
    }

    log(TAG, `initialized: backend=${config.backend} model=${config.geminiModel} language=${config.language}`);

    // Log transcription stats every 60s
    this.latencyStatsTimer = setInterval(() => {
      this.logStats();
    }, 60_000);
  }

  /**
   * Process an audio chunk through the configured transcription backend.
   */
  async processChunk(chunk: AudioChunk): Promise<void> {
    if (this.destroyed) return;

    // Rate limit: don't queue too many concurrent requests
    if (this.pendingRequests >= this.MAX_CONCURRENT) {
      warn(TAG, `dropping chunk: ${this.pendingRequests} requests already pending`);
      return;
    }

    this.pendingRequests++;
    try {
      switch (this.config.backend) {
        case "openrouter":
          await this.transcribeViaOpenRouter(chunk);
          break;
        case "aws-gemini":
          await this.transcribeViaAwsGemini(chunk);
          break;
        case "whisper":
          warn(TAG, "whisper backend not yet implemented, falling back to openrouter");
          await this.transcribeViaOpenRouter(chunk);
          break;
      }
    } catch (err) {
      error(TAG, "transcription failed:", err instanceof Error ? err.message : err);
    } finally {
      this.pendingRequests--;
    }
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    this.destroyed = true;
    if (this.refineTimer) {
      clearInterval(this.refineTimer);
      this.refineTimer = null;
    }
    if (this.latencyStatsTimer) {
      clearInterval(this.latencyStatsTimer);
      this.latencyStatsTimer = null;
    }
    // Log final stats before destroying
    this.logStats();
    this.partialAccumulator = [];
    this.removeAllListeners();
    log(TAG, "destroyed");
  }

  /** Log P50/P95 transcription latency and cost stats */
  private logStats(): void {
    if (this.latencies.length === 0) return;

    const sorted = [...this.latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;

    log(TAG, `latency stats (n=${sorted.length}): p50=${Math.round(p50)}ms p95=${Math.round(p95)}ms avg=${Math.round(avg)}ms`);

    // Cost per audio-minute estimate (Gemini Flash pricing: ~$0.075/1M input tokens)
    if (this.totalAudioDurationMs > 0) {
      const audioMinutes = this.totalAudioDurationMs / 60_000;
      const costPerMToken = 0.075; // $/1M tokens for gemini-2.5-flash input
      const estimatedCost = (this.totalTokensConsumed / 1_000_000) * costPerMToken;
      const costPerMinute = audioMinutes > 0 ? estimatedCost / audioMinutes : 0;
      log(TAG, `cost stats: ${this.totalTokensConsumed} tokens, ${audioMinutes.toFixed(1)} audio-min, ~$${estimatedCost.toFixed(6)} total, ~$${costPerMinute.toFixed(6)}/audio-min`);
    }

    this.latencies = [];
  }

  // ── OpenRouter backend (MVP) ──

  /**
   * Send WAV audio to OpenRouter (Gemini) for transcription.
   * This is the simplest backend — no streaming, just send the whole chunk.
   */
  private async transcribeViaOpenRouter(chunk: AudioChunk): Promise<void> {
    if (!this.config.openrouterApiKey) {
      error(TAG, "OpenRouter API key not configured");
      return;
    }

    const base64Audio = chunk.buffer.toString("base64");
    const startTs = Date.now();

    log(TAG, `sending ${chunk.durationMs}ms chunk to OpenRouter (${Math.round(chunk.buffer.length / 1024)}KB)`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000); // 30s timeout

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
              {
                type: "input_audio",
                input_audio: {
                  data: base64Audio,
                  format: "wav",
                },
              },
              {
                type: "text",
                text: "Transcribe this audio. Output only the transcript text, nothing else.",
              },
            ],
          }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "(no body)");
        error(TAG, `OpenRouter error ${response.status}: ${body.slice(0, 300)}`);
        return;
      }

      const data = await response.json() as {
        choices?: Array<{
          message?: { content?: string };
        }>;
      };

      const text = data.choices?.[0]?.message?.content?.trim();
      const elapsed = Date.now() - startTs;

      this.latencies.push(elapsed);
      this.totalAudioDurationMs += chunk.durationMs;

      if (!text) {
        warn(TAG, `OpenRouter returned empty transcript (${elapsed}ms)`);
        return;
      }

      log(TAG, `transcript (${elapsed}ms): "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`);

      // Track tokens for cost estimation
      const usage = (data as any).usage;
      if (usage) {
        this.totalTokensConsumed += (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
      }

      const result: TranscriptResult = {
        text,
        source: "openrouter",
        refined: false,
        confidence: 0.8, // OpenRouter doesn't return confidence; use reasonable default
        ts: Date.now(),
      };

      this.emit("transcript", result);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        warn(TAG, "OpenRouter request timed out (30s)");
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── AWS + Gemini hybrid backend (future) ──

  /**
   * AWS Transcribe Streaming + Gemini refinement.
   *
   * Flow:
   * 1. Send audio to AWS Transcribe Streaming for fast partial results
   * 2. Accumulate partials into a window
   * 3. Every refineIntervalMs, send accumulated text to Gemini for cleanup
   *
   * Note: For MVP, falls back to OpenRouter if AWS creds aren't configured.
   */
  private async transcribeViaAwsGemini(chunk: AudioChunk): Promise<void> {
    if (!this.config.awsAccessKeyId || !this.config.awsSecretAccessKey) {
      // Fallback to OpenRouter if AWS isn't configured
      log(TAG, "AWS credentials not set, falling back to OpenRouter for this chunk");
      await this.transcribeViaOpenRouter(chunk);
      return;
    }

    // AWS Transcribe Streaming integration
    // This requires @aws-sdk/client-transcribe-streaming
    // For now, we emit a placeholder and accumulate for Gemini refinement
    try {
      const { TranscribeStreamingClient, StartStreamTranscriptionCommand } =
        await import("@aws-sdk/client-transcribe-streaming");

      const client = new TranscribeStreamingClient({
        region: this.config.awsRegion,
        credentials: {
          accessKeyId: this.config.awsAccessKeyId,
          secretAccessKey: this.config.awsSecretAccessKey,
        },
      });

      // Create an async iterable from the audio chunk
      async function* audioStream() {
        // Skip the 44-byte WAV header — AWS expects raw PCM
        const pcmData = chunk.buffer.subarray(44);
        const FRAME_SIZE = 4096;
        for (let offset = 0; offset < pcmData.length; offset += FRAME_SIZE) {
          const end = Math.min(offset + FRAME_SIZE, pcmData.length);
          yield { AudioEvent: { AudioChunk: pcmData.subarray(offset, end) } };
        }
      }

      const command = new StartStreamTranscriptionCommand({
        LanguageCode: this.config.language.replace("-", "-") as "en-US",
        MediaEncoding: "pcm",
        MediaSampleRateHertz: 16000,
        AudioStream: audioStream(),
      });

      const response = await client.send(command);
      const resultStream = response.TranscriptResultStream;

      if (resultStream) {
        for await (const event of resultStream) {
          if (event.TranscriptEvent?.Transcript?.Results) {
            for (const result of event.TranscriptEvent.Transcript.Results) {
              if (!result.IsPartial && result.Alternatives?.[0]?.Transcript) {
                const text = result.Alternatives[0].Transcript;
                log(TAG, `AWS final: "${text.slice(0, 100)}"`);

                // Accumulate for Gemini refinement
                this.partialAccumulator.push(text);

                // Emit raw AWS result immediately
                const awsResult: TranscriptResult = {
                  text,
                  source: "aws",
                  refined: false,
                  confidence: result.Alternatives[0].Items?.[0]?.Confidence ?? 0.9,
                  ts: Date.now(),
                };
                this.emit("transcript", awsResult);
              }
            }
          }
        }
      }
    } catch (err) {
      error(TAG, "AWS Transcribe error:", err instanceof Error ? err.message : err);
      // Fallback to OpenRouter on AWS failure
      log(TAG, "falling back to OpenRouter");
      await this.transcribeViaOpenRouter(chunk);
    }
  }

  /**
   * Gemini refinement: clean up accumulated AWS partials.
   * Called on a timer (refineIntervalMs).
   */
  private async refinePartials(): Promise<void> {
    if (this.partialAccumulator.length === 0) return;
    if (!this.config.openrouterApiKey) return;

    const rawText = this.partialAccumulator.join(" ");
    this.partialAccumulator = [];

    log(TAG, `refining ${rawText.length} chars via Gemini`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

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
            content: `Clean up this raw transcript. Fix grammar, remove filler words, preserve meaning. Output only the cleaned text.\n\n${rawText}`,
          }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        warn(TAG, `Gemini refinement error: ${response.status}`);
        return;
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const refined = data.choices?.[0]?.message?.content?.trim();
      if (!refined) return;

      log(TAG, `refined transcript: "${refined.slice(0, 100)}"`);

      const result: TranscriptResult = {
        text: refined,
        source: "gemini",
        refined: true,
        confidence: 0.9,
        ts: Date.now(),
      };

      this.emit("transcript", result);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        warn(TAG, "Gemini refinement timed out");
      } else {
        warn(TAG, "Gemini refinement failed:", err instanceof Error ? err.message : err);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
