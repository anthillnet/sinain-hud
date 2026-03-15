import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AudioPipelineConfig, AudioSourceTag } from "../types.js";
import type { CaptureSpawner } from "./capture-spawner.js";
import { log } from "../log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAG = "audio";

/**
 * macOS capture spawner — launches sck-capture (ScreenCaptureKit / AVAudioEngine).
 * System mode captures both audio and screen frames via SCStream.
 * Mic mode uses AVAudioEngine for audio only.
 */
export class MacOSCaptureSpawner implements CaptureSpawner {
  spawn(config: AudioPipelineConfig, source: AudioSourceTag): ChildProcess {
    const binaryPath = resolve(__dirname, "..", "..", "..", "tools", "sck-capture", "sck-capture");
    const args = [
      "--sample-rate", String(config.sampleRate),
      "--channels", String(config.channels),
    ];

    if (source === "mic") {
      args.push("--mic");
      if (config.device !== "default") {
        args.push("--mic-device", config.device);
      }
    } else {
      args.push(
        "--screen-dir", resolve(os.homedir(), ".sinain", "capture"),
        "--fps", "1",
        "--scale", "0.5",
      );
    }

    log(TAG, `spawning: ${binaryPath} ${args.join(" ")}`);

    return spawn(binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}
