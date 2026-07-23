import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FeedBuffer } from "../buffers/feed-buffer.js";
import type { SenseBuffer } from "../buffers/sense-buffer.js";
import type { AnalysisConfig, BurstConfig, VoiceSessionMessage } from "../types.js";
import { assembleWindow, describeCoverage, flattenBrief, summonBrief, type WindowScope } from "./window-ops.js";
import { EmbeddingService } from "../embedding/service.js";
import { burstMetrics } from "./burst-metrics.js";
import { log, warn } from "../log.js";

const TAG = "guide";

/** Rolling conversation state: capped so a marathon call can't grow the prompt
 *  unboundedly. 80 turns ≈ the last 15-20 min of a two-way conversation. */
const MAX_TURNS = 80;
/** Already-shown lines fed back to the model for its own dedup. */
const MAX_SHOWN = 12;
/** Semantic dedup: a candidate whose gist (instruction+SAY — the anchor
 *  legitimately drifts with the conversation) embeds within this cosine of a
 *  recently displayed or retracted hint is a reworded duplicate — suppress it.
 *  Threshold sweepable on the fmg replay bench via GUIDE_DEDUP_SIM. */
const SIM_THRESHOLD = Number(process.env.GUIDE_DEDUP_SIM || "0.88");
const MAX_SHOWN_VECS = 10;
/** User-retracted hints/topics carried as prompt exclusions. */
const MAX_RETRACTED = 20;

