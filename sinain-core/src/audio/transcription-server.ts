import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { AudioChunk, TranscriptResult } from "../types.js";
import { log, warn, error, debug } from "../log.js";
import { LocalTranscriptionBackend, composeWhisperPrompt, type LocalTranscriptionConfig, type TranscriptionBackend } from "./transcription-local.js";

const TAG = "transcribe-server";

/**
 * Local transcription via a persistent whisper.cpp **server** (whisper-server).
 *
 * The CLI backend re-spawns whisper-cli per chunk, reloading the GGUF model
 * every time. This keeps one model-resident server and POSTs each WAV chunk to
 * its /inference endpoint — no per-chunk reload, lower latency, and the
 * substrate for streaming later.
 *
 * Robustness:
 *  - Reuses an already-listening server on the port (so tsx reloads / multiple
 *    runs share one resident model instead of fighting for it).
 *  - If the server can't start (binary missing, bind failure), transparently
 *    falls back to the per-chunk whisper-cli backend — never silently dead.
 *  - Restarts the server on connection failure.
 */
export class WhisperServerBackend implements TranscriptionBackend {
  private config: LocalTranscriptionConfig;
  private readonly bin: string;
  private readonly host = "127.0.0.1";
  private readonly port: number;
  private readonly lang: string;
  private readonly threads: number;
  private proc: ChildProcess | null = null;
  private spawnedByUs = false;
  private ready = false;
  private starting: Promise<boolean> | null = null;
  private destroyed = false;
  private fallback: LocalTranscriptionBackend | null = null;

  constructor(config: LocalTranscriptionConfig) {
    this.config = config;
    this.bin = process.env.LOCAL_WHISPER_SERVER_BIN
      || config.bin.replace(/whisper-cli$/, "whisper-server")
      || "whisper-server";
    this.port = Number(process.env.LOCAL_WHISPER_SERVER_PORT) || 8910;
    this.lang = (config.language || "auto").split("-")[0].toLowerCase();
    this.threads = Number(process.env.LOCAL_WHISPER_THREADS) || 4;
    log(TAG, `init: bin=${this.bin} model=${config.modelPath} port=${this.port} lang=${this.lang}`);
    // Kick off startup eagerly so the model is warm before the first chunk.
    void this.ensureStarted();
  }

  private get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  private async probe(timeoutMs = 800): Promise<boolean> {
    try {
      await fetch(`${this.baseUrl}/`, { signal: AbortSignal.timeout(timeoutMs) });
      return true; // any HTTP response means the server is up
    } catch {
      return false;
    }
  }

  private ensureStarted(): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    if (!this.starting) this.starting = this.startServer();
    return this.starting;
  }

  private async startServer(): Promise<boolean> {
    // Reuse a server already listening (another core instance / prior reload).
    if (await this.probe()) {
      log(TAG, `reusing whisper-server already on ${this.baseUrl}`);
      this.ready = true;
      return true;
    }

    const args = [
      "-m", this.config.modelPath,
      "--host", this.host,
      "--port", String(this.port),
      "-l", this.lang,
      "-nt",                       // no timestamps
      "-t", String(this.threads),
    ];
    debug(TAG, `spawn: ${this.bin} ${args.join(" ")}`);
    try {
      this.proc = spawn(this.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      this.spawnedByUs = true;
    } catch (err) {
      warn(TAG, `spawn failed: ${err instanceof Error ? err.message : err}`);
      return this.degradeToFallback();
    }

    this.proc.stderr?.on("data", (d: Buffer) => {
      const m = d.toString().trim();
      if (/error|failed|bind/i.test(m)) warn(TAG, `server: ${m.slice(0, 160)}`);
    });
    this.proc.on("exit", (code, signal) => {
      this.ready = false;
      this.proc = null;
      this.starting = null;
      if (!this.destroyed) warn(TAG, `whisper-server exited (code=${code} signal=${signal}) — will restart on next chunk`);
    });
    this.proc.on("error", (err) => {
      warn(TAG, `server process error: ${err.message}`);
      this.ready = false;
    });

    // Wait for it to bind + load the model (large-v3-turbo ≈ 1-3s on Metal).
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !this.destroyed) {
      if (await this.probe(1000)) {
        this.ready = true;
        log(TAG, `whisper-server ready on ${this.baseUrl}`);
        return true;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    warn(TAG, "whisper-server did not become ready in 20s");
    return this.degradeToFallback();
  }

  /** Spin up the per-chunk CLI backend as a safety net. */
  private degradeToFallback(): boolean {
    if (!this.fallback) {
      warn(TAG, "falling back to per-chunk whisper-cli (set LOCAL_WHISPER_SERVER=false to silence)");
      this.fallback = new LocalTranscriptionBackend(this.config);
    }
    return false;
  }

  async transcribe(chunk: AudioChunk, contextPrompt?: string): Promise<TranscriptResult | null> {
    if (this.destroyed) return null;
    const up = await this.ensureStarted();
    if (!up) return this.fallback!.transcribe(chunk, contextPrompt);

    const startTs = Date.now();
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(chunk.buffer)], { type: "audio/wav" }), "chunk.wav");
      form.append("response_format", "json");
      form.append("language", this.lang);
      // Hotwords + recent rolling context (A2) — same intent as whisper-cli --prompt.
      const prompt = composeWhisperPrompt(this.config.initialPrompt, contextPrompt);
      if (prompt) form.append("prompt", prompt);

      const res = await fetch(`${this.baseUrl}${process.env.LOCAL_WHISPER_SERVER_PATH || "/inference"}`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!res.ok) {
        warn(TAG, `inference HTTP ${res.status}`);
        return null;
      }
      const data = (await res.json()) as { text?: string };
      const text = (data.text || "").trim();
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
      // Connection dropped → flag for restart and let this chunk go.
      this.ready = false;
      this.starting = null;
      error(TAG, `inference failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.fallback?.destroy();
    // Only stop a server we own; a reused one may serve other instances.
    if (this.proc && this.spawnedByUs) {
      const p = this.proc;
      p.kill("SIGTERM");
      setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } }, 1500);
    }
    this.proc = null;
    log(TAG, "destroyed");
  }
}
