import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AudioPipelineConfig, AudioSourceTag } from "../types.js";
import type { CaptureSpawner } from "./capture-spawner.js";
import { log } from "../log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAG = "audio";

/**
 * Windows capture spawner — launches win-audio-capture.exe (WASAPI).
 * System mode uses WASAPI loopback capture on the default render device.
 * Mic mode uses WASAPI capture on the specified/default input device.
 */
export class WindowsCaptureSpawner implements CaptureSpawner {
  spawn(config: AudioPipelineConfig, source: AudioSourceTag): ChildProcess {
    const binaryPath = resolve(__dirname, "..", "..", "..", "tools", "win-audio-capture", "build", "win-audio-capture.exe");
    const args = [
      "--sample-rate", String(config.sampleRate),
      "--channels", String(config.channels),
    ];

    if (source === "mic") {
      args.push("--mic");
      if (config.device !== "default") {
        args.push("--mic-device", config.device);
      }
    }

    log(TAG, `spawning: ${binaryPath} ${args.join(" ")}`);

    return spawn(binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}