const GUIDE_PROMPT = `You are a live teleprompter for the user's real conversation. MIC turns (ME) are the user speaking; SYSTEM turns (THEM) are the other parties. A glanceable side display shows your latest lines — keep it CURRENT: every tick, refresh it with the most useful guidance for this exact moment. Do not wait for special moments.

Output on every tick (1-2 lines):
- THESIS: <what the conversation is about NOW, <=14 words>   (only when it changed vs the last shown thesis)
- HINT: "<their recent words, <=6 words verbatim>" — <one imperative, <=10 words> — SAY: <the exact sentence to say next, <=16 words>

Rules: always produce the best current HINT for what was just said. Evolve with the conversation — never repeat a line from the already-shown list verbatim; if the last shown hint still stands unchanged, reply KEEP. Anchor quotes must be THEIR verbatim words, never ME's. Write instruction and SAY lines in the language the conversation is being held in. Ground hints and SAY lines in the session scenario when one is provided.`;

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
  // Prompt parts kept separate so a mid-session scenario swap (setContext)
  // recomposes without losing the intent or the seed brief.
  private intent = "";
  private scenario = "";
  private seed = "";
  /** Tracked session the call is attached to (drag gesture; null = none). */
  private attachedSessionId: string | null = null;
  private turns: GuideTurn[] = [];
  /** Raw shown lines (last MAX_SHOWN) fed back to the model each tick. */
  private shownHints: string[] = [];
  /** Session-lifetime dedup keys (normalized lines) — never re-emit. */
  private shownKeys = new Set<string>();
  /** User-retracted hints/topics (✕ irrelevant) — prompt exclusions. */
  private retracted: string[] = [];
  /** One LLM call in flight at a time; a tick requested while busy coalesces
   *  into exactly one follow-up run (never a queue). */
  private busy = false;
  private tickPending = false;

  /** Embedding vectors of displayed / retracted hint gists (semantic dedup). */
  private shownVecs: Float32Array[] = [];
  private retractedVecs: Float32Array[] = [];

  constructor(
    private analysis: AnalysisConfig,
    private burst: BurstConfig,
    private feedBuffer: FeedBuffer,
    private senseBuffer: SenseBuffer,
    private broadcast: (msg: VoiceSessionMessage) => void,
    // Lazy: the embedding service loads after construction; null/not-ready
    // degrades to the lexical dedup only.
    private getEmbedder: () => EmbeddingService | null = () => null,
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
    this.retracted = [];
    this.shownVecs = [];
    this.retractedVecs = [];
    this.tickPending = false;
    this.attachedSessionId = null;

    this.setState("starting", minutes > 0 ? `Composing brief from last ${minutes} min…` : undefined);
    this.seed = await this.composeSeed(minutes, scope);
    let scenario = (context ?? "").trim();
    let scenarioSource = scenario ? "request" : "";
    if (!scenario && existsSync(CONTEXT_DOC)) {
      try {
        scenario = readFileSync(CONTEXT_DOC, "utf-8").trim();
        scenarioSource = CONTEXT_DOC;
      } catch { /* unreadable doc = no scenario */ }
    }
    if (scenario.length > MAX_CONTEXT_CHARS) scenario = scenario.slice(0, MAX_CONTEXT_CHARS);
    this.intent = intent ?? "";
    this.scenario = scenario;
    this.composePrompt();

    log(TAG, `local guided session live: ${minutes} min seed${this.seed ? "" : " (unseeded)"}, model=${this.analysis.model}`
      + (intent ? `, intent="${intent.slice(0, 60)}"` : "")
      + (scenario ? `, scenario=${scenario.length} chars (${scenarioSource})` : ""));
    this.setState("live", "Listening — hints appear here when they matter.");
    return { ok: true };
  }

  /** System prompt from its stored parts — rerun whenever one changes. */
  private composePrompt(): void {
    this.systemPrompt = GUIDE_PROMPT
      + (this.intent ? `\n\nThe user's stated intent for this session: ${this.intent}` : "")
      + (this.scenario ? `\n\nSession scenario/playbook (ground your hints and SAY lines in this):\n${this.scenario}` : "")
      + (this.seed ? `\n\nContext so far (what the user was doing before the call):\n${this.seed}` : "")
      + (this.retracted.length > 0
        ? `\n\nThe user marked these as IRRELEVANT — never mention, reference, or build on these topics again:\n${this.retracted.map((r) => `- ${r}`).join("\n")}`
        : "");
  }

  /** Retract a hint/topic as irrelevant (✕ on the chip, or free text): the
   *  entry joins the prompt's exclusion list, any matching shown hint stops
   *  being fed back, and the current state re-broadcasts so the overlay can
   *  grey it. False when no session is starting/live. */
  retract(text: string): boolean {
    if (this.state !== "starting" && this.state !== "live") return false;
    const entry = text.trim();
    if (!entry) return true; // nothing to retract — not a session error
    const key = this.normKey(entry);
    this.retracted.push(entry);
    if (this.retracted.length > MAX_RETRACTED) this.retracted.splice(0, this.retracted.length - MAX_RETRACTED);
    this.shownHints = this.shownHints.filter((h) => this.normKey(h) !== key);
    // Fire-and-forget: the retracted gist's vector joins the suppression set,
    // so REWORDINGS of a retracted theme are caught even when the model
    // ignores the prompt exclusion.
    void this.embedGist(entry).then((vec) => {
      if (vec) {
        this.retractedVecs.push(vec);
        if (this.retractedVecs.length > MAX_RETRACTED) this.retractedVecs.splice(0, this.retractedVecs.length - MAX_RETRACTED);
      }
    });
    this.composePrompt();
    log(TAG, `retracted (${entry.length} chars), exclusions=${this.retracted.length}`);
    this.setState(this.state); // re-broadcast with the retracted list
    return true;
  }

  /** Attach the call to a tracked session (drag onto a session chip) — the
   *  id rides every broadcast from here on. Null/empty detaches. False when
   *  no session is starting/live. */
  attachSession(sessionId: string | null): boolean {
    if (this.state !== "starting" && this.state !== "live") return false;
    const id = sessionId?.trim() || null;
    this.attachedSessionId = id;
    log(TAG, id ? `attached to session ${id}` : "detached from session");
    this.setState(this.state); // broadcast so the overlay updates now
    return true;
  }

  /** Mid-session scenario swap (📎 on the live chip): replace the scenario
   *  part and recompose — intent and seed survive. False when no session is
   *  starting/live. */
  setContext(text: string): boolean {
    if (this.state !== "starting" && this.state !== "live") return false;
    let scenario = text.trim();
    if (scenario.length > MAX_CONTEXT_CHARS) scenario = scenario.slice(0, MAX_CONTEXT_CHARS);
    this.scenario = scenario;
    this.composePrompt();
    log(TAG, `scenario updated (${scenario.length} chars)`);
    return true;
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
    this.retracted = [];
    this.shownVecs = [];
    this.retractedVecs = [];
    this.tickPending = false;
    this.systemPrompt = "";
    this.intent = "";
    this.scenario = "";
    this.seed = "";
    this.attachedSessionId = null;
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
      if (await this.emitHint(line)) emitted++;
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

  /** Normalized dedup/retraction key for a hint line. */
  private normKey(line: string): string {
    return line.toLowerCase().replace(/\s+/g, " ").trim();
  }

  /** The part of a hint that carries its MEANING for dedup: instruction+SAY.
   *  The anchor (customer quote) legitimately changes as the conversation
   *  moves, so it must not shield a reworded duplicate from suppression. */
  private hintGist(line: string): string {
    if (line.startsWith("HINT:")) {
      const dash = line.indexOf("—");
      if (dash > 0) return line.slice(dash + 1).trim();
    }
    return line.replace(/^(THESIS|HINT):\s*/, "").trim();
  }

  /** Embed a hint gist — null when the service is absent/not ready/errors
   *  (semantic dedup degrades to lexical, never blocks the hint path). */
  private async embedGist(line: string): Promise<Float32Array | null> {
    const embedder = this.getEmbedder();
    if (!embedder?.ready) return null;
    try {
      const [vec] = await embedder.embed([this.hintGist(line)]);
      return vec ?? null;
    } catch {
      return null;
    }
  }

  /** Surface one hint line through the SAME live-caption path a webview
   *  bridge caption takes: a `voice_session` message with status "live" and
   *  the line in `message` — the existing call chip renders it unchanged. */
  private async emitHint(line: string): Promise<boolean> {
    if (this.state !== "live") return false;
    const key = this.normKey(line);
    if (this.shownKeys.has(key)) return false;
    // Semantic dedup: a reworded duplicate of a displayed or retracted hint
    // embeds close to it even when no words match.
    const vec = await this.embedGist(line);
    if (vec) {
      for (const prior of [...this.shownVecs, ...this.retractedVecs]) {
        const sim = EmbeddingService.cosine(vec, prior);
        if (sim >= SIM_THRESHOLD) {
          log(TAG, `tick: near-dup suppressed (sim=${sim.toFixed(2)}): ${line.slice(0, 80)}`);
          return false;
        }
      }
      this.shownVecs.push(vec);
      if (this.shownVecs.length > MAX_SHOWN_VECS) this.shownVecs.splice(0, this.shownVecs.length - MAX_SHOWN_VECS);
    }
    this.shownKeys.add(key);
    this.shownHints.push(line);
    if (this.shownHints.length > MAX_SHOWN) this.shownHints.splice(0, this.shownHints.length - MAX_SHOWN);
    log(TAG, `hint: ${line.slice(0, 160)}`);
    this.broadcast({
      type: "voice_session", status: "live", mode: "local",
      minutes: this.minutes, coverage: this.coverage,
      message: line,
      ...(this.attachedSessionId ? { attachedSessionId: this.attachedSessionId } : {}),
      ...(this.retracted.length > 0 ? { retracted: [...this.retracted] } : {}),
      ts: Date.now(),
    });
    return true;
  }

  private setState(status: VoiceSessionMessage["status"], message?: string): void {
    this.state = status;
    this.broadcast({
      type: "voice_session", status, mode: "local",
      minutes: this.minutes, coverage: this.coverage,
      ...(message ? { message } : {}),
      ...(this.attachedSessionId ? { attachedSessionId: this.attachedSessionId } : {}),
      ...(this.retracted.length > 0 ? { retracted: [...this.retracted] } : {}),
      ts: Date.now(),
    });
  }
}
