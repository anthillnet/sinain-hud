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

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FeedItem } from "../types.js";
import { log, warn, error } from "../log.js";

const TAG = "local-curation";
const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve the sinain-memory Python scripts directory. */
function resolveScriptsDir(): string {
  // Look for sinain-memory scripts in known locations
  const candidates = [
    resolve(__dirname, "..", "..", "..", "sinain-hud-plugin", "sinain-memory"),
    resolve(__dirname, "..", "..", "sinain-memory"),
    resolve(process.env.HOME || "", ".sinain", "sinain-memory"),
  ];
  for (const dir of candidates) {
    if (existsSync(resolve(dir, "session_distiller.py"))) {
      return dir;
    }
  }
  return candidates[0]; // Fallback
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
  }

  /** Start periodic curation (30-minute timer). */
  startPeriodicCuration(): void {
    if (this.curationTimer) return;
    const intervalMs = 30 * 60 * 1000; // 30 minutes
    this.curationTimer = setInterval(() => {
      this.runCurationPipeline();
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

  /**
   * Distill the current session on shutdown.
   * Extracts feed items, calls session_distiller + knowledge_integrator.
   */
  async distillSession(feedItems: FeedItem[]): Promise<void> {
    if (!existsSync(resolve(this.scriptsDir, "session_distiller.py"))) {
      warn(TAG, "session_distiller.py not found — skipping distillation");
      this.writeDailyNotesFallback(feedItems);
      return;
    }

    if (feedItems.length < 3) {
      log(TAG, `skipping distillation — only ${feedItems.length} feed items`);
      return;
    }

    const sessionMeta = {
      ts: new Date().toISOString(),
      sessionKey: "local-session",
      durationMs: Date.now() - this.sessionStartTs,
    };

    // Format feed items for the distiller
    const transcript = feedItems.map(item => ({
      text: item.text,
      ts: item.ts,
      source: item.source || "unknown",
      channel: item.channel || "agent",
    }));

    log(TAG, `distilling session: ${feedItems.length} items, ${Math.round(sessionMeta.durationMs / 60000)} min`);

    try {
      // Step 1: Distill session into a SessionDigest
      const digestJson = execFileSync("python3", [
        resolve(this.scriptsDir, "session_distiller.py"),
        "--memory-dir", this.memoryDir,
        "--transcript", JSON.stringify(transcript),
        "--session-meta", JSON.stringify(sessionMeta),
      ], {
        timeout: 30_000,
        encoding: "utf-8",
        env: { ...process.env, PYTHONPATH: this.scriptsDir },
      });

      const digest = JSON.parse(digestJson);

      if (digest.isEmpty || digest.error) {
        log(TAG, `distillation skipped: ${digest.error || "empty session"}`);
        this.writeDailyNotesFallback(feedItems);
        return;
      }

      log(TAG, `distilled: "${(digest.whatHappened || "").slice(0, 80)}..."`);

      // Write daily session notes
      this.writeDailyNotes(digest, feedItems);

      // Step 2: Integrate into playbook + knowledge graph
      try {
        const integratorOutput = execFileSync("python3", [
          resolve(this.scriptsDir, "knowledge_integrator.py"),
          "--memory-dir", this.memoryDir,
          "--digest", JSON.stringify(digest),
        ], {
          timeout: 30_000,
          encoding: "utf-8",
          env: { ...process.env, PYTHONPATH: this.scriptsDir },
        });

        const result = JSON.parse(integratorOutput);
        log(TAG, `knowledge integrated: ${JSON.stringify(result.graphStats || result)}`);
      } catch (err: any) {
        warn(TAG, `knowledge integration failed: ${err.message?.slice(0, 200)}`);
      }
    } catch (err: any) {
      warn(TAG, `distillation failed: ${err.message?.slice(0, 200)}`);
      this.writeDailyNotesFallback(feedItems);
    }
  }

  /** Run the periodic curation pipeline (feedback → mining → curation). */
  private runCurationPipeline(): void {
    log(TAG, "running periodic curation...");

    const scripts = [
      "feedback_analyzer.py",
      "memory_miner.py",
      "playbook_curator.py",
    ];

    for (const script of scripts) {
      const scriptPath = resolve(this.scriptsDir, script);
      if (!existsSync(scriptPath)) {
        warn(TAG, `${script} not found — skipping`);
        continue;
      }

      try {
        execFileSync("python3", [
          scriptPath,
          "--memory-dir", this.memoryDir,
        ], {
          timeout: 60_000,
          encoding: "utf-8",
          env: { ...process.env, PYTHONPATH: this.scriptsDir },
        });
        log(TAG, `  ✓ ${script}`);
      } catch (err: any) {
        warn(TAG, `  ✗ ${script}: ${err.message?.slice(0, 100)}`);
      }
    }

    log(TAG, "periodic curation complete");
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
    if (feedItems.length < 3) return;

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
