import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { AudioPipelineConfig, AudioChunk, AudioSourceTag } from "../types.js";
import type { CaptureSpawner } from "./capture-spawner.js";
import type { Profiler } from "../profiler.js";
import { log, warn, error, debug } from "../log.js";

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
 * Events: 'chunk' (AudioChunk), 'started', 'stopped', 'muted', 'unmuted', 'error' (Error)
 */
/**
 * Pre-allocated buffer size for audio accumulation.
 * 320KB is sufficient for 5s of 16-bit mono audio at 16kHz (160KB)
 * with 2x headroom for stereo or higher sample rates.
 */
const PREALLOC_BUFFER_SIZE = 320 * 1024;

// ── VAD endpointing ──
// Segment audio on SILENCE boundaries (end of an utterance) instead of a fixed
// wall-clock timer — so chunks are cut at natural pauses, never mid-word. A
// frame-level energy VAD with an adaptive noise floor decides speech/silence;
// after speech, a run of silence ≥ hangover ends the utterance and emits it.
// Pure JS (no model dependency). Tunable via env.
const VAD_FRAME_MS = 30;                                                        // analysis frame size
const VAD_HANGOVER_MS = Number(process.env.AUDIO_VAD_HANGOVER_MS) || 700;       // trailing silence that ends an utterance
const VAD_MAX_SEGMENT_MS = Number(process.env.AUDIO_MAX_SEGMENT_MS) || 18000;   // force-cut a long monologue
const VAD_MIN_SEGMENT_MS = Number(process.env.AUDIO_MIN_SEGMENT_MS) || 300;     // drop blips (clicks / coughs)
const VAD_PREROLL_MS = Number(process.env.AUDIO_PREROLL_MS) || 300;             // lead-in kept before speech onset
const VAD_SPEECH_FACTOR = Number(process.env.AUDIO_VAD_SPEECH_FACTOR) || 3.5;   // speech = energy > noiseFloor × this
// Normalized 16-bit PCM RMS (0.0–1.0); 0.0005 is about -66 dBFS, below quiet speech.
const VAD_MIN_RMS = Number(process.env.VAD_MIN_RMS) || 0.0005;

export class AudioPipeline extends EventEmitter {
  private config: AudioPipelineConfig;
  private audioSourceTag: AudioSourceTag;
  private captureSpawner: CaptureSpawner;
  private process: ChildProcess | null = null;
  // Pre-allocated buffer to reduce GC pressure (vs Buffer.concat per chunk)
  private preallocBuffer: Buffer = Buffer.allocUnsafe(PREALLOC_BUFFER_SIZE);
  private bufferWriteOffset: number = 0;
  private running: boolean = false;

  // ── VAD endpointing state ──
  private gainMult: number = 1;                         // precomputed from gainDb
  private frameBytes: number = 960;                     // VAD_FRAME_MS at the configured rate
  private preRollBytes: number = 9600;                  // VAD_PREROLL_MS of audio
  private preRoll: Buffer = Buffer.allocUnsafe(9600);   // sliding lead-in ring
  private preRollLen: number = 0;
  private frameLeftover: Buffer = Buffer.alloc(0);      // partial frame carried between data events
  private inUtterance: boolean = false;
  private trailingSilenceMs: number = 0;
  private noiseFloor: number = 0;                       // adaptive energy floor
  private silentChunks: number = 0;
  private speechChunks: number = 0;
  private errorCount: number = 0;
  private muted: boolean = false;
  /** Set after a stale capture binary rejects a newer flag ("Unknown arg") —
   *  the next spawn drops the optional flags so capture launches anyway. */
  private sckCompat: boolean = false;
  private profiler: Profiler | null = null;

  setProfiler(p: Profiler): void { this.profiler = p; }

  constructor(config: AudioPipelineConfig, audioSourceTag: AudioSourceTag = "system", captureSpawner?: CaptureSpawner) {
    super();
    this.config = config;
    this.audioSourceTag = audioSourceTag;
    // If no spawner provided, lazily import the platform default
    this.captureSpawner = captureSpawner!;
  }

