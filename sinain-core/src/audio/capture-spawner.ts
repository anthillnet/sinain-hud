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
   * `opts.compat` drops newer optional flags (e.g. --pin-display) so a stale
   * capture binary that predates them still launches instead of exiting on an
   * "Unknown arg" — used by the pipeline to self-heal a version-skewed install.
   */
  spawn(config: AudioPipelineConfig, source: AudioSourceTag, opts?: { compat?: boolean }): ChildProcess;
}
