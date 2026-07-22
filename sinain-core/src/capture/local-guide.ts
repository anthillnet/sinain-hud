import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FeedBuffer } from "../buffers/feed-buffer.js";
import type { SenseBuffer } from "../buffers/sense-buffer.js";
import type { AnalysisConfig, BurstConfig, VoiceSessionMessage } from "../types.js";
import { assembleWindow, describeCoverage, flattenBrief, summonBrief, type WindowScope } from "./window-ops.js";
import { burstMetrics } from "./burst-metrics.js";
import { log, warn } from "../log.js";

const TAG = "guide";

/** Rolling conversation state: capped so a marathon call can't grow the prompt
 *  unboundedly. 80 turns ≈ the last 15-20 min of a two-way conversation. */
const MAX_TURNS = 80;
/** Already-shown lines fed back to the model for its own dedup. */
const MAX_SHOWN = 12;

const GUIDE_PROMPT = `You are a silent live copilot watching the user's real conversation. MIC turns (ME) are the user speaking; SYSTEM turns (THEM) are the other parties. You output at most a couple of short lines to a glanceable side display. Over-alerting destroys trust: SILENCE is the default and the correct output most ticks.

Output contract — reply with EXACTLY one of:
- SILENCE
- THESIS: <what this conversation is about NOW, <=14 words>   (only when a moment with concrete stakes changes what the conversation is about — 0-2 per session)
- HINT: "<their words, <=6 words verbatim>" — <one imperative, <=10 words> — SAY: <the exact sentence to say, <=16 words>

Rules: fire only when THEM opened a thread, asked something not being answered, tested trust, or moved a commitment — and only after they finished the thought. Anchor quotes must be THEIR verbatim words, never ME's. Never repeat or rephrase a hint from the already-shown list. If ME is already handling the moment well, stay silent. Write instruction and SAY lines in the language the conversation is being held in.`;

/** Standing scenario/context doc auto-loaded at session start when present —
 *  the zero-UI attach point for a call script, agenda, or playbook. */
const CONTEXT_DOC = join(homedir(), ".sinain", "guide-context.md");
const MAX_CONTEXT_CHARS = 24_000;

interface GuideTurn {
  who: "me" | "them";
  text: string;
  ts: number;
}

/**
 * Local guided-session lane ("light talk agent", VOICE_MODE=local). The
 * "Call sinain" gesture runs entirely inside sinain-core: no ar-bridge, no
 * ARSinain server. Finalized transcripts (mic = ME, system audio = THEM)
 * accumulate into a rolling turn list; each THEM turn schedules one tick
 * against the configured analysis endpoint (Cerebras chat-completions), and
 * any THESIS/HINT lines stream to the overlay as live-caption
 * `voice_session` messages — the exact shape the existing call chip renders,
 * so zero overlay changes.
 *
 * One session at a time. Status flows to the overlay as `voice_session`
 * messages: starting → live → ended | error.
 */
export class LocalGuideSession {
  private state: VoiceSessionMessage["status"] = "ended";
  private minutes = 0;
  private coverage = "";
  private systemPrompt = "";
  private turns: GuideTurn[] = [];
  /** Raw shown lines (last MAX_SHOWN) fed back to the model each tick. */
  private shownHints: string[] = [];
  /** Session-lifetime dedup keys (normalized lines) — never re-emit. */
  private shownKeys = new Set<string>();
  /** One LLM call in flight at a time; a tick requested while busy coalesces
   *  into exactly one follow-up run (never a queue). */
  private busy = false;
  private tickPending = false;

  constructor(
    private analysis: AnalysisConfig,
    private burst: BurstConfig,
    private feedBuffer: FeedBuffer,
    private senseBuffer: SenseBuffer,
    private broadcast: (msg: VoiceSessionMessage) => void,
  ) {}

