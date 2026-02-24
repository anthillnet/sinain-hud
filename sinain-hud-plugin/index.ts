/**
 * sinain-hud OpenClaw Plugin
 *
 * Manages the sinain-hud agent lifecycle:
 * - Auto-deploys HEARTBEAT.md and SKILL.md to workspace on agent start
 * - Tracks tool usage patterns per session (fire-and-forget, sync only)
 * - Generates structured session summaries on agent end
 * - Strips <private> tags from tool results before persistence
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, chmodSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ============================================================================
// Types
// ============================================================================

type PluginConfig = {
  heartbeatPath?: string;
  skillPath?: string;
  koogPath?: string;
  sessionKey?: string;
};

type ToolUsageEntry = {
  toolName: string;
  ts: number;
  durationMs?: number;
  error?: string;
};

type SessionState = {
  startedAt: number;
  toolUsage: ToolUsageEntry[];
  workspaceDir?: string;
};

// ============================================================================
// Privacy helpers
// ============================================================================

const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>/g;

function stripPrivateTags(text: string): string {
  return text.replace(PRIVATE_TAG_RE, "").trim();
}

// ============================================================================
// File sync helpers
// ============================================================================

function syncFileToWorkspace(
  sourcePath: string | undefined,
  workspaceDir: string,
  targetName: string,
  logger: OpenClawPluginApi["logger"],
): boolean {
  if (!sourcePath) return false;

  try {
    const content = readFileSync(sourcePath, "utf-8");
    const targetPath = join(workspaceDir, targetName);
    const targetDir = dirname(targetPath);

    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    // Only write if content changed (avoid unnecessary git diffs)
    let existing = "";
    try {
      existing = readFileSync(targetPath, "utf-8");
    } catch {
      // File doesn't exist yet
    }

    if (existing !== content) {
      writeFileSync(targetPath, content, "utf-8");
      logger.info(`sinain-hud: synced ${targetName} to workspace`);
      return true;
    }
    return false;
  } catch (err) {
    logger.warn(`sinain-hud: failed to sync ${targetName}: ${String(err)}`);
    return false;
  }
}

/**
 * Sync a source directory to the workspace with selective overwrite policy:
 * - .json, .sh, .txt — always overwritten (infra/config files we control)
 * - .py — deploy-once only (skip if already exists; bot owns these after first deploy)
 */
function syncDirToWorkspace(
  sourceDir: string,
  workspaceDir: string,
  targetDirName: string,
  logger: OpenClawPluginApi["logger"],
): number {
  if (!existsSync(sourceDir)) return 0;
  const targetDir = join(workspaceDir, targetDirName);
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

  const ALWAYS_OVERWRITE = new Set([".json", ".sh", ".txt"]);
  let synced = 0;

  for (const entry of readdirSync(sourceDir)) {
    const srcPath = join(sourceDir, entry);
    if (!statSync(srcPath).isFile()) continue;

    const targetPath = join(targetDir, entry);
    const ext = extname(entry).toLowerCase();

    // Deploy-once files: skip if already present in workspace
    if (!ALWAYS_OVERWRITE.has(ext) && existsSync(targetPath)) {
      continue;
    }

    const content = readFileSync(srcPath, "utf-8");
    let existing = "";
    try { existing = readFileSync(targetPath, "utf-8"); } catch {}
    if (existing !== content) {
      writeFileSync(targetPath, content, "utf-8");
      synced++;
    }
  }
  if (synced > 0) logger.info(`sinain-hud: synced ${synced} files to ${targetDirName}/`);
  return synced;
}

// ============================================================================
// Plugin Definition
// ============================================================================

