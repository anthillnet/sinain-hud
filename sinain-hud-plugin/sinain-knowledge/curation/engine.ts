/**
 * sinain-knowledge — CurationEngine
 *
 * Orchestrates heartbeat tick execution, curation pipeline, and context assembly.
 * Decoupled from OpenClaw — uses KnowledgeStore for file I/O and ScriptRunner for
 * external process execution.
 */

import type { Logger, ScriptRunner } from "../data/schema.js";
import type { KnowledgeStore } from "../data/store.js";
import type { ResilienceManager } from "./resilience.js";
import type { GitSnapshotStore } from "../data/git-store.js";

// ============================================================================
// Types
// ============================================================================

export type HeartbeatResult = {
  status: string;
  gitBackup: string | null;
  signals: unknown[];
  recommendedAction: { action: string; task: string | null; confidence: number };
  output: unknown | null;
  skipped: boolean;
  skipReason: string | null;
  logWritten: boolean;
  [key: string]: unknown;
};

export type ContextAssemblyOpts = {
  isSubagent: boolean;
  parentContextText?: string | null;
  parentContextAgeMs?: number;
  parentContextTtlMs: number;
  heartbeatConfigured: boolean;
  heartbeatTargetExists: boolean;
};

// ============================================================================
// CurationEngine
// ============================================================================

export class CurationEngine {
  private curationInterval: ReturnType<typeof setInterval> | null = null;
  private gitSnapshotStore: GitSnapshotStore | null = null;

  constructor(
    private store: KnowledgeStore,
    private runScript: ScriptRunner,
    private resilience: ResilienceManager,
    private config: { userTimezone: string },
    private logger: Logger,
  ) {}

  /** Attach a git-backed snapshot store for periodic saves. */
  setGitSnapshotStore(gitStore: GitSnapshotStore): void {
    this.gitSnapshotStore = gitStore;
  }

  // ── Heartbeat Tick ──────────────────────────────────────────────────────

