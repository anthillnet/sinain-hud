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
  modulesPath?: string;
  sessionKey?: string;
};

type ModuleRegistryEntry = {
  status: "active" | "suspended" | "disabled";
  priority: number;
  activatedAt: string | null;
  lastTriggered: string | null;
  locked: boolean;
};

type ModuleRegistry = {
  version: number;
  modules: Record<string, ModuleRegistryEntry>;
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

/**
 * Recursively sync a modules/ source directory to workspace with selective deploy policy:
 * - module-registry.json → deploy-once (agent manages via module_manager.py)
 * - manifest.json → always overwrite (plugin controls schema)
 * - patterns.md → deploy-once (agent/extract may have modified)
 * - context/*.json → always overwrite
 */
function syncModulesToWorkspace(
  sourceDir: string,
  workspaceDir: string,
  logger: OpenClawPluginApi["logger"],
): number {
  if (!existsSync(sourceDir)) return 0;
  const targetDir = join(workspaceDir, "modules");
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

  const ALWAYS_OVERWRITE = new Set(["manifest.json"]);
  const DEPLOY_ONCE = new Set(["module-registry.json", "patterns.md"]);
  let synced = 0;

  function syncRecursive(srcDir: string, dstDir: string): void {
    if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });

    for (const entry of readdirSync(srcDir)) {
      const srcPath = join(srcDir, entry);
      const dstPath = join(dstDir, entry);
      const stat = statSync(srcPath);

      if (stat.isDirectory()) {
        syncRecursive(srcPath, dstPath);
        continue;
      }

      if (!stat.isFile()) continue;

      const fileName = entry;
      const isAlwaysOverwrite = ALWAYS_OVERWRITE.has(fileName) || fileName.startsWith("context/");
      const isDeployOnce = DEPLOY_ONCE.has(fileName);

      // Deploy-once: skip if already in workspace
      if (isDeployOnce && existsSync(dstPath)) continue;

      // Default for unknown files: deploy-once
      if (!isAlwaysOverwrite && !isDeployOnce && existsSync(dstPath)) continue;

      const content = readFileSync(srcPath, "utf-8");
      let existing = "";
      try { existing = readFileSync(dstPath, "utf-8"); } catch {}
      if (existing !== content) {
        writeFileSync(dstPath, content, "utf-8");
        synced++;
      }
    }
  }

  syncRecursive(sourceDir, targetDir);
  if (synced > 0) logger.info(`sinain-hud: synced ${synced} module files to modules/`);
  return synced;
}

/**
 * Generate the merged effective playbook from active modules + base playbook.
 *
 * Reads module-registry.json, collects patterns.md from each active module
 * (sorted by priority desc), reads the base sinain-playbook.md, and writes
 * the merged result to memory/sinain-playbook-effective.md.
 */
