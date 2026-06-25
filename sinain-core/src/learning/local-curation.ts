/**
 * LocalCurationService — local-first knowledge pipeline for sinain-core.
 *
 * Runs the same Python scripts as the OpenClaw server-side pipeline,
 * but triggered locally: on session end (SIGINT/SIGTERM) and periodically.
 *
 * This ensures knowledge persists between bare-agent sessions even when
 * no OpenClaw gateway is available.
 *
 * Memory directory: SINAIN_MEMORY_DIR (default: ~/.sinain/memory)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Promisified execFile — the distillation/curation pipelines run heavy Python
// subprocesses (LLM distiller ~16s, integrator ~19s, recon, periodic scripts).
// The previous execFileSync BLOCKED the Node event loop for the whole run, so
// during a buffer-full distillation core stopped serving /sense, /motion and
// WebSocket — freezing the overlay (region eyes stuck) for ~40s at a time.
// Async execFile lets these run in a child process without stalling the loop.
const execFileAsync = promisify(execFile);
import type { FeedItem } from "../types.js";
import type { SenseBuffer } from "../buffers/sense-buffer.js";
import { log, warn, error } from "../log.js";

const TAG = "local-curation";
const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve the sinain-memory Python scripts directory. */
function resolveScriptsDir(): string {
  // Look for sinain-memory scripts in known locations.
  // Two package layouts are supported:
  //   dev/monorepo: <repo>/sinain-core/src/learning/ → ../../../sinain-hud-plugin/sinain-memory
  //   npm-published flat: <pkg>/sinain-core/src/learning/ → ../../../sinain-memory
  const candidates = [
    resolve(__dirname, "..", "..", "..", "sinain-hud-plugin", "sinain-memory"),  // dev/monorepo layout
    resolve(__dirname, "..", "..", "..", "sinain-memory"),                         // npm-published flat layout
    resolve(__dirname, "..", "..", "sinain-memory"),                               // legacy alt
    resolve(process.env.HOME || "", ".sinain", "sinain-memory"),                  // user-local fallback
  ];
  for (const dir of candidates) {
    if (existsSync(resolve(dir, "session_distiller.py"))) {
      return dir;
    }
  }
  error(TAG, `sinain-memory scripts not found. Searched ${candidates.length} locations:`);
  for (const dir of candidates) {
    error(TAG, `  - ${dir}`);
  }
  return candidates[candidates.length - 1]; // Return user-local path as sentinel
}

/** Resolve the local memory directory. */
function resolveMemoryDir(): string {
  const raw = process.env.SINAIN_MEMORY_DIR
    || process.env.OPENCLAW_WORKSPACE_DIR
    || `${process.env.HOME}/.sinain/memory`;
  const expanded = raw.startsWith("~") ? raw.replace("~", process.env.HOME || "") : raw;

  // If pointing to workspace, use the memory subdirectory
  if (expanded.endsWith("/workspace") || expanded.endsWith("/workspace/")) {
    return resolve(expanded, "memory");
  }
  return expanded;
}

export class LocalCurationService {
  private memoryDir: string;
  private scriptsDir: string;
  private sessionStartTs: number;
  private curationTimer: ReturnType<typeof setInterval> | null = null;
  private _lastDistilledTs = 0; // timestamp of last incremental distillation
  private _incrementalRunning = false;
  private _rearmCb: (() => void) | null = null; // callback to re-arm feed buffer onFull
  private _senseBuffer: SenseBuffer | null = null;
  // Optional HUD broadcast callback — when insight_synthesizer emits a
  // suggestion/insight, we push it here so the overlay sees it. Replaces the
  // bare-agent's prior `sinain_post_feed` roundtrip during heartbeat.
  // Always posts at default priority; curation isn't the place for urgent pings.
  private _broadcast: ((text: string) => void) | null = null;

  constructor(broadcast?: (text: string) => void) {
    this.memoryDir = resolveMemoryDir();
    this.scriptsDir = resolveScriptsDir();
    this.sessionStartTs = Date.now();
    if (broadcast) this._broadcast = broadcast;

    // Ensure memory directory exists
    for (const subdir of ["", "playbook-logs", "playbook-archive", "eval-logs", "eval-reports"]) {
      const dir = resolve(this.memoryDir, subdir);
      mkdirSync(dir, { recursive: true });
    }

    log(TAG, `memory: ${this.memoryDir}`);
    log(TAG, `scripts: ${this.scriptsDir}`);
    log(TAG, `scripts available: ${existsSync(resolve(this.scriptsDir, "session_distiller.py"))}`);
  }