  async executeHeartbeatTick(params: {
    sessionSummary: string;
    idle: boolean;
  }): Promise<HeartbeatResult> {
    const workspaceDir = this.store.getWorkspaceDir();
    const result: HeartbeatResult = {
      status: "ok",
      gitBackup: null,
      signals: [],
      recommendedAction: { action: "skip", task: null, confidence: 0 },
      output: null,
      skipped: false,
      skipReason: null,
      logWritten: false,
    };

    const runPythonScript = async (
      args: string[],
      timeoutMs = 60_000,
    ): Promise<Record<string, unknown> | null> => {
      try {
        const out = await this.runScript(
          ["uv", "run", "--with", "requests", "python3", ...args],
          { timeoutMs, cwd: workspaceDir },
        );
        if (out.code !== 0) {
          this.logger.warn(
            `sinain-hud: heartbeat script failed: ${args[0]} (code ${out.code})\n${out.stderr}`,
          );
          return null;
        }
        return JSON.parse(out.stdout.trim());
      } catch (err) {
        this.logger.warn(
          `sinain-hud: heartbeat script error: ${args[0]}: ${String(err)}`,
        );
        return null;
      }
    };

    const latencyMs: Record<string, number> = {};
    const heartbeatStart = Date.now();

    // 1. Git backup (30s timeout)
    try {
      const t0 = Date.now();
      const gitOut = await this.runScript(
        ["bash", "sinain-memory/git_backup.sh"],
        { timeoutMs: 30_000, cwd: workspaceDir },
      );
      latencyMs.gitBackup = Date.now() - t0;
      result.gitBackup = gitOut.stdout.trim() || "nothing to commit";
    } catch (err) {
      this.logger.warn(`sinain-hud: git backup error: ${String(err)}`);
      result.gitBackup = `error: ${String(err)}`;
    }

    // Current time string for memory scripts
    const hbTz = this.config.userTimezone;
    const currentTimeStr = new Date().toLocaleString("en-GB", {
      timeZone: hbTz, weekday: "long", year: "numeric", month: "long",
      day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    }) + ` (${hbTz})`;

    // 2. Signal analysis (60s timeout)
    const signalArgs = [
      "sinain-memory/signal_analyzer.py",
      "--memory-dir", "memory/",
      "--session-summary", params.sessionSummary,
      "--current-time", currentTimeStr,
    ];
    if (params.idle) signalArgs.push("--idle");

    const signalT0 = Date.now();
    const signalResult = await runPythonScript(signalArgs, 60_000);
    latencyMs.signalAnalysis = Date.now() - signalT0;
    if (signalResult) {
      result.signals = signalResult.signals as unknown[] ?? [];
      result.recommendedAction = (signalResult.recommendedAction as HeartbeatResult["recommendedAction"]) ?? {
        action: "skip",
        task: null,
        confidence: 0,
      };

      // Fire-and-forget: ingest signal into triple store
      const tickTs = new Date().toISOString();
      runPythonScript([
        "sinain-memory/triple_ingest.py",
        "--memory-dir", "memory/",
        "--tick-ts", tickTs,
        "--signal-result", JSON.stringify(signalResult),
        "--embed",
      ], 15_000).catch(() => {});
    }

    // 3. Insight synthesis (60s timeout)
    const synthArgs = [
      "sinain-memory/insight_synthesizer.py",
      "--memory-dir", "memory/",
      "--session-summary", params.sessionSummary,
      "--current-time", currentTimeStr,
    ];
    if (params.idle) synthArgs.push("--idle");

    const synthT0 = Date.now();
    const synthResult = await runPythonScript(synthArgs, 60_000);
    latencyMs.insightSynthesis = Date.now() - synthT0;
    if (synthResult) {
      if (synthResult.skip === false) {
        result.output = {
          suggestion: synthResult.suggestion ?? null,
          insight: synthResult.insight ?? null,
        };
      } else {
        result.skipped = true;
        result.skipReason = (synthResult.skipReason as string) ?? "synthesizer skipped";
      }
    }

    // 4. Write log entry
    try {
      const totalLatencyMs = Date.now() - heartbeatStart;
      const logEntry = {
        ts: new Date().toISOString(),
        idle: params.idle,
        sessionHistorySummary: params.sessionSummary,
        signals: result.signals,
        recommendedAction: result.recommendedAction,
        output: result.output,
        skipped: result.skipped,
        skipReason: result.skipReason,
        gitBackup: result.gitBackup,
        latencyMs,
        totalLatencyMs,
      };

      this.store.appendPlaybookLog(logEntry);
      result.logWritten = true;
    } catch (err) {
      this.logger.warn(
        `sinain-hud: failed to write heartbeat log: ${String(err)}`,
      );
    }

    return result;
  }

  // ── Curation Pipeline ──────────────────────────────────────────────────

