import { EventEmitter } from "node:events";
import { readFileSync, unlinkSync, watch, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AudioChunk } from "./types.js";
import { log, warn, error as logError } from "./log.js";

const TAG = "ipc-audio";

const IPC_AUDIO_DIR = join(homedir(), ".sinain", "capture", "audio");

/**
 * IPC-based audio capture that reads WAV chunks written by the native overlay.
 * Drop-in replacement for AudioPipeline — same public API and events.
 *
 * The Swift overlay writes 5-second WAV chunks (16kHz mono 16-bit PCM) to
 * ~/.sinain/capture/audio/{system|mic}_{timestamp}_{index}.wav
 * This class watches that directory and emits AudioChunk events.
 */
export class IpcAudioCapture extends EventEmitter {
  private running = false;
  private watcher: ReturnType<typeof watch> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private processedFiles = new Set<string>();
  private device = "ipc-native";

  start(): void {
    if (this.running) return;
    this.running = true;

    // Ensure IPC directory exists
    mkdirSync(IPC_AUDIO_DIR, { recursive: true });

    // Process any existing files first
    this.scanDirectory();

    // Watch for new files via fs.watch
    try {
      this.watcher = watch(IPC_AUDIO_DIR, (eventType, filename) => {
        if (eventType === "rename" && filename && filename.endsWith(".wav")) {
          // Small delay for atomic rename completion
          setTimeout(() => this.processFile(filename), 50);
        }
      });
      this.watcher.on("error", (err) => {
        warn(TAG, `fs.watch error: ${err.message}, falling back to polling`);
        this.watcher = null;
      });
    } catch (err) {
      warn(TAG, `fs.watch failed, using polling only`);
    }

    // Polling fallback — catches anything fs.watch misses
    this.pollTimer = setInterval(() => this.scanDirectory(), 1000);

    log(TAG, `watching ${IPC_AUDIO_DIR}`);
    this.emit("started");
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.processedFiles.clear();
    log(TAG, "stopped");
    this.emit("stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  getDevice(): string {
    return this.device;
  }

  switchDevice(_device: string): void {
    // No-op — device selection is handled by the native overlay
    log(TAG, "switchDevice is a no-op in IPC mode (device selection is in the native overlay)");
  }

  private scanDirectory(): void {
    if (!this.running) return;
    try {
      const files = readdirSync(IPC_AUDIO_DIR);
      for (const file of files) {
        if (file.endsWith(".wav") && !this.processedFiles.has(file)) {
          this.processFile(file);
        }
      }
    } catch {
      // Directory may not exist yet
    }
  }

  private processFile(filename: string): void {
    if (!this.running) return;
    if (this.processedFiles.has(filename)) return;
    if (!filename.endsWith(".wav")) return;

    // Skip .tmp files (in-progress writes)
    if (filename.endsWith(".tmp")) return;

    this.processedFiles.add(filename);

    const filePath = join(IPC_AUDIO_DIR, filename);

    try {
      if (!existsSync(filePath)) return;

      const wavBuffer = readFileSync(filePath);

      // Parse WAV header for duration
      if (wavBuffer.length < 44) {
        warn(TAG, `${filename}: too small to be WAV (${wavBuffer.length} bytes)`);
        tryDelete(filePath);
        return;
      }

      const sampleRate = wavBuffer.readUInt32LE(24);
      const bitsPerSample = wavBuffer.readUInt16LE(34);
      const numChannels = wavBuffer.readUInt16LE(22);
      const dataSize = wavBuffer.readUInt32LE(40);

      const bytesPerSample = bitsPerSample / 8;
      const totalSamples = dataSize / (bytesPerSample * numChannels);
      const durationMs = (totalSamples / sampleRate) * 1000;

      // Compute RMS energy from PCM data
      const pcmStart = 44;
      const pcmData = wavBuffer.subarray(pcmStart);
      let sumSquares = 0;
      const sampleCount = pcmData.length / 2;
      for (let i = 0; i < pcmData.length - 1; i += 2) {
        const sample = pcmData.readInt16LE(i) / 32767;
        sumSquares += sample * sample;
      }
      const energy = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;

      // Determine source from filename: system_*.wav or mic_*.wav
      const source = filename.startsWith("mic") ? "mic" : "system";

      const chunk: AudioChunk = {
        buffer: wavBuffer,
        source,
        ts: Date.now(),
        durationMs,
        energy,
      };

      this.emit("chunk", chunk);

      // Delete processed file
      tryDelete(filePath);

      // Keep processedFiles set from growing unbounded
      if (this.processedFiles.size > 1000) {
        const toRemove = [...this.processedFiles].slice(0, 500);
        for (const f of toRemove) this.processedFiles.delete(f);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // File may have been deleted between detection and read — that's OK
      if (!msg.includes("ENOENT")) {
        logError(TAG, `error processing ${filename}: ${msg}`);
        this.emit("error", err);
      }
      tryDelete(filePath);
    }
  }
}

function tryDelete(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already deleted or permission error — ignore
  }
}