  status(): { status: string; mode: string; minutes: number; coverage: string; paired: boolean } {
    // paired is an ARSinain-auth concept — the local lane needs no login.
    return {
      status: this.state, mode: "local", minutes: this.minutes,
      coverage: this.coverage, paired: true,
    };
  }

  /** Compose the seed brief for a range — best-effort, never throws.
   *  Mirrors VoiceSessionManager.composeSeed (same burst lane + metrics). */
  private async composeSeed(minutes: number, scope?: WindowScope): Promise<string> {
    if (minutes <= 0 || !this.burst.enabled || !this.burst.apiKey) return "";
    try {
      const slice = assembleWindow(this.feedBuffer, this.senseBuffer, minutes, scope);
      if (slice.lineCount === 0) return "";
      const { brief, result } = await summonBrief(this.burst, slice, minutes);
      if (!result.cached) {
        burstMetrics.record({ gesture: "voice-seed", tokensIn: result.tokensIn, tokensOut: result.tokensOut, latencyMs: result.latencyMs, cacheKey: "sinain-summon-v1", stats: slice.stats });
      }
      return flattenBrief(brief, minutes, slice.coverage);
    } catch (err) {
      warn(TAG, `seed brief failed (session continues unseeded): ${String(err).slice(0, 160)}`);
      return "";
    }
  }

  /**
   * Start a guided session seeded with the last N minutes (0 = unseeded).
   * `intent` (short goal) and `context` (scenario/script/agenda text) fold
   * into the system prompt; when no explicit context is passed,
   * ~/.sinain/guide-context.md is auto-loaded if present.
   */
  async start(minutes: number, apps?: string[], intent?: string, context?: string): Promise<{ ok: boolean; error?: string; loginUrl?: string }> {
    if (this.state === "starting" || this.state === "live") {
      return { ok: false, error: "a voice session is already running" };
    }

    this.minutes = minutes;
    const scope = apps && apps.length > 0 ? { apps } : undefined;
    this.coverage = minutes > 0 ? describeCoverage(this.feedBuffer, this.senseBuffer, minutes, scope) : "";
    this.turns = [];
    this.shownHints = [];
    this.shownKeys.clear();
    this.tickPending = false;

    this.setState("starting", minutes > 0 ? `Composing brief from last ${minutes} min…` : undefined);
    const seed = await this.composeSeed(minutes, scope);
    let scenario = (context ?? "").trim();
    let scenarioSource = scenario ? "request" : "";
    if (!scenario && existsSync(CONTEXT_DOC)) {
      try {
        scenario = readFileSync(CONTEXT_DOC, "utf-8").trim();
        scenarioSource = CONTEXT_DOC;
      } catch { /* unreadable doc = no scenario */ }
    }
    if (scenario.length > MAX_CONTEXT_CHARS) scenario = scenario.slice(0, MAX_CONTEXT_CHARS);
    this.systemPrompt = GUIDE_PROMPT
      + (intent ? `\n\nThe user's stated intent for this session: ${intent}` : "")
      + (scenario ? `\n\nSession scenario/playbook (ground your hints and SAY lines in this):\n${scenario}` : "")
      + (seed ? `\n\nContext so far (what the user was doing before the call):\n${seed}` : "");

    log(TAG, `local guided session live: ${minutes} min seed${seed ? "" : " (unseeded)"}, model=${this.analysis.model}`
      + (intent ? `, intent="${intent.slice(0, 60)}"` : "")
      + (scenario ? `, scenario=${scenario.length} chars (${scenarioSource})` : ""));
    this.setState("live", "Listening — hints appear here when they matter.");
    return { ok: true };
  }

  /** Finalized transcript hook (from the transcription pipeline). Mic = the
   *  user speaking (ME), system audio = the other parties (THEM). A THEM turn
   *  is the trigger: that's when a hint could change what ME says next. */
  onTranscript(text: string, source: "mic" | "system"): void {
    if (this.state !== "live") return;
    const trimmed = text.trim();
    if (!trimmed) return;
    this.turns.push({ who: source === "mic" ? "me" : "them", text: trimmed, ts: Date.now() });
    if (this.turns.length > MAX_TURNS) this.turns.splice(0, this.turns.length - MAX_TURNS);
    if (source === "system") this.requestTick();
  }

