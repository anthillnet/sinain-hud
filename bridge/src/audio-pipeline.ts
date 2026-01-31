import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { AudioPipelineConfig, AudioChunk } from "./types.js";
import { log, warn, error } from "./log.js";

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

  // RIFF header
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLength, 4); // file size - 8
  header.write("WAVE", 8);

  // fmt sub-chunk
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // sub-chunk size
  header.writeUInt16LE(1, 20); // audio format: PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);

  return header;
}

/**
 * Calculate RMS energy of 16-bit PCM samples.
 * Returns a value between 0.0 and 1.0.
 */
function calculateRmsEnergy(pcmData: Buffer): number {
  if (pcmData.length < 2) return 0;

  const sampleCount = Math.floor(pcmData.length / 2);
  let sumSquares = 0;

  for (let i = 0; i < sampleCount; i++) {
    const sample = pcmData.readInt16LE(i * 2);
    const normalized = sample / 32768; // normalize to [-1, 1]
    sumSquares += normalized * normalized;
  }

  return Math.sqrt(sumSquares / sampleCount);
}

/**
 * Audio capture pipeline.
 * Spawns sox or ffmpeg to capture audio from a macOS device,
 * accumulates raw PCM data, and emits WAV chunks at regular intervals.
 */
export class AudioPipeline extends EventEmitter {
  private config: AudioPipelineConfig;
  private process: ChildProcess | null = null;
  private accumulator: Buffer[] = [];
  private accumulatedBytes: number = 0;
  private chunkTimer: ReturnType<typeof setInterval> | null = null;
  private running: boolean = false;
  private silentChunks: number = 0;

  constructor(config: AudioPipelineConfig) {
    super();
    this.config = config;
  }

  /**
   * Start capturing audio from the configured device.
   * Spawns a child process (sox or ffmpeg) and begins accumulating PCM data.
   */
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

    // Set up chunk timer to slice accumulated audio every chunkDurationMs
    this.chunkTimer = setInterval(() => {
      this.emitChunk();
    }, this.config.chunkDurationMs);

    this.running = true;
    this.emit("started");
    log(TAG, "capture started");
  }

  /**
   * Stop the audio capture pipeline.
   * Kills the child process, clears timers, emits any remaining audio.
   */
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
      // sox responds to SIGTERM, ffmpeg to SIGINT then SIGTERM
      this.process.kill("SIGTERM");
      // Force-kill after 2s if still alive
      const proc = this.process;
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already dead
        }
      }, 2000);
      this.process = null;
    }

    // Emit any remaining accumulated audio
    if (this.accumulatedBytes > 0) {
      this.emitChunk();
    }

    this.accumulator = [];
    this.accumulatedBytes = 0;

    this.emit("stopped");
    log(TAG, "capture stopped");
  }

  /** Check if the pipeline is currently capturing audio. */
  isRunning(): boolean {
    return this.running;
  }

  /** Get the current capture device name. */
  getDevice(): string {
    return this.config.device;
  }

  /** Switch to a different audio device. Stops, reconfigures, and restarts if running. */
  switchDevice(device: string): void {
    const wasRunning = this.running;
    if (wasRunning) {
      this.stop();
    }
    this.config = { ...this.config, device };
    log(TAG, `device switched to: ${device}`);
    if (wasRunning) {
      this.start();
    }
  }

  // ── Private: sox capture ──

  private startSox(): void {
    const args = [
      "-t", "wav",      // output format
      "-r", String(this.config.sampleRate),
      "-c", String(this.config.channels),
      "-b", "16",        // 16-bit
      "-",               // output to stdout
    ];

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

  // ── Private: ffmpeg capture ──

  private startFfmpeg(): void {
    const deviceInput = this.config.device === "default"
      ? ":0"
      : `:${this.config.device}`;

    const args = [
      "-f", "avfoundation",
      "-i", deviceInput,
      "-ar", String(this.config.sampleRate),
      "-ac", String(this.config.channels),
      "-f", "s16le",     // raw PCM 16-bit little-endian
      "pipe:1",          // output to stdout
    ];

    log(TAG, `spawning: ffmpeg ${args.join(" ")}`);

    this.process = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.wireProcessEvents("ffmpeg");
  }

  // ── Private: process event wiring ──

  private wireProcessEvents(name: string): void {
    const proc = this.process;
    if (!proc) return;

    // For sox, stdout starts with a 44-byte WAV header we need to skip.
    // For ffmpeg with -f s16le, stdout is raw PCM (no header).
    let headerSkipped = name !== "sox";
    let headerBuf = Buffer.alloc(0);

    proc.stdout?.on("data", (data: Buffer) => {
      if (!this.running) return;

      if (!headerSkipped) {
        // Accumulate until we have at least 44 bytes, then skip the WAV header
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
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        // sox and ffmpeg both write status/progress to stderr — log but don't treat as error
        log(TAG, `${name} stderr: ${msg.slice(0, 200)}`);
      }
    });

    proc.on("error", (err) => {
      error(TAG, `${name} process error:`, err.message);
      this.emit("error", new Error(`${name} process error: ${err.message}`));
      if (this.running) {
        this.stop();
      }
    });

    proc.on("exit", (code, signal) => {
      log(TAG, `${name} exited: code=${code} signal=${signal}`);
      if (this.running && code !== 0) {
        warn(TAG, `${name} exited unexpectedly, stopping pipeline`);
        this.stop();
      }
    });
  }

  // ── Private: chunk emission ──

  private emitChunk(): void {
    if (this.accumulatedBytes === 0) return;

    // Concatenate all accumulated buffers into one PCM block
    const pcmData = Buffer.concat(this.accumulator, this.accumulatedBytes);
    this.accumulator = [];
    this.accumulatedBytes = 0;

    // Ensure even byte count (16-bit samples = 2 bytes each)
    const alignedLength = pcmData.length - (pcmData.length % 2);
    const alignedPcm = alignedLength < pcmData.length
      ? pcmData.subarray(0, alignedLength)
      : pcmData;

    if (alignedPcm.length === 0) return;

    // Calculate RMS energy for VAD
    const energy = calculateRmsEnergy(alignedPcm);

    // VAD: skip silent chunks
    if (this.config.vadEnabled && energy < this.config.vadThreshold) {
      this.silentChunks++;
      if (this.silentChunks === 1 || this.silentChunks % 6 === 0) {
        log(TAG, `VAD: silent (energy=${energy.toFixed(4)} < ${this.config.vadThreshold}), ${this.silentChunks} silent chunk(s) so far`);
      }
      return;
    }

    // Log when speech resumes after silence
    if (this.silentChunks > 0) {
      log(TAG, `VAD: speech detected after ${this.silentChunks} silent chunk(s) (energy=${energy.toFixed(4)})`);
      this.silentChunks = 0;
    }

    // Create WAV header and prepend to PCM data
    const wavHeader = createWavHeader(
      alignedPcm.length,
      this.config.sampleRate,
      this.config.channels,
      16
    );
    const wavBuffer = Buffer.concat([wavHeader, alignedPcm]);

    // Calculate actual duration from PCM data size
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