  async runCurationPipeline(): Promise<void> {
    const workspaceDir = this.store.getWorkspaceDir();

    const runPythonScript = async (
      args: string[],
      timeoutMs = 90_000,
    ): Promise<Record<string, unknown> | null> => {
      try {
        const out = await this.runScript(
          ["uv", "run", "--with", "requests", "python3", ...args],
          { timeoutMs, cwd: workspaceDir },
        );
        if (out.code !== 0) {
          this.logger.warn(
            `sinain-hud: curation script failed: ${args[0]} (code ${out.code})\n${out.stderr}`,
          );
          return null;
        }
        return JSON.parse(out.stdout.trim());
      } catch (err) {
        this.logger.warn(
          `sinain-hud: curation script error: ${args[0]}: ${String(err)}`,
        );
        return null;
      }
    };

    this.logger.info("sinain-hud: curation pipeline starting");
    const curationLatency: Record<string, number> = {};

    // Step 1: Feedback analysis
    const feedbackT0 = Date.now();
    const feedback = await runPythonScript([
      "sinain-memory/feedback_analyzer.py",
      "--memory-dir", "memory/",
      "--session-summary", "periodic curation (plugin timer)",
    ]);
    curationLatency.feedback = Date.now() - feedbackT0;
    const directive = (feedback as Record<string, unknown> | null)?.curateDirective as string ?? "stability";

    // Step 2: Memory mining
    const miningT0 = Date.now();
    const mining = await runPythonScript([
      "sinain-memory/memory_miner.py",
      "--memory-dir", "memory/",
    ]);
    curationLatency.mining = Date.now() - miningT0;
    const findings = mining?.findings ? JSON.stringify(mining.findings) : null;

    // Fire-and-forget: ingest mining results
    if (mining) {
      runPythonScript([
        "sinain-memory/triple_ingest.py",
        "--memory-dir", "memory/",
        "--ingest-mining", JSON.stringify(mining),
        "--embed",
      ], 15_000).catch(() => {});
    }

    // Step 3: Playbook curation
    const curatorArgs = [
      "sinain-memory/playbook_curator.py",
      "--memory-dir", "memory/",
      "--session-summary", "periodic curation (plugin timer)",
      "--curate-directive", directive,
    ];
    if (findings) {
      curatorArgs.push("--mining-findings", findings);
    }
    const curatorT0 = Date.now();
    const curator = await runPythonScript(curatorArgs);
    curationLatency.curation = Date.now() - curatorT0;

    // Fire-and-forget: ingest playbook patterns
    runPythonScript([
      "sinain-memory/triple_ingest.py",
      "--memory-dir", "memory/",
      "--ingest-playbook",
      "--embed",
    ], 15_000).catch(() => {});

    // Step 4: Update effectiveness footer
    const effectiveness = (feedback as Record<string, unknown> | null)?.effectiveness;
    if (effectiveness && typeof effectiveness === "object") {
      try {
        this.store.updateEffectivenessFooter(effectiveness as Record<string, unknown>);
      } catch (err) {
        this.logger.warn(`sinain-hud: effectiveness footer update failed: ${String(err)}`);
      }
    }

    // Step 5: Regenerate effective playbook
    this.store.generateEffectivePlaybook();

    // Step 6: Tick evaluation
    await runPythonScript([
      "sinain-memory/tick_evaluator.py",
      "--memory-dir", "memory/",
    ], 120_000);

    // Step 7: Daily eval report (once per day after 03:00 UTC)
    const nowUTC = new Date();
    const todayStr = nowUTC.toISOString().slice(0, 10);
    if (nowUTC.getUTCHours() >= 3 && this.resilience.lastEvalReportDate !== todayStr) {
      await runPythonScript([
        "sinain-memory/eval_reporter.py",
        "--memory-dir", "memory/",
      ], 120_000);
      this.resilience.lastEvalReportDate = todayStr;
    }

    // Step 8: Periodic snapshot save to local git repo
    if (this.gitSnapshotStore) {
      try {
        const snapT0 = Date.now();
        const hash = this.gitSnapshotStore.save(this.store);
        curationLatency.snapshotSave = Date.now() - snapT0;
        this.logger.info(`sinain-hud: periodic snapshot saved → ${hash}`);
        this.gitSnapshotStore.prune();
      } catch (err) {
        this.logger.warn(`sinain-hud: periodic snapshot save failed: ${String(err)}`);
      }
    }

    // Log result
    const changes = (curator as Record<string, unknown> | null)?.changes ?? "unknown";
    this.logger.info(
      `sinain-hud: curation pipeline complete (directive=${directive}, changes=${JSON.stringify(changes)}, latency=${JSON.stringify(curationLatency)})`,
    );

    // Write curation log
    if (curator) {
      try {
        const curatorChanges = (curator as Record<string, unknown>).changes as Record<string, string[]> | undefined;
        const curationEntry = {
          _type: "curation",
          ts: new Date().toISOString(),
          directive,
          playbookChanges: {
            added:    curatorChanges?.added    ?? [],
            pruned:   curatorChanges?.pruned   ?? [],
            promoted: curatorChanges?.promoted ?? [],
            playbookLines: (curator as Record<string, unknown>).playbookLines ?? 0,
          },
          latencyMs: curationLatency,
        };
        this.store.appendCurationLog(curationEntry);
      } catch (err) {
        this.logger.warn(`sinain-hud: failed to write curation log entry: ${String(err)}`);
      }
    }
  }

  // ── Context Assembly ───────────────────────────────────────────────────