  /** End the session (true if one was starting/live). */
  stop(): boolean {
    if (this.state !== "starting" && this.state !== "live") return false;
    this.setState("ended");
    this.turns = [];
    this.shownHints = [];
    this.shownKeys.clear();
    this.tickPending = false;
    this.systemPrompt = "";
    return true;
  }

  // ── Tick loop ─────────────────────────────────────────────────────────

  private requestTick(): void {
    if (this.busy) {
      this.tickPending = true;
      return;
    }
    void this.runTick();
  }

  private async runTick(): Promise<void> {
    this.busy = true;
    try {
      await this.tick();
    } catch (err) {
      // LLM failures skip the tick, never kill the session.
      warn(TAG, `tick failed (session continues): ${String(err).slice(0, 200)}`);
    } finally {
      this.busy = false;
      const rerun = this.tickPending && this.state === "live";
      this.tickPending = false;
      if (rerun) void this.runTick();
    }
  }

  private async tick(): Promise<void> {
    if (this.state !== "live" || this.turns.length === 0) return;
    const transcript = this.turns
      .map((t) => `${t.who === "me" ? "ME" : "THEM"}: ${t.text}`)
      .join("\n");
    const shown = this.shownHints.length > 0
      ? this.shownHints.map((h) => `- ${h}`).join("\n")
      : "(none)";
    const user = `Transcript so far:\n${transcript}\n\nAlready shown:\n${shown}\n\nRespond now.`;
    const reply = await this.callModel(user);
    let emitted = 0;
    for (const raw of reply.split("\n")) {
      const line = raw.trim();
      // Only the contract lines surface; SILENCE and any chatter are dropped.
      if (!line.startsWith("THESIS:") && !line.startsWith("HINT:")) continue;
      this.emitHint(line);
      emitted++;
    }
    if (emitted === 0) {
      log(TAG, `tick: silent (turns=${this.turns.length}, reply="${reply.slice(0, 60).replace(/\n/g, " ")}")`);
    }
  }

  /** OpenAI chat-completions call against the configured analysis endpoint
   *  (Cerebras by default) — 20s timeout, one retry. */
  private async callModel(user: string): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(this.analysis.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.analysis.apiKey ? { "Authorization": `Bearer ${this.analysis.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: this.analysis.model,
            messages: [
              { role: "system", content: this.systemPrompt },
              { role: "user", content: user },
            ],
            max_tokens: 300,
            temperature: 0.2,
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`HTTP ${response.status}: ${body.slice(0, 160)}`);
        }
        const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        return data.choices?.[0]?.message?.content?.trim() ?? "";
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  /** Surface one hint line through the SAME live-caption path a webview
   *  bridge caption takes: a `voice_session` message with status "live" and
   *  the line in `message` — the existing call chip renders it unchanged. */
  private emitHint(line: string): void {
    if (this.state !== "live") return;
    const key = line.toLowerCase().replace(/\s+/g, " ").trim();
    if (this.shownKeys.has(key)) return;
    this.shownKeys.add(key);
    this.shownHints.push(line);
    if (this.shownHints.length > MAX_SHOWN) this.shownHints.splice(0, this.shownHints.length - MAX_SHOWN);
    log(TAG, `hint: ${line.slice(0, 160)}`);
    this.broadcast({
      type: "voice_session", status: "live", mode: "local",
      minutes: this.minutes, coverage: this.coverage,
      message: line, ts: Date.now(),
    });
  }

  private setState(status: VoiceSessionMessage["status"], message?: string): void {
    this.state = status;
    this.broadcast({
      type: "voice_session", status, mode: "local",
      minutes: this.minutes, coverage: this.coverage,
      ...(message ? { message } : {}), ts: Date.now(),
    });
  }
}
