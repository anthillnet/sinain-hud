import type { ChildProcess } from "node:child_process";
import type { AudioPipelineConfig, AudioSourceTag } from "../types.js";

/**
 * Strategy interface for spawning platform-specific audio capture processes.
 * Each platform implements this to spawn its native capture binary.
 */
export interface CaptureSpawner {
  /**
   * Spawn the audio capture process for the given source.
   * The process must output raw 16-bit PCM on stdout.
   */
  spawn(config: AudioPipelineConfig, source: AudioSourceTag): ChildProcess;
}