  start(): void {
    if (this.running) {
      warn(TAG, "already running, ignoring start()");
      return;
    }

    log(TAG, `starting capture: device=${this.config.device} cmd=${this.config.captureCommand} rate=${this.config.sampleRate}${this.config.gainDb ? ` gain=${this.config.gainDb}dB` : ""}`);

    try {
      this.spawnCaptureProcess();
    } catch (err) {
      error(TAG, "failed to spawn capture process:", err);
      this.emit("error", err);
      return;
    }

    this.muted = false;
    // Precompute VAD framing for the configured rate/channels + gain.
    this.gainMult = this.config.gainDb ? Math.pow(10, this.config.gainDb / 20) : 1;
    const bytesPerMs = (this.config.sampleRate * this.config.channels * 2) / 1000;
    this.frameBytes = Math.max(2, Math.round(bytesPerMs * VAD_FRAME_MS));
    this.preRollBytes = Math.max(this.frameBytes, Math.round(bytesPerMs * VAD_PREROLL_MS));
    this.preRoll = Buffer.allocUnsafe(this.preRollBytes);
    this.resetVadState();

    this.running = true;
    this.emit("started");
    log(TAG, "capture started");
  }

  stop(): void {
    if (!this.running) return;

    log(TAG, "stopping capture...");
    this.running = false;
    this.muted = false;

    if (this.process) {
      this.process.removeAllListeners();
      this.process.kill("SIGTERM");
      const proc = this.process;
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      }, 2000);
      this.process = null;
    }

    if (this.inUtterance) {
      this.flushUtterance(true);  // emit whatever speech was in flight
    }

    this.resetVadState();
    this.emit("stopped");
    log(TAG, "capture stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  mute(): void {
    if (!this.running || this.muted) return;
    this.muted = true;
    this.resetVadState();
    log(TAG, `muted (${this.config.captureCommand} process still running)`);
    this.emit("muted");
  }

  unmute(): void {
    if (!this.running || !this.muted) return;
    this.muted = false;
    log(TAG, "unmuted");
    this.emit("unmuted");
  }

  isMuted(): boolean {
    return this.muted;
  }

  getDevice(): string {
    return this.config.device;
  }

  getCaptureCommand(): "sox" | "ffmpeg" | "screencapturekit" {
    return this.config.captureCommand;
  }

  switchDevice(device: string): void {
    const wasRunning = this.running;
    if (wasRunning) this.stop();
    this.config = { ...this.config, device };
    log(TAG, `device switched to: ${device}`);
    if (wasRunning) this.start();
  }

  // ── Capture process spawn (platform-dispatched via CaptureSpawner) ──

  private spawnCaptureProcess(): void {
    this.process = this.captureSpawner.spawn(this.config, this.audioSourceTag, { compat: this.sckCompat });
    const name = process.platform === "win32" ? "win-audio-capture" : "sck-capture";
    this.wireProcessEvents(name);
  }

  // ── Process event wiring ──

  private wireProcessEvents(name: string): void {
    const proc = this.process;
    if (!proc) return;

    let headerSkipped = name !== "sox";
    let headerBuf = Buffer.alloc(0);
    let stderrAccum = "";
    const spawnTime = Date.now();

    proc.stdout?.on("data", (data: Buffer) => {
      if (!this.running) return;

      if (!headerSkipped) {
        headerBuf = Buffer.concat([headerBuf, data]);
        if (headerBuf.length >= 44) {
          const remaining = headerBuf.subarray(44);
          headerSkipped = true;
          headerBuf = Buffer.alloc(0);
          if (remaining.length > 0) {
            this.feedAudio(remaining);
          }
        }
        return;
      }

      this.feedAudio(data);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg && !/^In:.*Out:/.test(msg)) {
        log(TAG, `${name} stderr: ${msg.slice(0, 200)}`);
      }
      // Accumulate stderr for TCC detection on exit
      stderrAccum += data.toString();
      // Cap accumulation to avoid unbounded growth (4KB is enough for any TCC message)
      if (stderrAccum.length > 4096) {
        stderrAccum = stderrAccum.slice(-4096);
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

        // Detect TCC (macOS Screen Recording / Microphone) permission denial.
        // sck-capture logs "declined TCCs" to stderr when the entitlement is
        // missing. The chicken-and-egg: clicking "Allow" on the prompt doesn't
        // apply to a running process. We print a prominent banner, stop just the
        // audio pipeline, and let the rest of sinain continue so the overlay can
        // show the permission warning.
        const elapsedMs = Date.now() - spawnTime;
        const isTccDenial = stderrAccum.includes("declined TCCs");
        if (isTccDenial && elapsedMs < 5000) {
          process.stdout.write([
            "",
            "=======================================================================",
            "  WARNING: Screen Recording permission needed",
            "=======================================================================",
            "",
            "  sck-capture cannot access screen capture and audio without",
            "  TCC (Screen Recording) permission from macOS.",
            "",
            "  Sinain will keep running with system audio muted.",
            "",
            "  If you just clicked Allow -- that is normal! macOS does not apply",
            "  the permission to processes that are already running. To enable audio:",
            "",
            "    1. Quit and restart your Terminal app (Cmd+Q, then reopen)",
            "    2. Start sinain again, or toggle audio from the HUD",
            "",
            "  Already declined? Re-grant permission:",
            "    System Settings > Privacy & Security > Screen Recording",
            "    > enable Terminal (or your terminal app)",
            "",
            "=======================================================================",
            "",
          ].join("\n"));

          this.stop();
          this.emit("tcc-denied");
          return;
        }

        // Version skew: a stale sck-capture binary rejects a newer flag and
        // exits immediately. Retry once in compat mode (drops the optional
        // flags) so capture works instead of dying — self-heals mixed-version
        // installs (new core + old sck-capture binary).
        if (!this.sckCompat && elapsedMs < 5000 && /unknown arg/i.test(stderrAccum)) {
          this.sckCompat = true;
          warn(TAG, `${name} rejected a flag (stale binary) — retrying without optional flags. Update it: npx @geravant/sinain setup-sck-capture`);
          this.spawnCaptureProcess();
          return;
        }

        warn(TAG, `${name} exited unexpectedly, stopping pipeline`);
        this.stop();
      }
    });
  }

  // ── Buffer management ──

  /**
   * Write data to pre-allocated buffer.
   * Falls back to growing buffer if needed (rare case for very long audio).
   */
  private writeToBuffer(data: Buffer): void {
    if (this.muted) return;
    // Check if we need to grow the buffer (rare case)
    if (this.bufferWriteOffset + data.length > this.preallocBuffer.length) {
      // Grow to 2x current size
      const newSize = Math.max(this.preallocBuffer.length * 2, this.bufferWriteOffset + data.length);
      const newBuffer = Buffer.allocUnsafe(newSize);
      this.preallocBuffer.copy(newBuffer, 0, 0, this.bufferWriteOffset);
      this.preallocBuffer = newBuffer;
    }

    data.copy(this.preallocBuffer, this.bufferWriteOffset);
    this.bufferWriteOffset += data.length;
    this.profiler?.gauge("audio.accumulatorKb", Math.round(this.bufferWriteOffset / 1024));
  }

  // ── VAD endpointing ──

  private resetVadState(): void {
    this.bufferWriteOffset = 0;
    this.preRollLen = 0;
    this.frameLeftover = Buffer.alloc(0);
    this.inUtterance = false;
    this.trailingSilenceMs = 0;
    this.noiseFloor = 0;
  }

  private bytesToMs(bytes: number): number {
    const bytesPerSample = 2 * this.config.channels;
    return Math.round((bytes / bytesPerSample / this.config.sampleRate) * 1000);
  }

  /** Apply gain in-place and return the frame's RMS energy (0..1). */
  private gainAndEnergy(frame: Buffer): number {
    const n = frame.length >> 1;
    if (n === 0) return 0;
    const mult = this.gainMult;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const off = i << 1;
      let s = frame.readInt16LE(off);
      if (mult !== 1) {
        s = Math.max(-32768, Math.min(32767, Math.round(s * mult)));
        frame.writeInt16LE(s, off);
      }
      const norm = s / 32768;
      sum += norm * norm;
    }
    return Math.sqrt(sum / n);
  }

  /** Slide a frame into the pre-roll ring (last VAD_PREROLL_MS of audio). */
  private pushPreRoll(frame: Buffer): void {
    const fb = frame.length;
    if (fb >= this.preRollBytes) {
      frame.copy(this.preRoll, 0, fb - this.preRollBytes);
      this.preRollLen = this.preRollBytes;
      return;
    }
    if (this.preRollLen + fb > this.preRollBytes) {
      const drop = this.preRollLen + fb - this.preRollBytes;
      this.preRoll.copy(this.preRoll, 0, drop, this.preRollLen);  // shift oldest out
      this.preRollLen -= drop;
    }
    frame.copy(this.preRoll, this.preRollLen);
    this.preRollLen += fb;
  }

  /**
   * Feed raw PCM through the VAD state machine. Frames are classified
   * speech/silence against an adaptive noise floor; speech accumulates into the
   * current utterance (with a pre-roll lead-in), and a hangover of silence — or
   * the max-segment cap — flushes it as a chunk. Replaces fixed-timer chunking.
   */
  private feedAudio(data: Buffer): void {
    if (!this.running || this.muted) return;
    const buf = this.frameLeftover.length ? Buffer.concat([this.frameLeftover, data]) : data;
    const fb = this.frameBytes;
    const nFrames = Math.floor(buf.length / fb);
    this.frameLeftover = Buffer.from(buf.subarray(nFrames * fb)); // carry partial frame
    for (let f = 0; f < nFrames; f++) {
      const frame = buf.subarray(f * fb, (f + 1) * fb);
      const energy = this.gainAndEnergy(frame); // mutates frame to apply gain
      // Track the noise floor as the running MINIMUM energy: snap down instantly
      // to any new quiet (true silence/room tone), creep up slowly so it adapts
      // to rising ambient. This works at any absolute level — speech then reads
      // as energy a few× above the floor, independent of gain/source loudness.
      if (this.noiseFloor === 0 || energy < this.noiseFloor) {
        this.noiseFloor = energy;
      } else {
        this.noiseFloor += (energy - this.noiseFloor) * 0.0005;
      }
      // Speech = clearly above the floor, but never below the configured minimum.
      const threshold = Math.max(this.config.vadThreshold, this.noiseFloor * VAD_SPEECH_FACTOR, VAD_MIN_RMS);
      const isSpeech = !this.config.vadEnabled || energy >= threshold;
      this.processFrame(frame, isSpeech);
    }
  }

  private processFrame(frame: Buffer, isSpeech: boolean): void {
    if (isSpeech) {
      if (!this.inUtterance) {
        this.inUtterance = true;
        this.trailingSilenceMs = 0;
        // Prepend the pre-roll so the utterance onset isn't clipped.
        if (this.preRollLen > 0) this.writeToBuffer(this.preRoll.subarray(0, this.preRollLen));
        this.preRollLen = 0;
      }
      this.writeToBuffer(frame);
      this.trailingSilenceMs = 0;
    } else if (this.inUtterance) {
      this.writeToBuffer(frame); // keep short trailing silence inside the segment
      this.trailingSilenceMs += VAD_FRAME_MS;
      if (this.trailingSilenceMs >= VAD_HANGOVER_MS) {
        this.flushUtterance();
        return;
      }
    } else {
      this.silentChunks++;
      this.pushPreRoll(frame);
    }
    if (this.inUtterance && this.bytesToMs(this.bufferWriteOffset) >= VAD_MAX_SEGMENT_MS) {
      this.flushUtterance(true);
    }
  }

  /** Emit the accumulated utterance as a WAV chunk (PCM is already gain-applied). */
  private flushUtterance(forced = false): void {
    const bytes = this.bufferWriteOffset;
    this.bufferWriteOffset = 0;
    this.inUtterance = false;
    this.trailingSilenceMs = 0;
    const aligned = bytes - (bytes % 2);
    if (aligned === 0) return;

    const durationMs = this.bytesToMs(aligned);
    if (durationMs < VAD_MIN_SEGMENT_MS) {
      debug(TAG, `VAD: dropping short utterance (${durationMs}ms)`);
      return;
    }

    const pcm = Buffer.from(this.preallocBuffer.subarray(0, aligned));
    const energy = calculateRmsEnergy(pcm);
    this.speechChunks++;
    this.profiler?.gauge("audio.speechChunks", this.speechChunks);
    this.profiler?.gauge("audio.lastChunkKb", Math.round(pcm.length / 1024));

    const wavHeader = createWavHeader(pcm.length, this.config.sampleRate, this.config.channels, 16);
    const wavBuffer = Buffer.concat([wavHeader, pcm]);

    const chunk: AudioChunk = {
      buffer: wavBuffer,
      source: this.config.device,
      ts: Date.now(),
      durationMs,
      energy,
      audioSource: this.audioSourceTag,
    };

    debug(TAG, `utterance: ${durationMs}ms${forced ? " (max-len cut)" : ""}, ${wavBuffer.length} bytes, energy=${energy.toFixed(4)}`);
    this.emit("chunk", chunk);
  }
}