  /** Start periodic curation (30-minute timer). */
  startPeriodicCuration(): void {
    if (this.curationTimer) return;
    const intervalMs = 30 * 60 * 1000; // 30 minutes
    this.curationTimer = setInterval(() => {
      void this.runCurationPipeline();
    }, intervalMs);
    log(TAG, `periodic curation started (every 30 min)`);
  }

  /** Stop periodic curation. */
  stop(): void {
    if (this.curationTimer) {
      clearInterval(this.curationTimer);
      this.curationTimer = null;
    }
  }

  /** Timestamp of last incremental distillation (items before this are already distilled). */
  get lastDistilledTs(): number {
    return this._lastDistilledTs;
  }

  /** Set the callback to re-arm the feed buffer's onFull trigger after distillation. */
  setRearmCallback(cb: () => void): void {
    this._rearmCb = cb;
  }

  /** Attach sense buffer for screen context in distillation. */
  setSenseBuffer(sb: SenseBuffer): void {
    this._senseBuffer = sb;
  }

  /** Extract screen context from sense buffer as feed-item-compatible entries. */
  private getSenseContext(): Array<{ text: string; ts: number; source: string; channel: string }> {
    if (!this._senseBuffer) return [];
    const events = this._senseBuffer.queryByTime(this._lastDistilledTs || (Date.now() - 30 * 60 * 1000));
    const items: Array<{ text: string; ts: number; source: string; channel: string }> = [];
    for (const evt of events) {
      // Include OCR text (what's visible on screen)
      if (evt.ocr && evt.ocr.length > 20) {
        const app = evt.semantic?.context?.app || "unknown";
        items.push({
          text: `[screen: ${app}] ${evt.ocr}`,
          ts: evt.ts,
          source: "sense",
          channel: "screen",
        });
      }
      // Include vision summaries (AI description of screen content)
      if (evt.semantic?.visible?.summary) {
        items.push({
          text: `[screen-context] ${evt.semantic.visible.summary}`,
          ts: evt.ts,
          source: "sense",
          channel: "screen",
        });
      }
    }
    return items;
  }

  /**
   * Incremental distillation — called when the feed buffer reaches capacity.
   * Distills the current buffer contents before they fall off the ring buffer.
   * Runs async so it doesn't block new items from arriving.
   */
  async distillIncremental(feedItems: FeedItem[]): Promise<void> {
    if (this._incrementalRunning) {
      log(TAG, "incremental distillation already running — skipping");
      return;
    }
    this._incrementalRunning = true;

    try {
      const itemCount = feedItems.length;
      log(TAG, `incremental distillation: ${itemCount} items (buffer full)`);

      const sessionMeta = {
        ts: new Date().toISOString(),
        sessionKey: "local-incremental",
        durationMs: Date.now() - this.sessionStartTs,
      };

      const audioItems = feedItems.map(item => ({
        text: item.text,
        ts: item.ts,
        source: item.source || "unknown",
        channel: item.channel || "agent",
      }));

      // Merge screen context from sense buffer (OCR + vision summaries)
      const senseItems = this.getSenseContext();
      const transcript = [...audioItems, ...senseItems].sort((a, b) => a.ts - b.ts);

      if (senseItems.length > 0) {
        log(TAG, `including ${senseItems.length} screen context items in distillation`);
      }

      if (await this.runDistillation(transcript, sessionMeta)) {
        this._lastDistilledTs = Date.now();
        log(TAG, `incremental distillation complete — ${itemCount} audio + ${senseItems.length} screen items processed`);
      }
    } catch (err: any) {
      warn(TAG, `incremental distillation failed: ${err.message?.slice(0, 100)}`);
    } finally {
      this._incrementalRunning = false;
      // Re-arm the buffer callback so next fill triggers another distillation
      this._rearmCb?.();
    }
  }

  /**
   * Save feed items to disk for deferred distillation.
   * Called during shutdown — instant (no LLM), survives tsx force-kill.
   */
  savePendingSession(feedItems: FeedItem[]): void {
    if (feedItems.length < 1) {
      log(TAG, `skipping save — only ${feedItems.length} feed items`);
      return;
    }

    const pendingPath = resolve(this.memoryDir, "pending-session.json");
    const data = {
      ts: new Date().toISOString(),
      sessionKey: "local-session",
      durationMs: Date.now() - this.sessionStartTs,
      items: feedItems.map(item => ({
        text: item.text,
        ts: item.ts,
        source: item.source || "unknown",
        channel: item.channel || "agent",
      })),
    };

    writeFileSync(pendingPath, JSON.stringify(data), "utf-8");
    log(TAG, `saved ${feedItems.length} feed items to pending-session.json`);
  }

