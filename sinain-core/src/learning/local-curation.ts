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
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, appendFileSync, renameSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
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
import { log, warn, error, preview } from "../log.js";
import { redactForDisk, redactText } from "../privacy/index.js";

// Feed-item text is tagged by source; audio items start with the speaker emoji.
// Persisted feed text gets the on-disk privacy level (audio level for audio
// items; secret-strip floor for the rest, which are agent/system responses).
function redactFeedTextForDisk(text: string): string {
  return text.startsWith("[🔊]")
    ? redactForDisk(text, "audio_transcript")
    : redactText(text);
}

const TAG = "local-curation";
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── T1 episode capture (memoryd, DESIGN-MEMORY-V2 P1) ──
// Fire-and-forget over the memory daemon's socket. Deterministic + zero-LLM
// on the daemon side; text is redacted to the on-disk level BEFORE sending
// (episodes persist to episodes.jsonl). Failure is silent by design: the
// daemon may be starting up / absent — episode capture is additive during
// the dual-write transition, never load-bearing for the legacy pipeline.
const MEMORYD_SOCK = process.env.SINAIN_KG_SOCK || "/tmp/sinain-kg.sock";

/** Send one pre-redacted event episode (WSM breakpoint/return, §3.8) to
 *  memoryd. Fire-and-forget like sendEpisodes; caller redacts text. */
export function sendMemorydEpisode(ep: {
  kind: string; context_id: string; text: string; ts: string;
  summary?: string; entities?: string[]; meta?: Record<string, unknown>;
}): void {
  import("node:net").then(({ connect }) => {
    const sock = connect(MEMORYD_SOCK);
    sock.setTimeout(3000, () => sock.destroy());
    sock.on("error", () => { /* daemon absent — additive */ });
    sock.on("connect", () => sock.write(JSON.stringify({ op: "ingest", episode: ep }) + "\n"));
    sock.on("data", () => sock.destroy());
  }).catch(() => { /* ignore */ });
}

function sendEpisodes(items: Array<{ text: string; ts: number | string; source: string; channel: string }>): void {
  if (items.length === 0) return;
  import("node:net").then(({ connect }) => {
    const payload = JSON.stringify({
      op: "ingest",
      context_id: "live",
      items: items.map((i) => ({
        source: i.source,
        text: redactFeedTextForDisk(String(i.text)),
        ts: typeof i.ts === "number" ? new Date(i.ts).toISOString() : String(i.ts),
        channel: i.channel,
      })),
    }) + "\n";
    const sock = connect(MEMORYD_SOCK);
    sock.setTimeout(3000, () => sock.destroy());
    sock.on("error", () => { /* daemon absent — additive capture, no-op */ });
    sock.on("connect", () => sock.write(payload));
    sock.on("data", () => sock.destroy());
  }).catch(() => { /* ignore */ });
}

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

/** Python interpreter for the sinain-memory scripts. The packaged launcher
 *  sets SINAIN_PYTHON to the one interpreter that has the deps — bare
 *  "python3" can resolve to a dep-less install (e.g. homebrew without
 *  `requests`) and fail every save distillation. Mirrors index.ts. */
