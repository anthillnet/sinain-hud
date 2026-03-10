import type { AudioChunk, TranscriptResult } from "../types.js";
import type { TranscriptionBackend } from "./transcription-backend.js";
import { log, warn, error, debug } from "../log.js";

const TAG = "transcribe-openrouter";

/** ISO 639-1 code → human-readable name (extend as needed) */
const LANG_NAMES: Record<string, string> = {
  en: "English", ru: "Russian", uk: "Ukrainian", de: "German",
  fr: "French", es: "Spanish", pt: "Portuguese", it: "Italian",
  zh: "Chinese", ja: "Japanese", ko: "Korean", ar: "Arabic",
  hi: "Hindi", tr: "Turkish", pl: "Polish", nl: "Dutch",
};

function nameForCode(code: string): string {
  return LANG_NAMES[code] || code;
}

export interface OpenRouterTranscriptionConfig {
  openrouterApiKey: string;
  geminiModel: string;
  language: string;
  languages: string[];
}

/**
 * Transcription via OpenRouter (Gemini) API.
 * Sends base64-encoded WAV audio and returns transcript text.
 */
export class OpenRouterTranscriptionBackend implements TranscriptionBackend {
  private config: OpenRouterTranscriptionConfig;
  private destroyed = false;
  private totalTokensConsumed = 0;

  constructor(config: OpenRouterTranscriptionConfig) {
    this.config = config;
    log(TAG, `initialized: model=${config.geminiModel} language=${config.language}`);
  }

  getTokensConsumed(): number {
    return this.totalTokensConsumed;
  }

  async transcribe(chunk: AudioChunk): Promise<TranscriptResult | null> {
    if (this.destroyed) return null;

    if (!this.config.openrouterApiKey) {
      error(TAG, "OpenRouter API key not configured");
      throw new Error("OpenRouter API key not configured");
    }

    const base64Audio = chunk.buffer.toString("base64");

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
              { type: "text", text: this.config.languages.length > 1
                ? `Transcribe this audio. The speaker may use ${this.config.languages.map(nameForCode).join(" or ")}. Output ONLY the transcript text, nothing else. If no speech is detected, output an empty string.`
                : `Transcribe this audio in ${nameForCode(this.config.languages[0])}. Output ONLY the transcript text, nothing else. If no speech is detected, output an empty string.` },
            ],
          }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "(no body)");
        error(TAG, `OpenRouter error ${response.status}: ${body.slice(0, 300)}`);
        throw new Error(`OpenRouter error ${response.status}`);
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const text = data.choices?.[0]?.message?.content?.trim();

      if (!text) {
        warn(TAG, "OpenRouter returned empty transcript");
        return null;
      }

      if (data.usage) {
        this.totalTokensConsumed += (data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0);
      }

      log(TAG, `transcript: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`);

      return {
        text,
        source: "openrouter",
        refined: false,
        confidence: 0.8,
        ts: Date.now(),
        audioSource: chunk.audioSource,
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        warn(TAG, "OpenRouter request timed out (30s)");
        throw new Error("OpenRouter request timed out (30s)");
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  destroy(): void {
    this.destroyed = true;
    log(TAG, "destroyed");
  }
}