  /**
   * Distill a previously saved pending session (from a prior shutdown).
   * Called on startup — runs LLM distillation when there's no time pressure.
   */
  async distillPendingSession(): Promise<void> {
    const pendingPath = resolve(this.memoryDir, "pending-session.json");
    if (!existsSync(pendingPath)) return;

    let data: any;
    try {
      data = JSON.parse(readFileSync(pendingPath, "utf-8"));
    } catch {
      warn(TAG, "corrupt pending-session.json — removing");
      unlinkSync(pendingPath);
      return;
    }

    const items: FeedItem[] = data.items || [];
    if (items.length < 1) {
      log(TAG, `pending session too small (${items.length} items) — removing`);
      unlinkSync(pendingPath);
      return;
    }

    log(TAG, `distilling pending session: ${items.length} items from ${data.ts}`);

    // Remove pending file first so a crash here doesn't loop
    unlinkSync(pendingPath);

    await this.runDistillation(items, {
      ts: data.ts,
      sessionKey: data.sessionKey || "local-session",
      durationMs: data.durationMs || 0,
    });
  }

  /**
   * Distill the current session on shutdown.
   * First saves feed items to disk (instant), then attempts LLM distillation.
   * If tsx kills the process before LLM finishes, the saved file will be
   * picked up on next startup via distillPendingSession().
   */
  async distillSession(feedItems: FeedItem[]): Promise<void> {
    // Filter to only items not yet covered by incremental distillation
    const items = this._lastDistilledTs > 0
      ? feedItems.filter(i => i.ts > this._lastDistilledTs)
      : feedItems;

    if (items.length < 1) {
      log(TAG, `skipping shutdown distillation — all ${feedItems.length} items already distilled incrementally`);
      return;
    }

    log(TAG, `shutdown distillation: ${items.length} items (${feedItems.length - items.length} already distilled incrementally)`);

    // Step 0: Save to disk FIRST — survives force-kill
    this.savePendingSession(items);

    const sessionMeta = {
      ts: new Date().toISOString(),
      sessionKey: "local-session",
      durationMs: Date.now() - this.sessionStartTs,
    };

    const transcript = items.map(item => ({
      text: item.text,
      ts: item.ts,
      source: item.source || "unknown",
      channel: item.channel || "agent",
    }));

    // Step 1+2: Attempt LLM distillation (may be killed by tsx)
    if (await this.runDistillation(transcript, sessionMeta)) {
      // Success — remove the pending file since we distilled in-place
      const pendingPath = resolve(this.memoryDir, "pending-session.json");
      try { unlinkSync(pendingPath); } catch { /* already gone */ }
    }
    // If killed here, pending-session.json remains for next startup
  }