export default function sinainHudPlugin(api: OpenClawPluginApi): void {
  const cfg = (api.pluginConfig ?? {}) as PluginConfig;
  const sessionStates = new Map<string, SessionState>();

  api.logger.info("sinain-hud: plugin registered");

  // ==========================================================================
  // Hook: session_start — initialize per-session tracking
  // ==========================================================================

  api.on("session_start", async (_event, ctx) => {
    const key = ctx.sessionId;
    sessionStates.set(key, {
      startedAt: Date.now(),
      toolUsage: [],
    });
    api.logger.info?.(`sinain-hud: session started (${key})`);
  });

  // ==========================================================================
  // Hook: before_agent_start — auto-deploy HEARTBEAT.md + SKILL.md
  // ==========================================================================

  api.on("before_agent_start", async (_event, ctx) => {
    const workspaceDir = ctx.workspaceDir;
    if (!workspaceDir) return;

    // Track workspace dir in session state
    const sessionKey = ctx.sessionKey;
    if (sessionKey) {
      const state = sessionStates.get(sessionKey);
      if (state) {
        state.workspaceDir = workspaceDir;
      }
    }

    // Sync HEARTBEAT.md and SKILL.md from local source to workspace
    const heartbeatSource = cfg.heartbeatPath
      ? api.resolvePath(cfg.heartbeatPath)
      : undefined;
    const skillSource = cfg.skillPath
      ? api.resolvePath(cfg.skillPath)
      : undefined;

    syncFileToWorkspace(heartbeatSource, workspaceDir, "HEARTBEAT.md", api.logger);
    syncFileToWorkspace(skillSource, workspaceDir, "SKILL.md", api.logger);

    // Sync sinain-koog/ scripts
    const koogSource = cfg.koogPath ? api.resolvePath(cfg.koogPath) : undefined;
    if (koogSource) {
      syncDirToWorkspace(koogSource, workspaceDir, "sinain-koog", api.logger);
      // Make git_backup.sh executable
      const gbPath = join(workspaceDir, "sinain-koog", "git_backup.sh");
      if (existsSync(gbPath)) try { chmodSync(gbPath, 0o755); } catch {}
    }

    // Ensure memory directories exist
    for (const dir of ["memory", "memory/playbook-archive", "memory/playbook-logs"]) {
      const fullPath = join(workspaceDir, dir);
      if (!existsSync(fullPath)) {
        mkdirSync(fullPath, { recursive: true });
      }
    }
  });

  // ==========================================================================
  // Hook: tool_result_persist — track tool usage + strip privacy tags
  // IMPORTANT: This hook MUST be synchronous (no async/await)
  // ==========================================================================

  api.on("tool_result_persist", (event, ctx) => {
    // Track tool usage for session summary
    const sessionKey = ctx.sessionKey;
    if (sessionKey) {
      const state = sessionStates.get(sessionKey);
      if (state) {
        state.toolUsage.push({
          toolName: ctx.toolName ?? "unknown",
          ts: Date.now(),
        });
      }
    }

    // Strip <private> tags from tool result content before persistence
    const msg = event.message;
    if (msg && typeof msg === "object" && "content" in msg) {
      const content = (msg as Record<string, unknown>).content;

      if (typeof content === "string" && content.includes("<private>")) {
        return {
          message: { ...msg, content: stripPrivateTags(content) } as typeof msg,
        };
      }

      if (Array.isArray(content)) {
        let modified = false;
        const newContent = content.map((block) => {
          if (
            block &&
            typeof block === "object" &&
            "type" in block &&
            (block as Record<string, unknown>).type === "text" &&
            "text" in block
          ) {
            const text = (block as Record<string, unknown>).text;
            if (typeof text === "string" && text.includes("<private>")) {
              modified = true;
              return { ...block, text: stripPrivateTags(text) };
            }
          }
          return block;
        });

        if (modified) {
          return {
            message: { ...msg, content: newContent } as typeof msg,
          };
        }
      }
    }
  });

  // ==========================================================================
  // Hook: agent_end — generate structured session summary
  // ==========================================================================

  api.on("agent_end", async (event, ctx) => {
    const sessionKey = ctx.sessionKey;
    if (!sessionKey) return;

    const state = sessionStates.get(sessionKey);
    if (!state) return;

    const durationMs = event.durationMs ?? (Date.now() - state.startedAt);
    const toolCount = state.toolUsage.length;

    // Count tool usage by name
    const toolCounts: Record<string, number> = {};
    for (const usage of state.toolUsage) {
      toolCounts[usage.toolName] = (toolCounts[usage.toolName] ?? 0) + 1;
    }

    // Write session summary to workspace
    if (state.workspaceDir) {
      const summaryPath = join(
        state.workspaceDir,
        "memory",
        "session-summaries.jsonl",
      );

      const summary = {
        ts: new Date().toISOString(),
        sessionKey,
        agentId: ctx.agentId,
        durationMs,
        success: event.success,
        error: event.error,
        toolCallCount: toolCount,
        toolBreakdown: toolCounts,
        messageCount: event.messages?.length ?? 0,
      };

      try {
        const dir = dirname(summaryPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        // Fire-and-forget append
        writeFileSync(summaryPath, JSON.stringify(summary) + "\n", {
          flag: "a",
        });
        api.logger.info(
          `sinain-hud: session summary written (${toolCount} tools, ${Math.round(durationMs / 1000)}s)`,
        );
      } catch (err) {
        api.logger.warn(
          `sinain-hud: failed to write session summary: ${String(err)}`,
        );
      }
    }

    // Cleanup session state
    sessionStates.delete(sessionKey);
  });

  // ==========================================================================
  // Hook: session_end — cleanup any orphaned state
  // ==========================================================================

  api.on("session_end", async (_event, ctx) => {
    sessionStates.delete(ctx.sessionId);
  });

  // ==========================================================================
  // Hook: gateway_start — reset all tracking on gateway restart
  // ==========================================================================

  api.on("gateway_start", async () => {
    sessionStates.clear();
    api.logger.info("sinain-hud: gateway started, session tracking reset");
  });

  // ==========================================================================
  // Command: /sinain-status — show plugin status
  // ==========================================================================

  api.registerCommand({
    name: "sinain_status",
    description: "Show sinain-hud plugin status and active sessions",
    handler: () => {
      const sessions = Array.from(sessionStates.entries()).map(
        ([key, state]) => ({
          sessionKey: key,
          uptime: Math.round((Date.now() - state.startedAt) / 1000),
          toolCalls: state.toolUsage.length,
        }),
      );

      const text = sessions.length > 0
        ? `sinain-hud plugin active\n\nSessions:\n${sessions
            .map(
              (s) =>
                `- ${s.sessionKey}: ${s.uptime}s uptime, ${s.toolCalls} tool calls`,
            )
            .join("\n")}`
        : "sinain-hud plugin active, no active sessions";

      return { text };
    },
  });

  // ==========================================================================
  // Service registration
  // ==========================================================================

  api.registerService({
    id: "sinain-hud",
    start: () => {
      api.logger.info(
        `sinain-hud: service started (heartbeat: ${cfg.heartbeatPath ?? "not configured"})`,
      );
    },
    stop: () => {
      api.logger.info("sinain-hud: service stopped");
      sessionStates.clear();
    },
  });
}