function generateEffectivePlaybook(
  workspaceDir: string,
  logger: OpenClawPluginApi["logger"],
): boolean {
  const registryPath = join(workspaceDir, "modules", "module-registry.json");
  if (!existsSync(registryPath)) {
    logger.info("sinain-hud: no module-registry.json found, skipping effective playbook generation");
    return false;
  }

  let registry: ModuleRegistry;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf-8")) as ModuleRegistry;
  } catch (err) {
    logger.warn(`sinain-hud: failed to parse module-registry.json: ${String(err)}`);
    return false;
  }

  // Collect active modules sorted by priority desc
  const activeModules: Array<{ id: string; priority: number }> = [];
  for (const [id, entry] of Object.entries(registry.modules)) {
    if (entry.status === "active") {
      activeModules.push({ id, priority: entry.priority });
    }
  }
  activeModules.sort((a, b) => b.priority - a.priority);

  // Build module stack header
  const stackLabel = activeModules.map((m) => `${m.id}(${m.priority})`).join(", ");

  // Collect patterns from each active module
  const sections: string[] = [];
  sections.push(`<!-- module-stack: ${stackLabel} -->`);
  sections.push("");

  for (const mod of activeModules) {
    const patternsPath = join(workspaceDir, "modules", mod.id, "patterns.md");
    if (!existsSync(patternsPath)) continue;
    try {
      const patterns = readFileSync(patternsPath, "utf-8").trim();
      if (patterns) {
        sections.push(`<!-- module: ${mod.id} (priority ${mod.priority}) -->`);
        sections.push(patterns);
        sections.push("");
      }
    } catch {
      // Skip unreadable patterns
    }
  }

  // Append base playbook
  const basePlaybookPath = join(workspaceDir, "memory", "sinain-playbook.md");
  if (existsSync(basePlaybookPath)) {
    try {
      const base = readFileSync(basePlaybookPath, "utf-8").trim();
      if (base) {
        sections.push("<!-- base-playbook -->");
        sections.push(base);
        sections.push("");
      }
    } catch {
      // Skip if unreadable
    }
  }

  // Write effective playbook (always overwrite)
  const effectivePath = join(workspaceDir, "memory", "sinain-playbook-effective.md");
  const effectiveDir = dirname(effectivePath);
  if (!existsSync(effectiveDir)) mkdirSync(effectiveDir, { recursive: true });

  const content = sections.join("\n");
  writeFileSync(effectivePath, content, "utf-8");
  logger.info(`sinain-hud: generated effective playbook (${activeModules.length} active modules)`);
  return true;
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

    // Sync modules and generate effective playbook
    const modulesSource = cfg.modulesPath ? api.resolvePath(cfg.modulesPath) : undefined;
    if (modulesSource && existsSync(modulesSource)) {
      syncModulesToWorkspace(modulesSource, workspaceDir, api.logger);
      generateEffectivePlaybook(workspaceDir, api.logger);
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
  // Command: /sinain_modules — show active module stack
  // ==========================================================================

  api.registerCommand({
    name: "sinain_modules",
    description: "Show active knowledge module stack and suspended modules",
    handler: () => {
      // Find workspace dir from active sessions
      let workspaceDir: string | undefined;
      for (const state of sessionStates.values()) {
        if (state.workspaceDir) { workspaceDir = state.workspaceDir; break; }
      }
      if (!workspaceDir) {
        return { text: "No workspace directory available (no active session)." };
      }

      const registryPath = join(workspaceDir, "modules", "module-registry.json");
      if (!existsSync(registryPath)) {
        return { text: "Module system not initialized (no module-registry.json found)." };
      }

      let registry: ModuleRegistry;
      try {
        registry = JSON.parse(readFileSync(registryPath, "utf-8")) as ModuleRegistry;
      } catch {
        return { text: "Failed to parse module-registry.json." };
      }

      const active: Array<{ id: string; priority: number; locked: boolean }> = [];
      const suspended: string[] = [];
      const disabled: string[] = [];

      for (const [id, entry] of Object.entries(registry.modules)) {
        if (entry.status === "active") {
          active.push({ id, priority: entry.priority, locked: entry.locked });
        } else if (entry.status === "suspended") {
          suspended.push(id);
        } else if (entry.status === "disabled") {
          disabled.push(id);
        }
      }

      active.sort((a, b) => b.priority - a.priority);

      const lines: string[] = ["**Knowledge Module Stack**\n"];

      if (active.length > 0) {
        lines.push("Active (highest priority first):");
        for (const m of active) {
          const lock = m.locked ? " [locked]" : "";
          lines.push(`  ${m.priority} — ${m.id}${lock}`);
        }
      } else {
        lines.push("No active modules.");
      }

      if (suspended.length > 0) {
        lines.push(`\nSuspended: ${suspended.join(", ")}`);
      }
      if (disabled.length > 0) {
        lines.push(`\nDisabled: ${disabled.join(", ")}`);
      }

      return { text: lines.join("\n") };
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
