import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FeedBuffer } from "../buffers/feed-buffer.js";
import type { SenseBuffer } from "../buffers/sense-buffer.js";
import type { BurstConfig, VoiceConfig, VoiceSessionMessage } from "../types.js";
import { assembleWindow, describeCoverage, flattenBrief, summonBrief, type WindowScope } from "./window-ops.js";
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
      coverage: this.coverage, paired: this.storedAuth().cookie !== "" || this.storedAuth().token !== "",
    };
  }

  // ── Browser login owned by the app: the overlay opens a WKWebView on the
  // server's own login; the resulting oauth2-proxy session cookie lands in
  // OUR cookie store and is handed here (/voice/pair). Server-side this is
  // indistinguishable from a browser session — no server changes needed. ──

  private cookieFile(): string {
    return join(homedir(), ".sinain", "arsinain-session.json");
  }

  private storedAuth(): { cookie: string; token: string } {
    try {
      const data = JSON.parse(readFileSync(this.cookieFile(), "utf-8")) as { cookie?: string; token?: string };
      return { cookie: data.cookie ?? "", token: data.token ?? "" };
    } catch {
      return { cookie: "", token: "" };
    }
  }

  /** Store the credential from the browser pair flow: either a device token
   *  (default-browser /hud/pair page) or a session cookie (webview login). */
  pair(cookie: string, token: string, email: string): void {
    mkdirSync(join(homedir(), ".sinain"), { recursive: true });
    writeFileSync(this.cookieFile(),
      JSON.stringify({ cookie, token, email, server: this.voice.serverUrl, ts: Date.now() }),
      { encoding: "utf-8", mode: 0o600 });
    log(TAG, `paired${email ? ` as ${email}` : ""} for ${this.voice.serverUrl}`);
  }

  /** Compose the seed brief for a range — best-effort, never throws. */
  private async composeSeed(minutes: number, scope?: WindowScope): Promise<string> {
    if (minutes <= 0 || !this.burst.enabled || !this.burst.apiKey) return "";
    try {
      const slice = assembleWindow(this.feedBuffer, this.senseBuffer, minutes, scope);
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

  /**
   * Start a session seeded with the last N minutes (0 = unseeded). Returns
   * `engine: "webview"` when the overlay should host the hidden-webview call
   * engine (the default — browser WebRTC stack); otherwise the python
   * ar-bridge is spawned here.
   */
  async start(minutes: number, scope?: WindowScope): Promise<{ ok: boolean; error?: string; loginUrl?: string; engine?: string }> {
    if (!this.voice.enabled) return { ok: false, error: "voice disabled (VOICE_ENABLED=false)" };
    if (this.proc || this.state === "starting" || this.state === "live") {
      return { ok: false, error: "a voice session is already running" };
    }

    this.minutes = minutes;
    this.coverage = minutes > 0 ? describeCoverage(this.feedBuffer, this.senseBuffer, minutes, scope) : "";

    // Deployed server + no credential → the overlay opens the DEFAULT browser
    // on the server's pair page (user is usually already signed in there);
    // the page hands a device token back to us and the overlay retries.
    const auth = this.storedAuth();
    const cookie = this.voice.meetCookie || auth.cookie;
    if (this.voice.serverUrl.startsWith("https://") && !cookie && !auth.token) {
      const error = "login required";
      return { ok: false, error, loginUrl: `${this.voice.serverUrl.replace(/\/$/, "")}/hud/pair` };
    }

    if (this.voice.engine === "webview") return this.startWebview(minutes, scope);

    this.mode = "bridge";
    this.setState("starting");

    const seedText = await this.composeSeed(minutes, scope);
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
      "--core", `http://127.0.0.1:${process.env.PORT || "9500"}`,
      "--frame", this.voice.framePath,
      "--fps", String(this.voice.fps),
      "--seed-file", this.seedFile,
      ...(this.voice.email ? ["--email", this.voice.email] : []),
      ...(cookie ? ["--cookie", cookie] : []),
      ...(auth.token ? ["--device-token", auth.token] : []),
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

  // ── Hidden-webview engine ─────────────────────────────────────────────
  // The overlay hosts an invisible WKWebView on /voice/call.html (served by
  // this core). The page runs the SAME WebRTC mechanics as the proven
  // ARSinain web client — getUserMedia with echo cancellation (it stops
  // hearing its own TTS), adaptive playout jitter buffer — and feeds the
  // screen by drawing /voice/frame onto a captured canvas. Core stays the
  // session owner: it composes the seed, proxies signaling with the device
  // token (page never holds a credential), and relays lifecycle events.

  private pendingSeed: { text: string; say: string } = { text: "", say: "" };
  private micMuted = false;

  private async startWebview(minutes: number, scope?: WindowScope): Promise<{ ok: boolean; engine: string }> {
    this.mode = "webview";
    this.micMuted = false;
    // Connecting checklist (design §4): the brief is composed and redacted
    // BEFORE audio connects — narrate that order on the chip.
    this.setState("starting", minutes > 0 ? `Composing brief from last ${minutes} min…` : undefined);
    const seedText = await this.composeSeed(minutes, scope);
    this.pendingSeed = {
      text: seedText,
      say: seedText
        ? `I've got your last ${minutes} minutes — ${this.coverage}. Go ahead.`
        : "I can see your screen. Go ahead.",
    };
    this.setState("starting", seedText
      ? "Brief composed · redacted · connecting audio…"
      : "Connecting audio…");
    log(TAG, `webview engine session: ${minutes} min seed, server=${this.voice.serverUrl}`);
    return { ok: true, engine: "webview" };
  }

  /** Mic mute control for the webview engine (the call page polls /voice/ctl). */
  setMute(muted: boolean): void {
    log(TAG, `mic mute → ${muted} (state=${this.state}, mode=${this.mode})`);
    this.micMuted = muted;
  }

  /** Control state the call page polls: mic mute + whether to hang up. */
  ctl(): { muted: boolean; end: boolean } {
    return {
      muted: this.micMuted,
      end: this.mode === "webview" && this.state !== "starting" && this.state !== "live",
    };
  }

  /** Seed for the call page's meta datachannel (single use per session). */
  seed(): { text: string; say: string } {
    return this.pendingSeed;
  }

  /** Proxy the call page's SDP offer to ARSinain with our stored credential. */
  async proxyOffer(body: unknown): Promise<{ status: number; body: string }> {
    const auth = this.storedAuth();
    const res = await fetch(`${this.voice.serverUrl.replace(/\/$/, "")}/offer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth.token ? { "X-Sinain-Device": auth.token } : {}),
        ...(this.voice.meetCookie || auth.cookie ? { Cookie: this.voice.meetCookie || auth.cookie } : {}),
        ...(this.voice.email ? { "X-Auth-Request-Email": this.voice.email } : {}),
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status >= 300 && res.status < 400) {
      return { status: 401, body: JSON.stringify({ error: "login required — re-pair from the HUD" }) };
    }
    return { status: res.status, body: await res.text() };
  }

  /** Lifecycle events reported by the call page (fetch POST /voice/engine).
   *  `caption` (with status "live") is a spoken line relayed from the meta
   *  datachannel — surfaced on the call chip as a live caption. */
  engineEvent(status: string, error?: string, caption?: string): void {
    if (this.mode !== "webview") return;
    if (status === "live") this.setState("live", caption);
    else if (status === "ended") this.setState("ended");
    else if (status === "error") this.fail(error || "call engine failed");
  }

  /** End the session (SIGTERM → bridge closes the peer connection cleanly;
   *  webview → broadcast "ended", the overlay tears the webview down). */
  stop(): boolean {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      return true;
    }
    if (this.mode === "webview" && (this.state === "starting" || this.state === "live")) {
      this.setState("ended");
      return true;
    }
    return false;
  }

  private cleanup(): void {
    this.proc = null;
    if (this.seedFile) {
      try { unlinkSync(this.seedFile); } catch { /* gone */ }
      this.seedFile = null;
    }
  }

  private setState(status: VoiceSessionMessage["status"], message?: string): void {
    this.state = status;
    this.broadcast({
      type: "voice_session", status, mode: this.mode,
      minutes: this.minutes, coverage: this.coverage,
      ...(message ? { message } : {}), ts: Date.now(),
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
