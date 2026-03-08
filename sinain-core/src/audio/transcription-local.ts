import { spawn } from "node:child_process";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
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
}

/**
 * Local transcription via whisper.cpp CLI.
 *
 * Writes WAV chunk to a temp file, runs whisper-cli, parses stdout.
 * Fully isolated — does not touch the OpenRouter path.
 */
export class LocalTranscriptionBackend {
  private config: LocalTranscriptionConfig;
  private destroyed = false;

  constructor(config: LocalTranscriptionConfig) {
    this.config = config;
    log(TAG, `initialized: bin=${config.bin} model=${config.modelPath} lang=${config.language}`);
  }

  async transcribe(chunk: AudioChunk): Promise<TranscriptResult | null> {
    if (this.destroyed) return null;

    const tmpDir = await mkdtemp(join(tmpdir(), "sinain-whisper-"));
    const wavPath = join(tmpDir, "chunk.wav");

    try {
      await writeFile(wavPath, chunk.buffer);

      const startTs = Date.now();
      const text = await this.runWhisper(wavPath);
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
      return null;
    } finally {
      // Cleanup temp files
      await unlink(wavPath).catch(() => {});
      await unlink(tmpDir).catch(() => {});
    }
  }

  private runWhisper(wavPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        "-m", this.config.modelPath,
        "-f", wavPath,
        "--no-timestamps",
        "-l", this.config.language,
        "--print-progress", "false",
      ];

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