  /**
   * Run the actual distillation pipeline (session_distiller + knowledge_integrator).
   * Returns true if distillation succeeded.
   */
  private async runDistillation(transcript: any[], sessionMeta: { ts: string; sessionKey: string; durationMs: number }): Promise<boolean> {
    if (!existsSync(resolve(this.scriptsDir, "session_distiller.py"))) {
      warn(TAG, "session_distiller.py not found — skipping distillation");
      this.writeDailyNotesFallback(transcript as any);
      return false;
    }

    log(TAG, `distilling session: ${transcript.length} items, ${Math.round(sessionMeta.durationMs / 60000)} min`);

    try {
      // Step 0.5: Retrieve existing entities for context (Mem0 retrieve-before-extract pattern)
      let existingEntities = "";
      const dbPath = resolve(this.memoryDir, "knowledge-graph.db");
      if (existsSync(dbPath)) {
        try {
          existingEntities = (await execFileAsync("python3", [
            resolve(this.scriptsDir, "graph_query.py"),
            "--db", dbPath,
            "--top", "20",
            "--format", "compact",
          ], {
            timeout: 5_000,
            encoding: "utf-8",
            env: { ...process.env, PYTHONPATH: this.scriptsDir },
          })).stdout.trim();
        } catch {
          // Non-fatal — distillation works without existing entities
        }
      }

      // Step 1: Distill session into a SessionDigest
      const distillerArgs = [
        resolve(this.scriptsDir, "session_distiller.py"),
        "--memory-dir", this.memoryDir,
        "--transcript", JSON.stringify(transcript),
        "--session-meta", JSON.stringify(sessionMeta),
      ];
      if (existingEntities) {
        distillerArgs.push("--existing-entities", existingEntities);
      }
      const { stdout: digestJson } = await execFileAsync("python3", distillerArgs, {
        timeout: 30_000,
        encoding: "utf-8",
        env: { ...process.env, PYTHONPATH: this.scriptsDir },
      });

      const digest = JSON.parse(digestJson);

      if (digest.isEmpty || digest.error) {
        log(TAG, `distillation skipped: ${digest.error || "empty session"}`);
        this.writeDailyNotesFallback(transcript as any);
        return false;
      }

      log(TAG, `distilled: "${(digest.whatHappened || "").slice(0, 80)}..."`);

      // Write daily session notes
      this.writeDailyNotes(digest, transcript as any);

      // Step 2: Integrate into playbook + knowledge graph
      // Inject raw feed items so integrator stores verbatim quotes + agent analysis
      digest._rawItems = transcript;
      digest._feedItemCount = transcript.length;
      try {
        const { stdout: integratorOutput } = await execFileAsync("python3", [
          resolve(this.scriptsDir, "knowledge_integrator.py"),
          "--memory-dir", this.memoryDir,
          "--digest", JSON.stringify(digest),
          // --transcript wires the zero-LLM extractor (gbrain Proposal A
          // pattern + user-attribute regex set in link_extraction.py).
          // Topic-robust safety net for weak distillers that drop facts.
          "--transcript", JSON.stringify(transcript),
        ], {
          timeout: 60_000, // 60s: LLM call (~10s) + embedding dedup (~5s) + graph ops
          encoding: "utf-8",
          env: { ...process.env, PYTHONPATH: this.scriptsDir },
        });

        const result = JSON.parse(integratorOutput);
        log(TAG, `knowledge integrated: ${JSON.stringify(result.graphStats || result)}`);
      } catch (err: any) {
        warn(TAG, `knowledge integration failed: ${err.message?.slice(0, 200)}`);
      }

      // Step 3: T1-RECON consolidation (entity-attribution, categorical
      // current-state + per-context numeric supersession). Runs over the live KG
      // and integrates derived facts via the same path, so escalation context +
      // KG/MCP queries see them. Default-ON in production (set SINAIN_RECON=0 to
      // disable); fail-open. See reconstruct.py.
      if ((process.env.SINAIN_RECON ?? "1") !== "0") {
        try {
          const { stdout: reconOut } = await execFileAsync("python3", [
            resolve(this.scriptsDir, "reconstruct.py"),
            "--memory-dir", this.memoryDir,
            "--transcript", JSON.stringify(transcript),
          ], {
            timeout: 60_000,
            encoding: "utf-8",
            env: { ...process.env, PYTHONPATH: this.scriptsDir, SINAIN_RECON: "1" },
          });
          log(TAG, `recon consolidated: ${reconOut.trim().slice(0, 120)}`);
        } catch (err: any) {
          warn(TAG, `recon stage failed (non-fatal): ${err.message?.slice(0, 160)}`);
        }
      }
      return true;
    } catch (err: any) {
      warn(TAG, `distillation failed: ${err.message?.slice(0, 200)}`);
      this.writeDailyNotesFallback(transcript as any);
      return false;
    }
  }

  /** Run the periodic curation pipeline.
   * Replaces the bare-agent heartbeat entirely:
   *   signal_analyzer + insight_synthesizer (formerly heartbeat-only)
   *   + feedback_analyzer + memory_miner + playbook_curator (existing).
   * insight_synthesizer output is parsed and, if it emits a suggestion or
   * insight, broadcast to HUD via the constructor's broadcast callback.
   */
  private async runCurationPipeline(): Promise<void> {
    log(TAG, "running periodic curation...");

    const sessionSummary = "Periodic curation cycle";
    const currentTime = new Date().toISOString();

    // Step 1: signal_analyzer — detects actionable signals from session memory
    await this.runScript("signal_analyzer.py", [
      "--memory-dir", this.memoryDir,
      "--session-summary", sessionSummary,
      "--current-time", currentTime,
    ]);

    // Step 2: insight_synthesizer — produces {suggestion, insight}, broadcast to HUD
    const insightOut = await this.runScript("insight_synthesizer.py", [
      "--memory-dir", this.memoryDir,
      "--session-summary", sessionSummary,
      "--current-time", currentTime,
    ], /* captureStdout */ true);
    if (insightOut) this.maybeBroadcastInsight(insightOut);

    // Steps 3-5: existing periodic pipeline (feedback → mining → curation)
    for (const script of ["feedback_analyzer.py", "memory_miner.py", "playbook_curator.py"]) {
      await this.runScript(script, ["--memory-dir", this.memoryDir]);
    }

    log(TAG, "periodic curation complete");
  }