  async assembleContext(opts: ContextAssemblyOpts): Promise<string[]> {
    const workspaceDir = this.store.getWorkspaceDir();
    const contextParts: string[] = [];

    // Time awareness
    const userTz = this.config.userTimezone;
    const nowLocal = new Date().toLocaleString("en-GB", {
      timeZone: userTz,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    contextParts.push(`[CURRENT TIME] ${nowLocal} (${userTz})`);

    // Recovery context injection after outage
    if (this.resilience.outageStartTs > 0 && !this.resilience.outageDetected && this.resilience.lastSuccessTs > this.resilience.outageStartTs) {
      const outageDurationMin = Math.round((this.resilience.lastSuccessTs - this.resilience.outageStartTs) / 60_000);
      this.resilience.outageStartTs = 0;
      this.logger.info(`sinain-hud: injecting recovery context (outage lasted ~${outageDurationMin}min)`);
      contextParts.push(
        `[SYSTEM] The upstream API was unavailable for ~${outageDurationMin} minutes. ` +
        `Multiple queued messages may have accumulated. Prioritize the current task, skip catch-up on stale items, and keep responses concise.`,
      );
    }

    // Subagent: inject cached parent context
    if (opts.isSubagent && opts.parentContextText) {
      const cacheAgeMs = opts.parentContextAgeMs ?? 0;
      if (cacheAgeMs < opts.parentContextTtlMs) {
        const cacheAgeSec = Math.round(cacheAgeMs / 1000);
        this.logger.info(
          `sinain-hud: injected parent context for subagent (${opts.parentContextText.length} chars, ${cacheAgeSec}s old)`,
        );
        contextParts.push(
          `[PARENT SESSION CONTEXT] The following is a summary of the recent conversation from the parent session that spawned you. Use it to understand references to code, files, or decisions discussed earlier:\n\n${opts.parentContextText}`,
        );
      } else {
        this.logger.info(
          `sinain-hud: skipped stale parent context for subagent (${Math.round(cacheAgeMs / 1000)}s old, TTL=${opts.parentContextTtlMs / 1000}s)`,
        );
      }
    }

    // Heartbeat enforcement
    if (opts.heartbeatConfigured && opts.heartbeatTargetExists) {
      contextParts.push(
        "[HEARTBEAT PROTOCOL] HEARTBEAT.md is loaded in your project context. " +
        "On every heartbeat poll, you MUST execute the full protocol defined in " +
        "HEARTBEAT.md — all phases, all steps, in order. " +
        "Only reply HEARTBEAT_OK if HEARTBEAT.md explicitly permits it " +
        "after you have completed all mandatory steps."
      );
    }

    // SITUATION.md
    const situationContent = this.store.readSituation();
    if (situationContent) contextParts.push(`[SITUATION]\n${situationContent}`);

    // Knowledge transfer attribution
    const effectiveContent = this.store.readEffectivePlaybook();
    if (effectiveContent?.includes("[Transferred knowledge:")) {
      contextParts.push(
        "[KNOWLEDGE TRANSFER] Some patterns in your playbook were transferred from " +
        "another sinain instance. When surfacing these, briefly cite their origin."
      );
    }

    // Module guidance
    const moduleGuidance = this.store.getActiveModuleGuidance();
    if (moduleGuidance) contextParts.push(moduleGuidance);

    // Knowledge graph context (10s timeout)
    try {
      const ragResult = await this.runScript(
        ["uv", "run", "--with", "requests", "python3",
         "sinain-memory/triple_query.py",
         "--memory-dir", "memory",
         "--context", "current session",
         "--max-chars", "1500"],
        { timeoutMs: 10_000, cwd: workspaceDir },
      );
      if (ragResult.code === 0) {
        const parsed = JSON.parse(ragResult.stdout.trim());
        if (parsed.context && parsed.context.length > 50) {
          contextParts.push(`[KNOWLEDGE GRAPH CONTEXT]\n${parsed.context}`);
        }
      }
    } catch {}

    return contextParts;
  }

  // ── Service lifecycle ──────────────────────────────────────────────────

  startCurationTimer(getOutageDetected: () => boolean, getWorkspaceDir: () => string | null): void {
    this.curationInterval = setInterval(async () => {
      if (getOutageDetected()) {
        this.logger.info("sinain-hud: curation skipped — outage active");
        return;
      }

      const wDir = getWorkspaceDir();
      if (!wDir) {
        this.logger.info("sinain-hud: curation skipped — no workspace dir");
        return;
      }

      this.store.setWorkspaceDir(wDir);

      try {
        await this.runCurationPipeline();
      } catch (err) {
        this.logger.warn(`sinain-hud: curation pipeline error: ${String(err)}`);
      }
    }, 30 * 60 * 1000);
  }

  stopCurationTimer(): void {
    if (this.curationInterval) {
      clearInterval(this.curationInterval);
      this.curationInterval = null;
    }
  }
}
