import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
  private mode: VoiceSessionMessage["mode"] = "bridge";
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

  status(): { status: string; mode: string; minutes: number; coverage: string; paired: boolean } {
    return {
      status: this.state, mode: this.mode, minutes: this.minutes,
      coverage: this.coverage, paired: this.deviceToken() !== "",
    };
  }

  // ── Browser pairing (like the gpt bridge): the user logs in at the
  // deployed server; its /hud/pair page mints a device token and POSTs it
  // here (/voice/pair → pair()). The bridge then authenticates with it. ──

  private tokenFile(): string {
    return join(homedir(), ".sinain", "arsinain-device.json");
  }

  private deviceToken(): string {
    try {
      const data = JSON.parse(readFileSync(this.tokenFile(), "utf-8")) as { token?: string };
      return data.token ?? "";
    } catch {
      return "";
    }
  }

  /** Store a browser-minted device token (POST /voice/pair). */
  pair(token: string, email: string): void {
    mkdirSync(join(homedir(), ".sinain"), { recursive: true });
    writeFileSync(this.tokenFile(),
      JSON.stringify({ token, email, server: this.voice.serverUrl, ts: Date.now() }),
      { encoding: "utf-8", mode: 0o600 });
    log(TAG, `paired as ${email || "(unknown)"} for ${this.voice.serverUrl}`);
  }

  /** Open the browser login/pair page (user completes it there). */
  login(): void {
    const url = `${this.voice.serverUrl.replace(/\/$/, "")}/hud/pair`;
    log(TAG, `opening pair page: ${url}`);
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  }

  /** Compose the seed brief for a range — best-effort, never throws. */
  private async composeSeed(minutes: number): Promise<string> {
    if (minutes <= 0 || !this.burst.enabled || !this.burst.apiKey) return "";
    try {
      const slice = assembleWindow(this.feedBuffer, this.senseBuffer, minutes);
      if (slice.lineCount === 0) return "";
      const { brief } = await summonBrief(this.burst, slice, minutes);
      return flattenBrief(brief, minutes, slice.coverage);
    } catch (err) {
      warn(TAG, `seed brief failed (session continues unseeded): ${String(err).slice(0, 160)}`);
      return "";
    }
  }

  /**
   * Meetbot transport: the deployed ARSinain launches its bot container,
   * which joins the given Google Meet/Teams call as "Sinain (AI)" — the
   * existing production call path, driven from the HUD. Auth is the user's
   * own oauth2-proxy session cookie (ARSINAIN_COOKIE).
   */
  async meet(url: string, minutes: number): Promise<{ ok: boolean; error?: string }> {
    if (!this.voice.enabled) return { ok: false, error: "voice disabled (VOICE_ENABLED=false)" };
    this.mode = "meet";
    this.minutes = minutes;
    this.coverage = minutes > 0 ? describeCoverage(this.feedBuffer, this.senseBuffer, minutes) : "";
    this.setState("starting");

    const seed = await this.composeSeed(minutes);
    try {
      const res = await fetch(`${this.voice.meetServerUrl.replace(/\/$/, "")}/meet`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.voice.meetCookie ? { Cookie: this.voice.meetCookie } : {}),
        },
        body: JSON.stringify({ url, ...(seed ? { seed } : {}) }),
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status >= 300 && res.status < 400) {
        const error = "the server wants a login — set ARSINAIN_COOKIE to your browser's _oauth2_proxy cookie";
        this.fail(error);
        return { ok: false, error };
      }
      const body = (await res.json().catch(() => ({}))) as { status?: string; message?: string; error?: string };
      if (!res.ok || body.error) {
        const error = body.error ?? `meet launch failed (${res.status})`;
        this.fail(error);
        return { ok: false, error };
      }
      log(TAG, `meetbot joining ${url} (${seed ? "seeded" : "unseeded"})`);
      this.state = "live";
      this.broadcast({
        type: "voice_session", status: "live", mode: "meet",
        minutes: this.minutes, coverage: this.coverage,
        message: body.message ?? "Sinain is joining — admit \"Sinain (AI)\" from the meeting's People panel.",
        ts: Date.now(),
      });
      return { ok: true };
    } catch (err) {
      const error = `cannot reach ${this.voice.meetServerUrl}: ${String((err as Error).message ?? err).slice(0, 160)}`;
      this.fail(error);
      return { ok: false, error };
    }
  }

  /** Start a bridge session seeded with the last N minutes (0 = unseeded). */
  async start(minutes: number): Promise<{ ok: boolean; error?: string }> {
    if (!this.voice.enabled) return { ok: false, error: "voice disabled (VOICE_ENABLED=false)" };
    if (this.proc) return { ok: false, error: "a voice session is already running" };

    this.mode = "bridge";
    this.minutes = minutes;
    this.coverage = minutes > 0 ? describeCoverage(this.feedBuffer, this.senseBuffer, minutes) : "";

    // Deployed server + no credentials → send the user to the browser login
    // (same flow as the gpt bridge) instead of dialing into a 302.
    const token = this.deviceToken();
    if (this.voice.serverUrl.startsWith("https://") && !token && !this.voice.meetCookie) {
      this.login();
      const error = "not paired yet — complete the login in the browser tab that just opened, then call again";
      this.setState("starting");
      this.fail(error);
      return { ok: false, error };
    }
    this.setState("starting");

    const seedText = await this.composeSeed(minutes);
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
      ...(this.voice.meetCookie ? ["--cookie", this.voice.meetCookie] : []),
      ...(token ? ["--device-token", token] : []),
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
      type: "voice_session", status, mode: this.mode,
      minutes: this.minutes, coverage: this.coverage, ts: Date.now(),
    });
  }

  private fail(error: string): void {
    warn(TAG, error);
    this.state = "error";
    this.broadcast({
      type: "voice_session", status: "error", mode: this.mode,
      minutes: this.minutes, coverage: this.coverage, error, ts: Date.now(),
    });
  }
}
