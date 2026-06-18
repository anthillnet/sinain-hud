import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
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
    // Check ~/.sinain/sck-capture/ first (npx install), then dev path
    const homeBinary = resolve(os.homedir(), ".sinain", "sck-capture", "sck-capture");
    const devBinary = resolve(__dirname, "..", "..", "..", "tools", "sck-capture", "sck-capture");
    const binaryPath = existsSync(homeBinary) ? homeBinary : devBinary;

    if (!existsSync(binaryPath)) {
      throw new Error(
        `sck-capture binary not found at ${binaryPath}. ` +
        `Run: npx @geravant/sinain setup-sck-capture`
      );
    }

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
      // Screen-capture rate caps the whole region pipeline: the IPC frame
      // refreshes at this fps, so OCR → /sense → eye re-anchoring can't run
      // faster. 1 fps made eyes appear late and barely follow scrolling; 4 fps
      // (downscaled 0.5) keeps eyes tracking content with modest CPU. Tunable
      // via CAPTURE_FPS for low-power setups.
      const fps = Number(process.env.CAPTURE_FPS) || 4;
      args.push(
        "--screen-dir", resolve(os.homedir(), ".sinain", "capture"),
        "--fps", String(fps),
        "--scale", "0.5",
      );
    }

    log(TAG, `spawning: ${binaryPath} ${args.join(" ")}`);

    return spawn(binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}
