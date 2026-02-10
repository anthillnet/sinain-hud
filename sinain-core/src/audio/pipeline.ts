import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { AudioPipelineConfig, AudioChunk } from "../types.js";
import type { Profiler } from "../profiler.js";
import { log, warn, error } from "../log.js";

const TAG = "audio";

/**
 * Creates a 44-byte WAV header for raw PCM data.
 * Format: PCM (1), 16-bit, mono/stereo, given sample rate.
 */
function createWavHeader(
  dataLength: number,
  sampleRate: number,
  channels: number,
  bitsPerSample: number = 16
): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8);

  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);

  return header;
}

/** Calculate RMS energy of 16-bit PCM samples (0.0 to 1.0). */
function calculateRmsEnergy(pcmData: Buffer): number {
  if (pcmData.length < 2) return 0;
  const sampleCount = Math.floor(pcmData.length / 2);
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = pcmData.readInt16LE(i * 2);
    const normalized = sample / 32768;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

/**
 * Audio capture pipeline.
 * Spawns sox or ffmpeg to capture audio from a macOS device,
 * accumulates raw PCM data, and emits WAV chunks at regular intervals.
 *
 * Events: 'chunk' (AudioChunk), 'started', 'stopped', 'error' (Error)
 */
export class AudioPipeline extends EventEmitter {
  private config: AudioPipelineConfig;
  private process: ChildProcess | null = null;
  private accumulator: Buffer[] = [];
  private accumulatedBytes: number = 0;
  private chunkTimer: ReturnType<typeof setInterval> | null = null;
  private running: boolean = false;
  private silentChunks: number = 0;
  private speechChunks: number = 0;
  private errorCount: number = 0;
  private profiler: Profiler | null = null;

  setProfiler(p: Profiler): void { this.profiler = p; }

  constructor(config: AudioPipelineConfig) {
    super();
    this.config = config;
  }

  start(): void {
    if (this.running) {
      warn(TAG, "already running, ignoring start()");
      return;
    }

    log(TAG, `starting capture: device=${this.config.device} cmd=${this.config.captureCommand} rate=${this.config.sampleRate}`);

    try {
      if (this.config.captureCommand === "sox") {
        this.startSox();
      } else {
        this.startFfmpeg();
      }
    } catch (err) {
      error(TAG, "failed to spawn capture process:", err);
      this.emit("error", err);
      return;
    }

    this.chunkTimer = setInterval(() => {
      this.emitChunk();
    }, this.config.chunkDurationMs);

    this.running = true;
    this.emit("started");
    log(TAG, "capture started");
  }

  stop(): void {
    if (!this.running) return;

    log(TAG, "stopping capture...");
    this.running = false;

    if (this.chunkTimer) {
      clearInterval(this.chunkTimer);
      this.chunkTimer = null;
    }

    if (this.process) {
      this.process.removeAllListeners();
      this.process.kill("SIGTERM");
      const proc = this.process;
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      }, 2000);
      this.process = null;
    }

    if (this.accumulatedBytes > 0) {
      this.emitChunk();
    }

    this.accumulator = [];
    this.accumulatedBytes = 0;
    this.emit("stopped");
    log(TAG, "capture stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  getDevice(): string {
    return this.config.device;
  }

  switchDevice(device: string): void {
    const wasRunning = this.running;
    if (wasRunning) this.stop();
    this.config = { ...this.config, device };
    log(TAG, `device switched to: ${device}`);
    if (wasRunning) this.start();
  }

  // ── sox capture ──

  private startSox(): void {
    const args = [
      "-t", "wav",
      "-r", String(this.config.sampleRate),
      "-c", String(this.config.channels),
      "-b", "16",
      "-",
    ];
    if (this.config.gainDb > 0) {
      args.push("gain", String(this.config.gainDb));
    }

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (this.config.device !== "default") {
      env["AUDIODEV"] = this.config.device;
    }

    log(TAG, `spawning: rec ${args.join(" ")}${this.config.device !== "default" ? ` (AUDIODEV=${this.config.device})` : ""}`);

    this.process = spawn("rec", args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.wireProcessEvents("sox");
  }

  // ── ffmpeg capture ──

  private startFfmpeg(): void {
    const deviceInput = this.config.device === "default"
      ? ":0"
      : `:${this.config.device}`;

    const args = [
      "-f", "avfoundation",
      "-i", deviceInput,
      "-ar", String(this.config.sampleRate),
      "-ac", String(this.config.channels),
      "-f", "s16le",
      "pipe:1",
    ];

    log(TAG, `spawning: ffmpeg ${args.join(" ")}`);

    this.process = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.wireProcessEvents("ffmpeg");
  }

  // ── Process event wiring ──

  private wireProcessEvents(name: string): void {
    const proc = this.process;
    if (!proc) return;

    let headerSkipped = name !== "sox";
    let headerBuf = Buffer.alloc(0);

    proc.stdout?.on("data", (data: Buffer) => {
      if (!this.running) return;

      if (!headerSkipped) {
        headerBuf = Buffer.concat([headerBuf, data]);
        if (headerBuf.length >= 44) {
          const remaining = headerBuf.subarray(44);
          headerSkipped = true;
          headerBuf = Buffer.alloc(0);
          if (remaining.length > 0) {
            this.accumulator.push(remaining);
            this.accumulatedBytes += remaining.length;
          }
        }
        return;
      }

      this.accumulator.push(data);
      this.accumulatedBytes += data.length;
      this.profiler?.gauge("audio.accumulatorKb", Math.round(this.accumulatedBytes / 1024));
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        log(TAG, `${name} stderr: ${msg.slice(0, 200)}`);
      }
    });

    proc.on("error", (err) => {
      error(TAG, `${name} process error:`, err.message);
      this.errorCount++;
      this.profiler?.gauge("audio.errors", this.errorCount);
      this.emit("error", new Error(`${name} process error: ${err.message}`));
      if (this.running) this.stop();
    });

    proc.on("exit", (code, signal) => {
      log(TAG, `${name} exited: code=${code} signal=${signal}`);
      if (this.running && code !== 0) {
        this.errorCount++;
        this.profiler?.gauge("audio.errors", this.errorCount);
        warn(TAG, `${name} exited unexpectedly, stopping pipeline`);
        this.stop();
      }
    });
  }

  // ── Chunk emission ──

  private emitChunk(): void {
    if (this.accumulatedBytes === 0) return;

    const pcmData = Buffer.concat(this.accumulator, this.accumulatedBytes);
    this.accumulator = [];
    this.accumulatedBytes = 0;

    const alignedLength = pcmData.length - (pcmData.length % 2);
    const alignedPcm = alignedLength < pcmData.length
      ? pcmData.subarray(0, alignedLength)
      : pcmData;

    if (alignedPcm.length === 0) return;

    const energy = calculateRmsEnergy(alignedPcm);
    this.profiler?.gauge("audio.lastChunkKb", Math.round(alignedPcm.length / 1024));

    if (this.config.vadEnabled && energy < this.config.vadThreshold) {
      this.silentChunks++;
      this.profiler?.gauge("audio.silentChunks", this.silentChunks);
      if (this.silentChunks === 1 || this.silentChunks % 6 === 0) {
        log(TAG, `VAD: silent (energy=${energy.toFixed(4)} < ${this.config.vadThreshold}), ${this.silentChunks} silent chunk(s)`);
      }
      return;
    }

    if (this.silentChunks > 0) {
      log(TAG, `VAD: speech detected after ${this.silentChunks} silent chunk(s) (energy=${energy.toFixed(4)})`);
      this.silentChunks = 0;
    }

    this.speechChunks++;
    this.profiler?.gauge("audio.speechChunks", this.speechChunks);

    const wavHeader = createWavHeader(alignedPcm.length, this.config.sampleRate, this.config.channels, 16);
    const wavBuffer = Buffer.concat([wavHeader, alignedPcm]);

    const bytesPerSample = 2 * this.config.channels;
    const sampleCount = alignedPcm.length / bytesPerSample;
    const durationMs = Math.round((sampleCount / this.config.sampleRate) * 1000);

    const chunk: AudioChunk = {
      buffer: wavBuffer,
      source: this.config.device,
      ts: Date.now(),
      durationMs,
      energy,
    };

    log(TAG, `chunk: ${durationMs}ms, ${wavBuffer.length} bytes, energy=${energy.toFixed(4)}`);
    this.emit("chunk", chunk);
  }
}