const PYTHON_BIN = process.env.SINAIN_PYTHON || "python3";

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
  private _lastPriorRefreshTs = 0;
  private _lastDistilledTs = 0; // watermark: max item ts covered by a completed distillation
  private _distillRunning = false; // serializes ALL distillation runs (incremental + pending)
  private _rearmCb: (() => void) | null = null; // callback to re-arm feed buffer onFull
  private _senseBuffer: SenseBuffer | null = null;

  constructor() {
    this.memoryDir = resolveMemoryDir();
    this.scriptsDir = resolveScriptsDir();
    this.sessionStartTs = Date.now();

    // Ensure memory directory exists
    for (const subdir of ["", "playbook-logs", "playbook-archive", "eval-logs", "eval-reports"]) {
      const dir = resolve(this.memoryDir, subdir);
      mkdirSync(dir, { recursive: true });
    }

    log(TAG, `memory: ${this.memoryDir}`);
    log(TAG, `scripts: ${this.scriptsDir}`);
    log(TAG, `scripts available: ${existsSync(resolve(this.scriptsDir, "session_distiller.py"))}`);

    // First-run: ensure a WSM/Athium prior exists. Delayed so prior_builder can
    // use core /embed rather than loading a local model; later refreshes ride
    // distillation (KG-changed).
    if (!existsSync(resolve(this.memoryDir, "workstate-prior.json"))) {
      setTimeout(() => void this.refreshWorkStatePrior(true), 20_000).unref?.();
    }
  }

  /** Rebuild the WSM/Athium per-user prior from the current KG (best-effort,
   *  throttled to ≤1/10min). The WorkStateEngine hot-reloads
   *  workstate-prior.json on mtime change, so threads track the KG without a
   *  manual rebuild. */
  async refreshWorkStatePrior(force = false): Promise<void> {
    // prior_builder.py ships with the WSM lane, not every bundle — skip
    // silently instead of warn-spamming each refresh (QA flagged the noise).
    if (!existsSync(resolve(this.scriptsDir, "prior_builder.py"))) return;
    const now = Date.now();
    if (!force && now - this._lastPriorRefreshTs < 10 * 60 * 1000) return;
    this._lastPriorRefreshTs = now;
    await this.runScript("prior_builder.py", ["--memory-dir", this.memoryDir]);
  }

  /** Run a single curation script. Returns captured stdout when requested, else empty. */
  private async runScript(script: string, args: string[], captureStdout = false): Promise<string> {
    const scriptPath = resolve(this.scriptsDir, script);
    if (!existsSync(scriptPath)) {
      warn(TAG, `${script} not found — skipping`);
      return "";
    }
    try {
      const { stdout } = await execFileAsync(PYTHON_BIN, [scriptPath, ...args], {
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

  /** True while a distillation pipeline (incremental or pending) is in flight. */
  get distillRunning(): boolean {
    return this._distillRunning;
  }

  /** Wait (bounded) for any in-flight distillation to finish. Called during
   *  shutdown: exiting while a spawned integrator/recon child is mid-write
   *  risks the child being orphaned and later force-killed mid-RocksDB-write —
   *  the corruption path behind the knowledge-graph.db.corrupt-* quarantines. */
  async waitForIdle(timeoutMs = 20_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this._distillRunning && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    return !this._distillRunning;
  }

  /**
   * Deterministic episode capture — fires when the feed buffer reaches
   * capacity. T1 episodes go to memoryd (local socket write, NO LLM); the
   * watermark prevents re-capturing items covered by a previous pass.
   * The LLM distillation that used to ride this trigger was REMOVED
   * (2026-07-12): passive processing must be deterministic and local —
   * the LLM runs only on the explicit Save gesture (distillOnly).
   */
  captureEpisodes(feedItems: FeedItem[]): void {
    try {
      const newItems = this._lastDistilledTs > 0
        ? feedItems.filter((i) => i.ts > this._lastDistilledTs)
        : feedItems;
      const audioItems = newItems.map(item => ({
        text: item.text,
        ts: item.ts,
        source: item.source || "unknown",
        channel: item.channel || "agent",
      }));
      const senseItems = this.getSenseContext();
      const transcript = [...audioItems, ...senseItems].sort((a, b) => a.ts - b.ts);
      if (transcript.length > 0) {
        sendEpisodes(transcript as any);
        this._lastDistilledTs = Math.max(...transcript.map((i) => i.ts));
      }
    } finally {
      // Re-arm the buffer callback so the next fill captures again.
      this._rearmCb?.();
    }
  }

  /**
   * Shutdown episode capture — instant, deterministic, no LLM. The old
   * pending-session.json write existed only to feed a startup LLM
   * re-distillation; that lane was removed (2026-07-12) — un-saved window
   * content expires with the rolling window, by design.
   */
  captureShutdownEpisodes(feedItems: FeedItem[]): void {
    if (feedItems.length < 1) return;
    const items = feedItems.map(item => ({
      // Redact before it leaves the process — memoryd persists episodes to disk.
      text: redactFeedTextForDisk(item.text),
      ts: item.ts,
      source: item.source || "unknown",
      channel: item.channel || "agent",
    }));
    sendEpisodes(items as any);
    log(TAG, `shutdown episodes captured: ${items.length} feed items`);
  }



  /**
   * Deliberate-capture save, step 1: distill a user-selected range into a
   * SessionDigest WITHOUT integrating it. The digest's fact/entity counts feed
   * the save receipt; integration is deferred until the undo window expires
   * (integrateDigest below), which is what makes undo a real cancel instead of
   * a graph delete.
   */
  async distillOnly(
    transcript: Array<{ text: string; ts: number; source: string; channel: string }>,
    sessionMeta: { ts: string; sessionKey: string; durationMs: number; source?: string; saveId?: string },
  ): Promise<any | null> {
    if (!existsSync(resolve(this.scriptsDir, "session_distiller.py"))) {
      warn(TAG, "session_distiller.py not found — cannot distill save");
      return null;
    }
    const diskTranscript = transcript.map((i) => ({ ...i, text: redactFeedTextForDisk(String(i.text ?? "")) }));
    const tmpTag = `sinain-save-${process.pid}-${randomBytes(4).toString("hex")}`;
    const transcriptFile = join(tmpdir(), `${tmpTag}-transcript.json`);
    try {
      writeFileSync(transcriptFile, JSON.stringify(diskTranscript), { encoding: "utf-8", mode: 0o600 });
      // A user-save can span hours of transcript — far bigger than the
      // incremental batches. 30s here killed every 60-min save mid-distill
      // ("distillation produced nothing" receipts); the LLM needs real time.
      const { stdout: digestJson } = await execFileAsync(PYTHON_BIN, [
        resolve(this.scriptsDir, "session_distiller.py"),
        "--memory-dir", this.memoryDir,
        "--transcript-file", transcriptFile,
        "--session-meta", JSON.stringify(sessionMeta),
      ], {
        timeout: 120_000,
        encoding: "utf-8",
        env: { ...process.env, PYTHONPATH: this.scriptsDir },
      });
      const digest = JSON.parse(digestJson);
      if (digest.isEmpty || digest.error) {
        log(TAG, `save distillation empty: ${digest.error || "no content"}`);
        return null;
      }
      digest._rawItems = diskTranscript;
      digest._feedItemCount = diskTranscript.length;
      return digest;
    } catch (err: any) {
      // Rethrow so the save receipt reports the real failure — a timeout is
      // not "nothing to save in that range".
      // err.message leads with the full command line — the useful part is the
      // Python stderr (traceback), so surface that when present.
      const detail = (err.stderr?.trim() || err.message || "").slice(-300);
      const reason = err.killed
        ? "distiller timed out (120s) — range too large?"
        : `distiller failed: ${detail}`;
      warn(TAG, `save distillation failed: ${reason}`);
      throw new Error(reason);
    } finally {
      try { unlinkSync(transcriptFile); } catch { /* gone */ }
    }
  }

  /**
   * Deliberate-capture save, step 2: integrate a previously distilled digest
   * into the knowledge graph (runs after the undo window closes).
   */
  async integrateDigest(digest: any): Promise<boolean> {
    const tmpTag = `sinain-save-${process.pid}-${randomBytes(4).toString("hex")}`;
    const digestFile = join(tmpdir(), `${tmpTag}-digest.json`);
    const transcriptFile = join(tmpdir(), `${tmpTag}-transcript.json`);
    try {
      writeFileSync(digestFile, JSON.stringify(digest), { encoding: "utf-8", mode: 0o600 });
      writeFileSync(transcriptFile, JSON.stringify(digest._rawItems ?? []), { encoding: "utf-8", mode: 0o600 });
      const { stdout } = await execFileAsync(PYTHON_BIN, [
        resolve(this.scriptsDir, "knowledge_integrator.py"),
        "--memory-dir", this.memoryDir,
        "--digest-file", digestFile,
        "--transcript-file", transcriptFile,
      ], {
        timeout: 60_000,
        encoding: "utf-8",
        env: { ...process.env, PYTHONPATH: this.scriptsDir },
      });
      const result = JSON.parse(stdout);
      log(TAG, `save integrated: ${JSON.stringify(result.graphStats || result)}`);
      await this.refreshWorkStatePrior();
      return true;
    } catch (err: any) {
      warn(TAG, `save integration failed: ${(err.stderr?.trim() || err.message || "").slice(-300)}`);
      return false;
    } finally {
      for (const f of [digestFile, transcriptFile]) {
        try { unlinkSync(f); } catch { /* gone */ }
      }
    }
  }

  /** Sense-context items for an arbitrary range (deliberate-capture save). */
  senseContextForRange(sinceTs: number, includeApps?: string[]): Array<{ text: string; ts: number; source: string; channel: string }> {
    if (!this._senseBuffer) return [];
    const items: Array<{ text: string; ts: number; source: string; channel: string }> = [];
    for (const evt of this._senseBuffer.queryByTime(sinceTs)) {
      const app = evt.semantic?.context?.app || evt.meta.app || "unknown";
      // App scope (chooser chips): deselected apps' screen content stays out.
      // Consent-first: unattributable ("unknown") events could be FROM a
      // deselected app — under any scope only allow-listed apps pass.
      if (includeApps && !includeApps.includes(app)) continue;
      if (evt.ocr && evt.ocr.length > 20) {
        items.push({ text: `[screen: ${app}] ${evt.ocr}`, ts: evt.ts, source: "sense", channel: "screen" });
      }
      if (evt.semantic?.visible?.summary) {
        items.push({ text: `[screen-context] ${evt.semantic.visible.summary}`, ts: evt.ts, source: "sense", channel: "screen" });
      }
    }
    return items;
  }


  /** Write distilled session notes to daily file. */
  private writeDailyNotes(digest: any, feedItems: FeedItem[]): void {
    const date = new Date().toISOString().slice(0, 10);
    const notesPath = resolve(this.memoryDir, `${date}.md`);

    const sections = [
      `## Session ${new Date().toISOString().slice(11, 16)} UTC`,
      "",
      `### Summary`,
      redactText(digest.whatHappened || "(no summary)"),
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

}