  /** Run a single curation script. Returns captured stdout when requested, else empty. */
  private async runScript(script: string, args: string[], captureStdout = false): Promise<string> {
    const scriptPath = resolve(this.scriptsDir, script);
    if (!existsSync(scriptPath)) {
      warn(TAG, `${script} not found — skipping`);
      return "";
    }
    try {
      const { stdout } = await execFileAsync("python3", [scriptPath, ...args], {
        timeout: 60_000,
        encoding: "utf-8",
        env: { ...process.env, PYTHONPATH: this.scriptsDir },
      });
      log(TAG, `  ✓ ${script}`);
      return captureStdout ? (stdout || "") : "";
    } catch (err: any) {
      warn(TAG, `  ✗ ${script}: ${err.message?.slice(0, 100)}`);
      return "";
    }
  }

  /** Parse insight_synthesizer stdout (expects JSON with {suggestion?, insight?})
   *  and broadcast non-empty fields to the HUD feed. Safe no-op if JSON parsing
   *  fails or if no broadcast callback was wired. */
  private maybeBroadcastInsight(stdout: string): void {
    if (!this._broadcast) return;
    const lines = stdout.trim().split("\n").filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(line);
        const suggestion = typeof parsed.suggestion === "string" ? parsed.suggestion.trim() : "";
        const insight = typeof parsed.insight === "string" ? parsed.insight.trim() : "";
        if (suggestion) {
          log(TAG, `  posting suggestion to HUD (${suggestion.length} chars)`);
          this._broadcast(suggestion);
        }
        if (insight && insight !== suggestion) {
          log(TAG, `  posting insight to HUD (${insight.length} chars)`);
          this._broadcast(insight);
        }
        return;
      } catch { /* try previous line */ }
    }
  }

  /** Write distilled session notes to daily file. */
  private writeDailyNotes(digest: any, feedItems: FeedItem[]): void {
    const date = new Date().toISOString().slice(0, 10);
    const notesPath = resolve(this.memoryDir, `${date}.md`);

    const sections = [
      `## Session ${new Date().toISOString().slice(11, 16)} UTC`,
      "",
      `### Summary`,
      digest.whatHappened || "(no summary)",
      "",
    ];

    if (digest.patterns?.length > 0) {
      sections.push("### Patterns Observed");
      for (const p of digest.patterns) {
        sections.push(`- ${typeof p === "string" ? p : p.pattern || JSON.stringify(p)}`);
      }
      sections.push("");
    }

    if (digest.entities?.length > 0) {
      sections.push("### Entities");
      sections.push(digest.entities.map((e: string) => `\`${e}\``).join(", "));
      sections.push("");
    }

    if (digest.preferences?.length > 0) {
      sections.push("### User Preferences");
      for (const p of digest.preferences) {
        sections.push(`- ${typeof p === "string" ? p : JSON.stringify(p)}`);
      }
      sections.push("");
    }

    // Append (don't overwrite — multiple sessions per day)
    const content = sections.join("\n") + "\n---\n\n";
    appendFileSync(notesPath, content, "utf-8");
    log(TAG, `daily notes written: ${notesPath}`);
  }

  /** Fallback: write raw feed summary when distillation fails. */
  private writeDailyNotesFallback(feedItems: FeedItem[]): void {
    if (feedItems.length < 1) return;

    const date = new Date().toISOString().slice(0, 10);
    const notesPath = resolve(this.memoryDir, `${date}.md`);

    const agentItems = feedItems.filter(i => i.source === "openclaw" || i.text.startsWith("[🤖]") || i.text.startsWith("[🔧"));
    const audioItems = feedItems.filter(i => i.text.startsWith("[🔊]"));

    const sections = [
      `## Session ${new Date().toISOString().slice(11, 16)} UTC (raw — distillation unavailable)`,
      "",
      `${feedItems.length} feed items, ${audioItems.length} audio, ${agentItems.length} agent responses`,
      "",
    ];

    // Include agent responses (most valuable)
    if (agentItems.length > 0) {
      sections.push("### Agent Responses");
      for (const item of agentItems.slice(-10)) {
        sections.push(`- ${item.text.slice(0, 200)}`);
      }
      sections.push("");
    }

    // Include audio highlights (first 5 non-trivial)
    const meaningfulAudio = audioItems.filter(i => i.text.length > 20 && !i.text.includes("Thank you") && !i.text.includes("Okay"));
    if (meaningfulAudio.length > 0) {
      sections.push("### Audio Highlights");
      for (const item of meaningfulAudio.slice(0, 10)) {
        sections.push(`- ${item.text}`);
      }
      sections.push("");
    }

    const content = sections.join("\n") + "\n---\n\n";
    appendFileSync(notesPath, content, "utf-8");
    log(TAG, `daily notes (fallback) written: ${notesPath}`);
  }
}
