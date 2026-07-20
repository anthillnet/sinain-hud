import { spawn } from "node:child_process";
import { writeFile, unlink, rmdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AudioChunk, TranscriptResult } from "../types.js";
import { log, warn, error, debug } from "../log.js";

const TAG = "transcribe-local";

export interface LocalTranscriptionConfig {
  /** Path to whisper-cpp binary (default: "whisper-cli") */
  bin: string;
  /** Path to GGUF model file */
  modelPath: string;
  /** Language code, e.g. "en", "ru" (default: "en") */
  language: string;
  /** Timeout per chunk in ms (default: 15000) */
  timeoutMs: number;
  noSpeechMax: number;
  logprobMin: number;
  /**
   * Optional hotword/entity hint passed to whisper-cli's --prompt flag.
   * Biases the model toward preserving these proper nouns rather than
   * substituting phonetic neighbors (Jibran → Jet Brain, Citibank →
   * City Bank). Modeled after Whisper's documented initial-prompt
   * conditioning behavior.
   */
  initialPrompt?: string;
}

/** Common shape for local transcription backends (CLI spawn or persistent
 *  server) so TranscriptionService can hold either behind one field.
 *  contextPrompt is the recent rolling transcript (A2) — passed as whisper's
 *  prompt for cross-segment continuity. */
export interface TranscriptionBackend {
  transcribe(chunk: AudioChunk, contextPrompt?: string): Promise<TranscriptResult | null>;
  destroy(): void;
}

/** Combine static hotwords with the recent rolling context into one whisper
 *  prompt, keeping the most recent tail within whisper's ~224-token budget
 *  (recent context sits LAST, adjacent to the audio it precedes). */
export function composeWhisperPrompt(hotwords?: string, context?: string): string | undefined {
  const combined = [hotwords?.trim(), context?.trim()].filter(Boolean).join(" ");
  if (!combined) return undefined;
  return combined.slice(-220);
}

/**
 * Local transcription via whisper.cpp CLI.
 *
 * Writes WAV chunk to a temp file, runs whisper-cli, parses stdout.
 * Fully isolated — does not touch the OpenRouter path.
 */
export class LocalTranscriptionBackend implements TranscriptionBackend {
  private config: LocalTranscriptionConfig;
  private destroyed = false;

  constructor(config: LocalTranscriptionConfig) {
    this.config = config;
    log(TAG, `initialized: bin=${config.bin} model=${config.modelPath} lang=${config.language}`);
  }

  async transcribe(chunk: AudioChunk, contextPrompt?: string): Promise<TranscriptResult | null> {
    if (this.destroyed) return null;

    const tmpDir = await mkdtemp(join(tmpdir(), "sinain-whisper-"));
    const wavPath = join(tmpDir, "chunk.wav");

    try {
      await writeFile(wavPath, chunk.buffer);

      const startTs = Date.now();
      const text = await this.runWhisper(wavPath, composeWhisperPrompt(this.config.initialPrompt, contextPrompt));
      const elapsed = Date.now() - startTs;

      if (!text) {
        debug(TAG, `empty result (${elapsed}ms)`);
        return null;
      }

      log(TAG, `transcript (${elapsed}ms): "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`);

      return {
        text,
        source: "whisper",
        refined: false,
        confidence: 0.85,
        ts: Date.now(),
        audioSource: chunk.audioSource,
      };
    } catch (err) {
      error(TAG, "local transcription failed:", err instanceof Error ? err.message : err);
      throw err;
    } finally {
      // Cleanup temp files
      await unlink(wavPath).catch(() => {});
      await rmdir(tmpDir).catch(() => {});
    }
  }

  private runWhisper(wavPath: string, prompt?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // whisper-cli expects ISO 639-1 codes ("en"), not BCP-47 ("en-US")
      const lang = this.config.language.split("-")[0].toLowerCase();
      const args = [
        "-m", this.config.modelPath,
        "-f", wavPath,
        "--no-timestamps",
        "-l", lang,
        "-np",
      ];
      // language="auto" → whisper autodetects spoken language and transcribes
      // in source (Russian audio → Russian transcript). We deliberately do
      // NOT pass -tr (translate-to-English): the ggml-large-v3-turbo model
      // doesn't support translation (verified 2026-05-28 — -tr was a no-op).
      // The downstream distiller (gemini-2.5-flash) is multilingual and
      // produces an English digest from a Russian transcript, preserving
      // entity names better than asking gemini-audio to translate directly
      // (gemini-audio dropped "raccoon/енот" entirely; whisper retains it
      // in Cyrillic for the distiller to preserve).
      if (prompt && prompt.trim()) {
        // Whisper-cli's --prompt biases recognition toward this text (hotwords
        // + recent rolling context). Capped at 200 chars — whisper truncates
        // beyond that and the bias flattens with longer prompts.
        args.push("--prompt", prompt.slice(0, 200));
      }

      debug(TAG, `exec: ${this.config.bin} ${args.join(" ")}`);

      const proc = spawn(this.config.bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error(`whisper-cpp timed out after ${this.config.timeoutMs}ms`));
      }, this.config.timeoutMs);

      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`whisper-cpp spawn error: ${err.message}`));
      });

      proc.on("close", (code) => {
        clearTimeout(timer);

        // whisper-cli may print errors to stderr but still exit 0
        if (stderr.includes("unknown language") || stderr.includes("error:")) {
          const msg = stderr.trim().slice(0, 300);
          reject(new Error(`whisper-cpp stderr: ${msg}`));
          return;
        }

        if (code !== 0) {
          const msg = stderr.trim().slice(0, 300) || `exit code ${code}`;
          reject(new Error(`whisper-cpp failed: ${msg}`));
          return;
        }

        // whisper-cpp outputs lines like "  [text]" — strip whitespace and join
        const text = stdout
          .split("\n")
          .map(l => l.trim())
          .filter(l => l.length > 0 && !l.startsWith("["))
          .join(" ")
          .trim();

        resolve(text);
      });
    });
  }

  destroy(): void {
    this.destroyed = true;
    log(TAG, "destroyed");
  }
}
