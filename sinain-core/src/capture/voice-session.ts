import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FeedBuffer } from "../buffers/feed-buffer.js";
import type { SenseBuffer } from "../buffers/sense-buffer.js";
import type { BurstConfig, VoiceConfig, VoiceSessionMessage } from "../types.js";
import { assembleWindow, describeCoverage, flattenBrief, summonBrief } from "./window-ops.js";
import { log, warn } from "../log.js";

const TAG = "voice";

/**
 * "Talk to Sinain" session lifecycle. Spawns the ar-bridge (tools/ar-bridge),
 * which publishes the screen + mic to an ARSinain server over WebRTC and
 * plays the returned voice. The session is seeded with a window brief of the
 * requested range (same flattened text the chat/term destinations carry) plus
 * a spoken opening acknowledgment, both delivered over the meta datachannel.
 *
 * One session at a time. Status flows to the overlay as `voice_session`
 * messages: starting → live → ended | error.
 */
export class VoiceSessionManager {
  private proc: ChildProcess | null = null;
  private state: VoiceSessionMessage["status"] = "ended";
  private minutes = 0;
  private coverage = "";
  private seedFile: string | null = null;

  constructor(
    private voice: VoiceConfig,
    private burst: BurstConfig,
    private feedBuffer: FeedBuffer,
    private senseBuffer: SenseBuffer,
    private broadcast: (msg: VoiceSessionMessage) => void,
  ) {}

  status(): { status: string; minutes: number; coverage: string } {
    return { status: this.state, minutes: this.minutes, coverage: this.coverage };
  }

  /** Start a session seeded with the last N minutes (0 = unseeded). */
  async start(minutes: number): Promise<{ ok: boolean; error?: string }> {
    if (!this.voice.enabled) return { ok: false, error: "voice disabled (VOICE_ENABLED=false)" };
    if (this.proc) return { ok: false, error: "a voice session is already running" };

    this.minutes = minutes;
    this.coverage = minutes > 0 ? describeCoverage(this.feedBuffer, this.senseBuffer, minutes) : "";
    this.setState("starting");

    // Build the seed — best-effort: a brief failure must not block the call.
    let seedText = "";
    if (minutes > 0 && this.burst.enabled && this.burst.apiKey) {
      try {
        const slice = assembleWindow(this.feedBuffer, this.senseBuffer, minutes);
        if (slice.lineCount > 0) {
          const { brief } = await summonBrief(this.burst, slice, minutes);
          seedText = flattenBrief(brief, minutes, slice.coverage);
        }
      } catch (err) {
        warn(TAG, `seed brief failed (session continues unseeded): ${String(err).slice(0, 160)}`);
      }
    }
    const say = seedText
      ? `I've got your last ${minutes} minutes — ${this.coverage}. Go ahead.`
      : "I can see your screen. Go ahead.";

    this.seedFile = join(tmpdir(), `sinain-voice-${process.pid}-${randomBytes(4).toString("hex")}.json`);
    writeFileSync(this.seedFile, JSON.stringify({ text: seedText, say }), { encoding: "utf-8", mode: 0o600 });

    const bridgeDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tools", "ar-bridge");
    const venvPython = join(bridgeDir, ".venv", "bin", "python");
    const python = existsSync(venvPython) ? venvPython : "python3";
    const script = join(bridgeDir, "bridge.py");
    if (!existsSync(script)) {
      this.fail(`ar-bridge not found at ${script}`);
      return { ok: false, error: "ar-bridge missing" };
    }

    log(TAG, `starting session: ${minutes} min seed, server=${this.voice.serverUrl}`);
    const proc = spawn(python, [
      script,
      "--server", this.voice.serverUrl,
      "--frame", this.voice.framePath,
      "--fps", String(this.voice.fps),
      "--seed-file", this.seedFile,
      ...(this.voice.email ? ["--email", this.voice.email] : []),
    ], { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;

    proc.stdout?.setEncoding("utf-8");
    proc.stdout?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        const m = line.trim();
        if (!m.startsWith("AR-BRIDGE")) continue;
        const event = m.slice("AR-BRIDGE".length).trim();
        if (event === "live") this.setState("live");
        else if (event.startsWith("error:")) warn(TAG, event);
        else log(TAG, event.slice(0, 200));
      }
    });
    proc.stderr?.setEncoding("utf-8");
    proc.stderr?.on("data", (chunk: string) => warn(TAG, `bridge stderr: ${chunk.trim().slice(0, 200)}`));

    proc.on("exit", (code) => {
      const wasLive = this.state === "live";
      this.cleanup();
      if (wasLive || code === 0) this.setState("ended");
      else this.fail(`bridge exited (code ${code}) before going live — is ARSinain up at ${this.voice.serverUrl}?`);
    });
    proc.on("error", (err) => {
      this.cleanup();
      this.fail(`bridge spawn failed: ${err.message}`);
    });

    return { ok: true };
  }

  /** End the session (SIGTERM → bridge closes the peer connection cleanly). */
  stop(): boolean {
    if (!this.proc) return false;
    this.proc.kill("SIGTERM");
    return true;
  }

  private cleanup(): void {
    this.proc = null;
    if (this.seedFile) {
      try { unlinkSync(this.seedFile); } catch { /* gone */ }
      this.seedFile = null;
    }
  }

  private setState(status: VoiceSessionMessage["status"]): void {
    this.state = status;
    this.broadcast({
      type: "voice_session", status,
      minutes: this.minutes, coverage: this.coverage, ts: Date.now(),
    });
  }

  private fail(error: string): void {
    warn(TAG, error);
    this.state = "error";
    this.broadcast({
      type: "voice_session", status: "error",
      minutes: this.minutes, coverage: this.coverage, error, ts: Date.now(),
    });
  }
}
