/**
 * sinain-hud OpenClaw Plugin
 *
 * Manages the sinain-hud agent lifecycle:
 * - Auto-deploys HEARTBEAT.md and SKILL.md to workspace on agent start
 * - Tracks tool usage patterns per session (fire-and-forget, sync only)
 * - Generates structured session summaries on agent end
 * - Strips <private> tags from tool results before persistence
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, chmodSync, copyFileSync } from "node:fs";
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
  userTimezone?: string;
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
  heartbeatToolCalled?: boolean;
};

// ============================================================================
// Privacy helpers
// ============================================================================

const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>/g;

// ============================================================================
// Retry storm resilience constants
// ============================================================================

const ERROR_WINDOW_MS = 5 * 60_000;           // 5-min sliding window for error rate
const OUTAGE_ERROR_RATE_THRESHOLD = 0.8;       // 80% failure → outage detected
const OUTAGE_MIN_SAMPLES = 3;                  // need ≥3 samples before threshold applies
const FILE_SYNC_DEBOUNCE_MS = 3 * 60_000;     // skip file sync if done <3 min ago
const PLAYBOOK_GEN_DEBOUNCE_MS = 5 * 60_000;  // skip playbook gen if done <5 min ago
const SHORT_FAILURE_THRESHOLD_MS = 10_000;     // fails in <10s = likely API error
const LONG_FAILURE_THRESHOLD_MS = 3 * 60_000;  // >3min failure = likely stuck retry loop

// Context overflow watchdog constants
const OVERFLOW_CONSECUTIVE_THRESHOLD = 5;        // N consecutive overload errors → trigger reset
const OVERFLOW_TRANSCRIPT_MIN_BYTES = 1_000_000; // 1MB guard — skip reset if transcript is small (transient outage)
const OVERFLOW_ERROR_PATTERN = /overloaded|context.*too.*long|token.*limit|extra usage is required/i;

// Proactive session hygiene constants
const SESSION_HYGIENE_SIZE_BYTES = 2_000_000;   // 2MB — proactive archive+truncate threshold
const SESSION_HYGIENE_AGE_MS = 24 * 60 * 60 * 1000; // 24h — max session age before proactive reset

// Health watchdog constants
const WATCHDOG_INTERVAL_MS = 5 * 60_000;          // 5 min — independent of curation timer
const ALERT_COOLDOWN_MS = 15 * 60_000;            // 15 min per alert type
const STALENESS_WARNING_MS = 10 * 60_000;          // 10 min no success → warning
const STALENESS_CRITICAL_MS = 15 * 60_000;         // 15 min no success after reset → emergency restart
const SESSION_SIZE_WARNING_BYTES = 1_500_000;      // 1.5MB → proactive reset
const SESSION_SIZE_RESTART_BYTES = 2_000_000;      // 2MB → forced reset
const AUTO_RESTART_COOLDOWN_MS = 60 * 60_000;     // max 1 auto-restart per hour

// ============================================================================
// Parent context injection (subagent support)
// ============================================================================

const PARENT_CONTEXT_MAX_CHARS = 4000;
const PARENT_CONTEXT_TTL_MS = 10 * 60_000; // 10 minutes — stale cache won't be injected

type ParentContextCache = {
  sessionKey: string;
  capturedAt: number;
  contextText: string;
};

function isSubagentSession(sessionKey: string): boolean {
  return sessionKey.includes(":subagent:") || sessionKey.startsWith("subagent:");
}

function extractRecentContext(
  messages: unknown[],
  prompt: string,
  maxChars: number,
): string {
  const lines: string[] = [];
  let budget = maxChars;

  // Process messages in reverse (most recent first)
  for (let i = messages.length - 1; i >= 0 && budget > 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;

    const { role, content } = msg as Record<string, unknown>;
    if (typeof role !== "string") continue;
    // Skip tool messages — verbose and low-value for context transfer
    if (role === "tool" || role === "tool_result") continue;

    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b: unknown) => b && typeof b === "object" && (b as Record<string, unknown>).type === "text")
        .map((b: unknown) => String((b as Record<string, unknown>).text ?? ""))
        .join("\n");
    }
    if (!text) continue;

    const truncated = text.slice(0, 500);
    const line = `[${role}]: ${truncated}`;
    if (line.length > budget) break;
    lines.unshift(line);
    budget -= line.length + 1; // +1 for newline
  }

  // Prepend current prompt if budget remains
  if (prompt && budget > 0) {
    const promptLine = `[system-prompt]: ${prompt.slice(0, 500)}`;
    if (promptLine.length <= budget) {
      lines.unshift(promptLine);
    }
  }

  return lines.join("\n");
}

function stripPrivateTags(text: string): string {
  return text.replace(PRIVATE_TAG_RE, "").trim();
}

// ============================================================================
// Telegram alert helpers
// ============================================================================

let _cachedBotToken: string | null | undefined; // undefined = not read yet
let _alertMissingConfigLogged = false;

function readBotToken(stateDir: string): string | null {
  if (_cachedBotToken !== undefined) return _cachedBotToken;
  try {
    const openclawJson = join(stateDir, "openclaw.json");
    const raw = JSON.parse(readFileSync(openclawJson, "utf-8"));
    const token = raw?.channels?.telegram?.botToken ?? raw?.telegram?.botToken ?? null;
    _cachedBotToken = typeof token === "string" && token.length > 10 ? token : null;
  } catch {
    _cachedBotToken = null;
  }
  return _cachedBotToken;
}

const _alertCooldowns = new Map<string, number>();

async function sendTelegramAlert(
  alertType: string,
  title: string,
  body: string,
  stateDir: string,
): Promise<void> {
  const chatId = process.env.SINAIN_ALERT_CHAT_ID;
  const token = readBotToken(stateDir);

  if (!chatId || !token) {
    if (!_alertMissingConfigLogged) {
      _alertMissingConfigLogged = true;
      // Will be picked up by whoever has access to logger — logged once
      console.log("sinain-hud: Telegram alerts disabled (missing SINAIN_ALERT_CHAT_ID or bot token)");
    }
    return;
  }

  // Per-type cooldown
  const lastSent = _alertCooldowns.get(alertType) ?? 0;
  if (Date.now() - lastSent < ALERT_COOLDOWN_MS) return;
  _alertCooldowns.set(alertType, Date.now());

  const text = `${title}\n${body}`;
  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  }).catch(() => {
    // Fire-and-forget — alert failure must never break the watchdog
  });
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
 * Recursively sync a source directory to the workspace with selective overwrite policy:
 * - .json, .sh, .txt, .jsonl — always overwritten (infra/config files we control)
 * - .py and others — deploy-once only (skip if already exists; bot owns these after first deploy)
 * Skips __pycache__ and hidden directories.
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

  const ALWAYS_OVERWRITE = new Set([".json", ".sh", ".txt", ".jsonl", ".py"]);
  let synced = 0;

  function syncRecursive(srcDir: string, dstDir: string): void {
    if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });
    for (const entry of readdirSync(srcDir)) {
      const srcPath = join(srcDir, entry);
      const dstPath = join(dstDir, entry);
      const stat = statSync(srcPath);
      if (stat.isDirectory()) {
        if (entry.startsWith("__") || entry.startsWith(".")) continue;
        syncRecursive(srcPath, dstPath);
        continue;
      }
      if (!stat.isFile()) continue;
      const ext = extname(entry).toLowerCase();
      if (!ALWAYS_OVERWRITE.has(ext) && existsSync(dstPath)) continue;
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
  let curationInterval: ReturnType<typeof setInterval> | null = null;
  let lastWorkspaceDir: string | null = null;
  let consecutiveHeartbeatSkips = 0;
  let lastEvalReportDate: string | null = null;

  // Retry storm resilience state
  const recentOutcomes: Array<{ ts: number; success: boolean; error?: string }> = [];
  let lastSuccessTs = 0;
  let lastPlaybookGenTs = 0;
  let lastFileSyncTs = 0;
  let outageDetected = false;
  let consecutiveFailures = 0;
  let outageStartTs = 0;
  let consecutiveOverflowErrors = 0;

  // Parent context cache for subagent injection
  let parentContextCache: ParentContextCache | null = null;

  // Health watchdog state
  let watchdogInterval: ReturnType<typeof setInterval> | null = null;
  let lastResetTs = 0;
  let lastAutoRestartTs = 0;

  function appendToContextCache(line: string): void {
    if (!parentContextCache) return;
    parentContextCache.contextText += "\n" + line;
    parentContextCache.capturedAt = Date.now();
    // Trim from front if over budget (keep most recent context)
    if (parentContextCache.contextText.length > PARENT_CONTEXT_MAX_CHARS) {
      const excess = parentContextCache.contextText.length - PARENT_CONTEXT_MAX_CHARS;
      const newStart = parentContextCache.contextText.indexOf("\n", excess);
      parentContextCache.contextText = newStart >= 0
        ? parentContextCache.contextText.slice(newStart + 1)
        : parentContextCache.contextText.slice(excess);
    }
  }

  function computeErrorRate(): { rate: number; total: number; failures: number } {
    const cutoff = Date.now() - ERROR_WINDOW_MS;
    // Prune entries older than the window
    while (recentOutcomes.length > 0 && recentOutcomes[0].ts < cutoff) {
      recentOutcomes.shift();
    }
    const total = recentOutcomes.length;
    if (total === 0) return { rate: 0, total: 0, failures: 0 };
    const failures = recentOutcomes.filter((o) => !o.success).length;
    return { rate: failures / total, total, failures };
  }

  function getSessionsJsonPath(): string | null {
    if (!lastWorkspaceDir) return null;
    const sessionsDir = join(dirname(lastWorkspaceDir), "agents", "main", "sessions");
    const p = join(sessionsDir, "sessions.json");
    return existsSync(p) ? p : null;
  }

  function performOverflowReset(): boolean {
    const targetSessionKey = cfg.sessionKey;
    if (!targetSessionKey || !lastWorkspaceDir) {
      api.logger.warn("sinain-hud: overflow reset aborted — no sessionKey or workspace dir");
      return false;
    }

    const sessionsJsonPath = getSessionsJsonPath();

    if (!sessionsJsonPath) {
      api.logger.warn(`sinain-hud: overflow reset aborted — sessions.json not found`);
      return false;
    }

    let sessionsData: Record<string, Record<string, unknown>>;
    try {
      sessionsData = JSON.parse(readFileSync(sessionsJsonPath, "utf-8"));
    } catch (err) {
      api.logger.warn(`sinain-hud: overflow reset aborted — cannot parse sessions.json: ${err}`);
      return false;
    }

    const session = sessionsData[targetSessionKey];
    const transcriptPath = session?.sessionFile as string | undefined;
    if (!transcriptPath || !existsSync(transcriptPath)) {
      api.logger.warn(`sinain-hud: overflow reset aborted — transcript not found: ${transcriptPath}`);
      return false;
    }

    // Guard: only reset if transcript is actually large
    const size = statSync(transcriptPath).size;
    if (size < OVERFLOW_TRANSCRIPT_MIN_BYTES) {
      api.logger.info(
        `sinain-hud: overflow reset skipped — transcript only ${Math.round(size / 1024)}KB (threshold: ${Math.round(OVERFLOW_TRANSCRIPT_MIN_BYTES / 1024)}KB)`,
      );
      return false;
    }

    // Archive → truncate → reset metadata
    const archivePath = transcriptPath.replace(/\.jsonl$/, `.archived.${Date.now()}.jsonl`);
    try {
      copyFileSync(transcriptPath, archivePath);
    } catch (err) {
      api.logger.warn(`sinain-hud: overflow reset aborted — archive failed: ${err}`);
      return false;
    }

    writeFileSync(transcriptPath, "", "utf-8");

    try {
      session.contextTokens = 0;
      writeFileSync(sessionsJsonPath, JSON.stringify(sessionsData, null, 2), "utf-8");
    } catch {
      // Non-fatal — gateway recomputes tokens from transcript content
    }

    api.logger.info(
      `sinain-hud: === OVERFLOW RESET === Transcript truncated (was ${Math.round(size / 1024)}KB). Archive: ${archivePath}`,
    );
    return true;
  }

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

  api.on("before_agent_start", async (event, ctx) => {
    const workspaceDir = ctx.workspaceDir;
    if (!workspaceDir) return;

    // Track workspace dir in session state and for curation timer
    lastWorkspaceDir = workspaceDir;
    const sessionKey = ctx.sessionKey;
    if (sessionKey) {
      const state = sessionStates.get(sessionKey);
      if (state) {
        state.workspaceDir = workspaceDir;
      }
    }

    const now = Date.now();

    // ── Debounced file sync (skip if done <3 min ago) ───────────────────
    const fileSyncDue = lastFileSyncTs === 0 || (now - lastFileSyncTs) >= FILE_SYNC_DEBOUNCE_MS;
    if (fileSyncDue) {
      const heartbeatSource = cfg.heartbeatPath
        ? api.resolvePath(cfg.heartbeatPath)
        : undefined;
      const skillSource = cfg.skillPath
        ? api.resolvePath(cfg.skillPath)
        : undefined;

      syncFileToWorkspace(heartbeatSource, workspaceDir, "HEARTBEAT.md", api.logger);
      syncFileToWorkspace(skillSource, workspaceDir, "SKILL.md", api.logger);

      const koogSource = cfg.koogPath ? api.resolvePath(cfg.koogPath) : undefined;
      if (koogSource) {
        syncDirToWorkspace(koogSource, workspaceDir, "sinain-koog", api.logger);
        const gbPath = join(workspaceDir, "sinain-koog", "git_backup.sh");
        if (existsSync(gbPath)) try { chmodSync(gbPath, 0o755); } catch {}
      }

      const modulesSource = cfg.modulesPath ? api.resolvePath(cfg.modulesPath) : undefined;
      if (modulesSource && existsSync(modulesSource)) {
        syncModulesToWorkspace(modulesSource, workspaceDir, api.logger);
      }

      lastFileSyncTs = now;
    }

    // ── Debounced playbook generation (skip if done <5 min ago) ─────────
    const playbookGenDue = lastPlaybookGenTs === 0 || (now - lastPlaybookGenTs) >= PLAYBOOK_GEN_DEBOUNCE_MS;
    if (playbookGenDue) {
      const modulesSource = cfg.modulesPath ? api.resolvePath(cfg.modulesPath) : undefined;
      if (modulesSource && existsSync(modulesSource)) {
        generateEffectivePlaybook(workspaceDir, api.logger);
        lastPlaybookGenTs = now;
      }
    }

    // ── Memory dirs — always run (cheap, idempotent) ────────────────────
    for (const dir of ["memory", "memory/playbook-archive", "memory/playbook-logs",
                        "memory/eval-logs", "memory/eval-reports"]) {
      const fullPath = join(workspaceDir, dir);
      if (!existsSync(fullPath)) {
        mkdirSync(fullPath, { recursive: true });
      }
      // Ensure directory is writable even if created by another process (e.g. root)
      try { chmodSync(fullPath, 0o755); } catch {}
    }

    // ── Context capture + subagent injection ────────────────────────────
    const isSubagent = sessionKey ? isSubagentSession(sessionKey) : false;

    if (!isSubagent) {
      // Main session: capture recent conversation context for future subagents
      const messages = (event as Record<string, unknown>).messages as unknown[] | undefined;
      const prompt = (event as Record<string, unknown>).prompt as string | undefined;
      if (messages && Array.isArray(messages) && messages.length > 0) {
        const contextText = extractRecentContext(messages, prompt ?? "", PARENT_CONTEXT_MAX_CHARS);
        if (contextText) {
          parentContextCache = {
            sessionKey: sessionKey ?? "unknown",
            capturedAt: now,
            contextText,
          };
          api.logger.info(
            `sinain-hud: captured parent context (${contextText.length} chars, ${messages.length} messages)`,
          );
        }
      }
    }

    // ── Accumulate context parts (time + outage recovery + subagent injection)
    const contextParts: string[] = [];

    // Time awareness — always inject current local time
    const userTz = cfg.userTimezone ?? "Europe/Berlin";
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
    if (outageStartTs > 0 && !outageDetected && lastSuccessTs > outageStartTs) {
      const outageDurationMin = Math.round((lastSuccessTs - outageStartTs) / 60_000);
      outageStartTs = 0; // one-shot: only inject once
      api.logger.info(`sinain-hud: injecting recovery context (outage lasted ~${outageDurationMin}min)`);
      contextParts.push(
        `[SYSTEM] The upstream API was unavailable for ~${outageDurationMin} minutes. ` +
        `Multiple queued messages may have accumulated. Prioritize the current task, skip catch-up on stale items, and keep responses concise.`,
      );
    }

    // Subagent: inject cached parent context
    if (isSubagent && parentContextCache) {
      const cacheAgeMs = now - parentContextCache.capturedAt;
      if (cacheAgeMs < PARENT_CONTEXT_TTL_MS) {
        const cacheAgeSec = Math.round(cacheAgeMs / 1000);
        api.logger.info(
          `sinain-hud: injected parent context for subagent (${parentContextCache.contextText.length} chars, ${cacheAgeSec}s old)`,
        );
        contextParts.push(
          `[PARENT SESSION CONTEXT] The following is a summary of the recent conversation from the parent session that spawned you. Use it to understand references to code, files, or decisions discussed earlier:\n\n${parentContextCache.contextText}`,
        );
      } else {
        api.logger.info(
          `sinain-hud: skipped stale parent context for subagent (${Math.round(cacheAgeMs / 1000)}s old, TTL=${PARENT_CONTEXT_TTL_MS / 1000}s)`,
        );
      }
    }

    // Heartbeat enforcement (replaces fork's system-prompt.ts logic)
    if (cfg.heartbeatPath) {
      const hbTarget = join(workspaceDir, "HEARTBEAT.md");
      if (existsSync(hbTarget)) {
        contextParts.push(
          "[HEARTBEAT PROTOCOL] HEARTBEAT.md is loaded in your project context. " +
          "On every heartbeat poll, you MUST execute the full protocol defined in " +
          "HEARTBEAT.md — all phases, all steps, in order. " +
          "Only reply HEARTBEAT_OK if HEARTBEAT.md explicitly permits it " +
          "after you have completed all mandatory steps."
        );
      }
    }

    // SITUATION.md bootstrap (replaces fork's workspace.ts logic)
    const situationPath = join(workspaceDir, "SITUATION.md");
    if (existsSync(situationPath)) {
      try {
        const content = readFileSync(situationPath, "utf-8").trim();
        if (content) contextParts.push(`[SITUATION]\n${content}`);
      } catch {}
    }

    if (contextParts.length > 0) {
      return { prependContext: contextParts.join("\n\n") };
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

        // Track heartbeat tool calls for compliance validation
        if (ctx.toolName === "sinain_heartbeat_tick") {
          state.heartbeatToolCalled = true;
        }
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
    const isSuccess = event.success === true;
    const isShortFailure = !isSuccess && durationMs < SHORT_FAILURE_THRESHOLD_MS;

    // ── Retry storm: track outcome ──────────────────────────────────────
    recentOutcomes.push({
      ts: Date.now(),
      success: isSuccess,
      error: isSuccess ? undefined : String(event.error ?? "unknown"),
    });

    if (isSuccess) {
      const wasOutage = outageDetected;
      const outageDurationMs = outageStartTs > 0 ? Date.now() - outageStartTs : 0;
      consecutiveFailures = 0;
      outageDetected = false;
      lastSuccessTs = Date.now();
      if (wasOutage) {
        api.logger.info(
          `sinain-hud: OUTAGE RECOVERED — resumed after ${Math.round(outageDurationMs / 1000)}s`,
        );
        // outageStartTs is NOT reset here — before_agent_start uses it to
        // inject recovery context on the next run, then resets it itself.

        // Send recovery alert via Telegram
        const sd = getStateDir();
        if (sd) {
          sendTelegramAlert("recovery", "✅ *sinain-hud* recovered",
            `• Gateway up, first run succeeded\n• Downtime: ~${Math.round(outageDurationMs / 60_000)}min`,
            sd);
        }
      }
    } else if (isShortFailure) {
      consecutiveFailures++;
      const { rate, total } = computeErrorRate();
      if (!outageDetected && total >= OUTAGE_MIN_SAMPLES && rate >= OUTAGE_ERROR_RATE_THRESHOLD) {
        outageDetected = true;
        outageStartTs = Date.now();
        api.logger.warn(
          `sinain-hud: OUTAGE DETECTED — ${Math.round(rate * 100)}% error rate over ${total} samples, ${consecutiveFailures} consecutive failures`,
        );
        const sd = getStateDir();
        if (sd) {
          sendTelegramAlert("outage", "🔴 *sinain-hud* OUTAGE DETECTED",
            `• ${Math.round(rate * 100)}% error rate over ${total} samples\n• ${consecutiveFailures} consecutive failures`,
            sd);
        }
      }
    }

    // ── Context overflow watchdog ──────────────────────────────────────
    if (sessionKey === cfg.sessionKey) {
      if (!isSuccess && OVERFLOW_ERROR_PATTERN.test(String(event.error ?? ""))) {
        consecutiveOverflowErrors++;
        api.logger.warn(
          `sinain-hud: overflow watchdog — error #${consecutiveOverflowErrors}/${OVERFLOW_CONSECUTIVE_THRESHOLD}`,
        );
        if (consecutiveOverflowErrors >= OVERFLOW_CONSECUTIVE_THRESHOLD) {
          api.logger.warn("sinain-hud: OVERFLOW THRESHOLD REACHED — attempting transcript reset");
          if (performOverflowReset()) {
            lastResetTs = Date.now();
            consecutiveOverflowErrors = 0;
            outageDetected = false;
            consecutiveFailures = 0;
            outageStartTs = 0;
            const sd = getStateDir();
            if (sd) {
              sendTelegramAlert("overflow_reset", "⚠️ *sinain-hud* overflow reset triggered",
                `• ${OVERFLOW_CONSECUTIVE_THRESHOLD} consecutive overflow errors\n• Transcript truncated`,
                sd);
            }
          }
        }
      } else if (isSuccess) {
        consecutiveOverflowErrors = 0;
      }

      // Duration-gated overflow reset: long failure + overflow error pattern = stuck retry loop.
      // The core misclassifies "extra usage is required" as rate_limit → infinite retry.
      // After the run times out (>3min), we detect it and reset for the next cycle.
      const isLongFailure = !isSuccess && durationMs > LONG_FAILURE_THRESHOLD_MS;
      if (isLongFailure && OVERFLOW_ERROR_PATTERN.test(String(event.error ?? ""))) {
        api.logger.warn(
          `sinain-hud: long failure (${Math.round(durationMs / 1000)}s) with overflow error — immediate reset`,
        );
        if (performOverflowReset()) {
          lastResetTs = Date.now();
          consecutiveOverflowErrors = 0;
          outageDetected = false;
          consecutiveFailures = 0;
          outageStartTs = 0;
          const sd = getStateDir();
          if (sd) {
            sendTelegramAlert("overflow_reset", "⚠️ *sinain-hud* overflow reset (stuck retry)",
              `• ${Math.round(durationMs / 1000)}s failed run with overflow error\n• Transcript truncated, next heartbeat should recover`,
              sd);
          }
        }
      }
    }

    // ── Count tool usage by name ────────────────────────────────────────
    const toolCounts: Record<string, number> = {};
    for (const usage of state.toolUsage) {
      toolCounts[usage.toolName] = (toolCounts[usage.toolName] ?? 0) + 1;
    }

    // ── Write session summary (skip during outage — noise reduction) ───
    const skipSummary = outageDetected && isShortFailure;
    if (state.workspaceDir && !skipSummary) {
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

    // ── Heartbeat compliance (exempt during outage) ─────────────────────
    if ((ctx as Record<string, unknown>).messageProvider === "heartbeat") {
      if (outageDetected && isShortFailure) {
        // Agent couldn't even process the prompt — don't count as a skip
        api.logger.info(
          `sinain-hud: heartbeat compliance exempted (outage active, ${Math.round(durationMs / 1000)}s run)`,
        );
      } else if (!state.heartbeatToolCalled) {
        consecutiveHeartbeatSkips++;
        api.logger.warn(
          `sinain-hud: heartbeat compliance violation — tool not called (consecutive: ${consecutiveHeartbeatSkips})`,
        );
        if (consecutiveHeartbeatSkips >= 3) {
          api.logger.warn(
            `sinain-hud: ESCALATION — ${consecutiveHeartbeatSkips} consecutive heartbeat skips`,
          );
        }
      } else {
        consecutiveHeartbeatSkips = 0;
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
  // Hook: llm_output — continuously refresh parent context cache
  // ==========================================================================

  api.on("llm_output", async (event, ctx) => {
    const sessionKey = ctx.sessionKey;
    if (!sessionKey || isSubagentSession(sessionKey)) return;
    if (!parentContextCache) return;

    const latest = ((event as Record<string, unknown>).assistantTexts as string[] | undefined)?.at(-1);
    if (!latest) return;
    appendToContextCache(`[assistant]: ${latest.slice(0, 500)}`);
  });

  // ==========================================================================
  // Hook: llm_input — capture user turns mid-session
  // ==========================================================================

  api.on("llm_input", async (event, ctx) => {
    const sessionKey = ctx.sessionKey;
    if (!sessionKey || isSubagentSession(sessionKey)) return;
    if (!parentContextCache) return;

    const prompt = (event as Record<string, unknown>).prompt as string | undefined;
    if (!prompt) return;
    appendToContextCache(`[user]: ${prompt.slice(0, 500)}`);
  });

  // ==========================================================================
  // Hook: subagent_spawning — diagnostic logging
  // ==========================================================================

  api.on("subagent_spawning", async (event, ctx) => {
    const cacheAge = parentContextCache
      ? `${Math.round((Date.now() - parentContextCache.capturedAt) / 1000)}s`
      : "none";
    const childKey = (event as Record<string, unknown>).childSessionKey ?? "?";
    const parentKey = (ctx as Record<string, unknown>).requesterSessionKey ?? "?";
    api.logger.info(
      `sinain-hud: subagent spawning (child=${childKey}, parent=${parentKey}, contextCache=${cacheAge})`,
    );
  });

  // ==========================================================================
  // Hook: gateway_start — reset all tracking on gateway restart
  // ==========================================================================

  api.on("gateway_start", async () => {
    sessionStates.clear();
    // Reset all resilience state — clean slate on restart
    recentOutcomes.length = 0;
    lastSuccessTs = 0;
    lastPlaybookGenTs = 0;
    lastFileSyncTs = 0;
    outageDetected = false;
    consecutiveFailures = 0;
    outageStartTs = 0;
    consecutiveHeartbeatSkips = 0;
    consecutiveOverflowErrors = 0;
    parentContextCache = null;
    // Reset watchdog alert state
    lastResetTs = 0;
    _alertCooldowns.clear();
    _cachedBotToken = undefined; // re-read on next alert
    _alertMissingConfigLogged = false;
    api.logger.info("sinain-hud: gateway started, session + resilience + watchdog tracking reset");
  });

  // ==========================================================================
  // Command: /sinain-status — show plugin status
  // ==========================================================================

  api.registerCommand({
    name: "sinain_status",
    description: "Show sinain-hud plugin status and active sessions",
    handler: () => {
      const lines: string[] = ["sinain-hud plugin active"];

      // Persistent session info from disk
      const sessionsJsonPath = getSessionsJsonPath();
      if (sessionsJsonPath) {
        try {
          const sessionsData = JSON.parse(readFileSync(sessionsJsonPath, "utf-8"));
          const keysToShow = [cfg.sessionKey, "agent:main:main"].filter(Boolean);
          lines.push("\nSessions:");
          for (const key of keysToShow) {
            const s = sessionsData[key as string];
            if (!s) continue;
            const updatedAgo = s.updatedAt ? `${Math.round((Date.now() - s.updatedAt) / 1000)}s ago` : "?";
            const tokens = s.contextTokens ?? "?";
            const compactions = s.compactionCount ?? 0;
            let transcriptSize = "?";
            if (s.sessionFile && existsSync(s.sessionFile)) {
              transcriptSize = `${Math.round(statSync(s.sessionFile).size / 1024)}KB`;
            }
            lines.push(`- ${key}: updated ${updatedAgo}, ${tokens} tokens, ${compactions} compactions, transcript ${transcriptSize}`);
          }
        } catch {
          lines.push("No session data available.");
        }
      } else {
        lines.push("No session data available (workspace not set).");
      }

      // Resilience info
      const { rate, total, failures } = computeErrorRate();
      lines.push("\n**Resilience**");
      lines.push(`- Outage: ${outageDetected ? `ACTIVE (${Math.round((Date.now() - outageStartTs) / 1000)}s, ${consecutiveFailures} consecutive failures)` : "clear"}`);
      lines.push(`- Error rate: ${Math.round(rate * 100)}% (${failures}/${total} in ${ERROR_WINDOW_MS / 60_000}min window)`);
      lines.push(`- Last success: ${lastSuccessTs > 0 ? `${Math.round((Date.now() - lastSuccessTs) / 1000)}s ago` : "never"}`);
      lines.push(`- Heartbeat skips: ${consecutiveHeartbeatSkips}`);
      lines.push(`- Overflow watchdog: ${consecutiveOverflowErrors}/${OVERFLOW_CONSECUTIVE_THRESHOLD}`);
      lines.push(`- Parent context cache: ${parentContextCache ? `${parentContextCache.contextText.length} chars, ${Math.round((Date.now() - parentContextCache.capturedAt) / 1000)}s old` : "empty"}`);

      return { text: lines.join("\n") };
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
  // Command: /sinain_eval — show latest evaluation report + metrics
  // ==========================================================================

  api.registerCommand({
    name: "sinain_eval",
    description: "Show latest evaluation report and current eval metrics",
    handler: () => {
      let workspaceDir: string | undefined;
      for (const state of sessionStates.values()) {
        if (state.workspaceDir) { workspaceDir = state.workspaceDir; break; }
      }
      if (!workspaceDir) {
        return { text: "No workspace directory available (no active session)." };
      }

      const reportsDir = join(workspaceDir, "memory", "eval-reports");
      const logsDir = join(workspaceDir, "memory", "eval-logs");
      const lines: string[] = ["**Evaluation Report**\n"];

      // Find latest report
      let latestReport = "";
      if (existsSync(reportsDir)) {
        const reports = readdirSync(reportsDir)
          .filter((f: string) => f.endsWith(".md"))
          .sort()
          .reverse();
        if (reports.length > 0) {
          try {
            latestReport = readFileSync(join(reportsDir, reports[0]), "utf-8");
            lines.push(latestReport.trim());
          } catch {
            lines.push("Failed to read latest report.");
          }
        }
      }

      if (!latestReport) {
        lines.push("No eval reports generated yet.\n");
      }

      // Show latest eval-log entries
      if (existsSync(logsDir)) {
        const logFiles = readdirSync(logsDir)
          .filter((f: string) => f.endsWith(".jsonl"))
          .sort()
          .reverse();
        if (logFiles.length > 0) {
          try {
            const content = readFileSync(join(logsDir, logFiles[0]), "utf-8");
            const entries = content.trim().split("\n").slice(-5);
            lines.push("\n**Recent Tick Evaluations** (last 5):");
            for (const line of entries) {
              try {
                const e = JSON.parse(line) as Record<string, unknown>;
                const judges = e.judges ? ` judgeAvg=${e.judgeAvg ?? "?"}` : "";
                lines.push(`  ${e.tickTs} — passRate=${e.passRate}${judges}`);
              } catch {
                // skip malformed line
              }
            }
          } catch {
            // skip if unreadable
          }
        }
      }

      return { text: lines.join("\n") };
    },
  });

  // ==========================================================================
  // Command: /sinain_eval_level — change evaluation level at runtime
  // ==========================================================================

  api.registerCommand({
    name: "sinain_eval_level",
    description: "Set evaluation level: mechanical, sampled, or full",
    handler: (args) => {
      let workspaceDir: string | undefined;
      for (const state of sessionStates.values()) {
        if (state.workspaceDir) { workspaceDir = state.workspaceDir; break; }
      }
      if (!workspaceDir) {
        return { text: "No workspace directory available (no active session)." };
      }

      const level = (args.text ?? "").trim().toLowerCase();
      const validLevels = ["mechanical", "sampled", "full"];
      if (!validLevels.includes(level)) {
        return { text: `Invalid level '${level}'. Valid options: ${validLevels.join(", ")}` };
      }

      const configPath = join(workspaceDir, "memory", "eval-config.json");
      const configDir = join(workspaceDir, "memory");
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
      }

      const config = {
        level,
        changedAt: new Date().toISOString(),
      };
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

      return { text: `Eval level set to '${level}'. Next tick evaluation will use this level.` };
    },
  });

  // ==========================================================================
  // Command: /sinain_health — on-demand health check
  // ==========================================================================

  api.registerCommand({
    name: "sinain_health",
    description: "Run health watchdog checks on-demand and show results",
    handler: () => {
      const checks = runHealthChecks();
      const lines: string[] = ["**Health Watchdog Report**\n"];

      lines.push(`Transcript: ${checks.transcriptMB !== null ? `${checks.transcriptMB}MB` : "unknown"}`);
      lines.push(`Last success: ${checks.staleSec > 0 ? `${checks.staleSec}s ago` : lastSuccessTs > 0 ? "just now" : "never"}`);
      lines.push(`Error rate: ${Math.round(checks.errorRate * 100)}% (${checks.errorTotal} samples)`);
      lines.push(`Overflow counter: ${checks.overflowCount}/${OVERFLOW_CONSECUTIVE_THRESHOLD}`);
      lines.push(`Last reset: ${lastResetTs > 0 ? `${Math.round((Date.now() - lastResetTs) / 1000)}s ago` : "never"}`);
      lines.push(`Last auto-restart: ${lastAutoRestartTs > 0 ? `${Math.round((Date.now() - lastAutoRestartTs) / 1000)}s ago` : "never"}`);
      lines.push(`Alerts configured: ${process.env.SINAIN_ALERT_CHAT_ID ? "yes" : "no (SINAIN_ALERT_CHAT_ID not set)"}`);

      if (checks.issues.length > 0) {
        lines.push(`\n**Issues detected:**`);
        for (const issue of checks.issues) {
          lines.push(`  ⚠️ ${issue}`);
        }
      } else {
        lines.push(`\n✅ All checks passed`);
      }

      return { text: lines.join("\n") };
    },
  });

  // ==========================================================================
  // Tool: sinain_heartbeat_tick — deterministic heartbeat execution
  // ==========================================================================

  api.registerTool(
    (ctx) => {
      const workspaceDir = ctx.workspaceDir;
      if (!workspaceDir) return null;

      return {
        name: "sinain_heartbeat_tick",
        label: "Heartbeat Tick",
        description:
          "Execute all heartbeat mechanical work: git backup, signal analysis, insight synthesis, and log writing. " +
          "Returns structured JSON with script results, recommended actions, and output for Telegram.",
        parameters: {
          type: "object",
          properties: {
            sessionSummary: {
              type: "string",
              description: "2-3 sentence summary of current session state",
            },
            idle: {
              type: "boolean",
              description: "True if user has been inactive >30 minutes",
            },
          },
          required: ["sessionSummary", "idle"],
        },
        async execute(
          _toolCallId: string,
          params: { sessionSummary: string; idle: boolean },
        ) {
          const result: Record<string, unknown> = {
            status: "ok",
            gitBackup: null,
            signals: [],
            recommendedAction: { action: "skip", task: null, confidence: 0 },
            output: null,
            skipped: false,
            skipReason: null,
            logWritten: false,
          };

          // Helper: run a python script and parse JSON stdout
          const runScript = async (
            args: string[],
            timeoutMs = 60_000,
          ): Promise<Record<string, unknown> | null> => {
            try {
              const out = await api.runtime.system.runCommandWithTimeout(
                ["uv", "run", "--with", "requests", "python3", ...args],
                { timeoutMs, cwd: workspaceDir },
              );
              if (out.code !== 0) {
                api.logger.warn(
                  `sinain-hud: heartbeat script failed: ${args[0]} (code ${out.code})\n${out.stderr}`,
                );
                return null;
              }
              return JSON.parse(out.stdout.trim());
            } catch (err) {
              api.logger.warn(
                `sinain-hud: heartbeat script error: ${args[0]}: ${String(err)}`,
              );
              return null;
            }
          };

          // 1. Git backup (30s timeout)
          try {
            const gitOut = await api.runtime.system.runCommandWithTimeout(
              ["bash", "sinain-koog/git_backup.sh"],
              { timeoutMs: 30_000, cwd: workspaceDir },
            );
            result.gitBackup = gitOut.stdout.trim() || "nothing to commit";
          } catch (err) {
            api.logger.warn(`sinain-hud: git backup error: ${String(err)}`);
            result.gitBackup = `error: ${String(err)}`;
          }

          // Current time string for koog scripts
          const hbTz = cfg.userTimezone ?? "Europe/Berlin";
          const currentTimeStr = new Date().toLocaleString("en-GB", {
            timeZone: hbTz, weekday: "long", year: "numeric", month: "long",
            day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
          }) + ` (${hbTz})`;

          // 2. Signal analysis (60s timeout)
          const signalArgs = [
            "sinain-koog/signal_analyzer.py",
            "--memory-dir", "memory/",
            "--session-summary", params.sessionSummary,
            "--current-time", currentTimeStr,
          ];
          if (params.idle) signalArgs.push("--idle");

          const signalResult = await runScript(signalArgs, 60_000);
          if (signalResult) {
            result.signals = signalResult.signals ?? [];
            result.recommendedAction = signalResult.recommendedAction ?? {
              action: "skip",
              task: null,
              confidence: 0,
            };
          }

          // 3. Insight synthesis (60s timeout)
          const synthArgs = [
            "sinain-koog/insight_synthesizer.py",
            "--memory-dir", "memory/",
            "--session-summary", params.sessionSummary,
            "--current-time", currentTimeStr,
          ];
          if (params.idle) synthArgs.push("--idle");

          const synthResult = await runScript(synthArgs, 60_000);
          if (synthResult) {
            if (synthResult.skip === false) {
              result.output = {
                suggestion: synthResult.suggestion ?? null,
                insight: synthResult.insight ?? null,
              };
            } else {
              result.skipped = true;
              result.skipReason = synthResult.skipReason ?? "synthesizer skipped";
            }
          }

          // 4. Write log entry to memory/playbook-logs/YYYY-MM-DD.jsonl
          try {
            const now = new Date();
            const dateStr = now.toISOString().slice(0, 10);
            const logDir = join(workspaceDir, "memory", "playbook-logs");
            if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

            const logEntry = {
              ts: now.toISOString(),
              idle: params.idle,
              sessionHistorySummary: params.sessionSummary,
              signals: result.signals,
              recommendedAction: result.recommendedAction,
              output: result.output,
              skipped: result.skipped,
              skipReason: result.skipReason,
              gitBackup: result.gitBackup,
            };

            writeFileSync(
              join(logDir, `${dateStr}.jsonl`),
              JSON.stringify(logEntry) + "\n",
              { flag: "a" },
            );
            result.logWritten = true;
          } catch (err) {
            api.logger.warn(
              `sinain-hud: failed to write heartbeat log: ${String(err)}`,
            );
          }

          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result, null, 2) },
            ],
            details: result,
          };
        },
      } as any; // AnyAgentTool — plain JSON schema, no TypeBox dependency
    },
    { name: "sinain_heartbeat_tick" },
  );

  // ==========================================================================
  // Effectiveness footer update
  // ==========================================================================

  function updateEffectivenessFooter(
    workspaceDir: string,
    effectiveness: Record<string, unknown>,
  ): void {
    const playbookPath = join(workspaceDir, "memory", "sinain-playbook.md");
    if (!existsSync(playbookPath)) return;
    let content = readFileSync(playbookPath, "utf-8");
    const today = new Date().toISOString().slice(0, 10);
    const newFooter = `<!-- effectiveness: outputs=${effectiveness.outputs ?? 0}, positive=${effectiveness.positive ?? 0}, negative=${effectiveness.negative ?? 0}, neutral=${effectiveness.neutral ?? 0}, rate=${effectiveness.rate ?? 0}, updated=${today} -->`;
    const footerRe = /<!--\s*effectiveness:[^>]+-->/;
    if (footerRe.test(content)) {
      content = content.replace(footerRe, newFooter);
    } else {
      content = content.trimEnd() + "\n\n" + newFooter + "\n";
    }
    writeFileSync(playbookPath, content, "utf-8");
  }

  // ==========================================================================
  // Curation pipeline (runs on 30-min timer)
  // ==========================================================================

  async function runCurationPipeline(workspaceDir: string): Promise<void> {
    const runScript = async (
      args: string[],
      timeoutMs = 90_000,
    ): Promise<Record<string, unknown> | null> => {
      try {
        const result = await api.runtime.system.runCommandWithTimeout(
          ["uv", "run", "--with", "requests", "python3", ...args],
          { timeoutMs, cwd: workspaceDir },
        );
        if (result.code !== 0) {
          api.logger.warn(
            `sinain-hud: curation script failed: ${args[0]} (code ${result.code})\n${result.stderr}`,
          );
          return null;
        }
        return JSON.parse(result.stdout.trim());
      } catch (err) {
        api.logger.warn(
          `sinain-hud: curation script error: ${args[0]}: ${String(err)}`,
        );
        return null;
      }
    };

    api.logger.info("sinain-hud: curation pipeline starting");

    // Step 1: Feedback analysis
    const feedback = await runScript([
      "sinain-koog/feedback_analyzer.py",
      "--memory-dir", "memory/",
      "--session-summary", "periodic curation (plugin timer)",
    ]);
    const directive = (feedback as Record<string, unknown> | null)?.curateDirective as string ?? "stability";

    // Step 2: Memory mining (background task — mines unread daily files)
    const mining = await runScript([
      "sinain-koog/memory_miner.py",
      "--memory-dir", "memory/",
    ]);
    const findings = mining?.findings ? JSON.stringify(mining.findings) : null;

    // Step 3: Playbook curation
    const curatorArgs = [
      "sinain-koog/playbook_curator.py",
      "--memory-dir", "memory/",
      "--session-summary", "periodic curation (plugin timer)",
      "--curate-directive", directive,
    ];
    if (findings) {
      curatorArgs.push("--mining-findings", findings);
    }
    const curator = await runScript(curatorArgs);

    // Step 4: Update effectiveness footer with fresh metrics
    const effectiveness = (feedback as Record<string, unknown> | null)?.effectiveness;
    if (effectiveness && typeof effectiveness === "object") {
      try {
        updateEffectivenessFooter(workspaceDir, effectiveness as Record<string, unknown>);
      } catch (err) {
        api.logger.warn(`sinain-hud: effectiveness footer update failed: ${String(err)}`);
      }
    }

    // Step 5: Regenerate effective playbook after curation
    generateEffectivePlaybook(workspaceDir, api.logger);

    // Step 6: Tick evaluation (runs mechanical + sampled judges)
    await runScript([
      "sinain-koog/tick_evaluator.py",
      "--memory-dir", "memory/",
    ], 120_000);

    // Step 7: Daily eval report (run once per day after 03:00 UTC)
    const nowUTC = new Date();
    const todayStr = nowUTC.toISOString().slice(0, 10);
    if (nowUTC.getUTCHours() >= 3 && lastEvalReportDate !== todayStr) {
      await runScript([
        "sinain-koog/eval_reporter.py",
        "--memory-dir", "memory/",
      ], 120_000);
      lastEvalReportDate = todayStr;
    }

    // Log result
    const changes = (curator as Record<string, unknown> | null)?.changes ?? "unknown";
    api.logger.info(
      `sinain-hud: curation pipeline complete (directive=${directive}, changes=${JSON.stringify(changes)})`,
    );
  }

  // ==========================================================================
  // Health watchdog helpers
  // ==========================================================================

  function getStateDir(): string | null {
    // State dir is the parent of the workspace dir (e.g. /home/node/.openclaw)
    if (!lastWorkspaceDir) return null;
    return dirname(lastWorkspaceDir);
  }

  function getTranscriptSize(): { path: string; bytes: number } | null {
    const sessionsJsonPath = getSessionsJsonPath();
    if (!sessionsJsonPath || !cfg.sessionKey) return null;
    try {
      const sessionsData = JSON.parse(readFileSync(sessionsJsonPath, "utf-8"));
      const session = sessionsData[cfg.sessionKey];
      const transcriptPath = session?.sessionFile as string | undefined;
      if (!transcriptPath || !existsSync(transcriptPath)) return null;
      return { path: transcriptPath, bytes: statSync(transcriptPath).size };
    } catch {
      return null;
    }
  }

  function runHealthChecks(): {
    transcriptMB: number | null;
    staleSec: number;
    errorRate: number;
    errorTotal: number;
    overflowCount: number;
    resetRecently: boolean;
    issues: string[];
  } {
    const transcript = getTranscriptSize();
    const transcriptMB = transcript ? +(transcript.bytes / 1_000_000).toFixed(2) : null;
    const staleSec = lastSuccessTs > 0 ? Math.round((Date.now() - lastSuccessTs) / 1000) : 0;
    const { rate, total } = computeErrorRate();
    const resetRecently = lastResetTs > 0 && (Date.now() - lastResetTs) < STALENESS_CRITICAL_MS * 2;

    const issues: string[] = [];
    if (transcriptMB !== null && transcript!.bytes >= SESSION_SIZE_WARNING_BYTES) {
      issues.push(`transcript ${transcriptMB}MB (threshold ${(SESSION_SIZE_WARNING_BYTES / 1_000_000).toFixed(1)}MB)`);
    }
    if (lastSuccessTs > 0 && (Date.now() - lastSuccessTs) >= STALENESS_WARNING_MS && recentOutcomes.length >= 3) {
      issues.push(`stale ${staleSec}s since last success`);
    }
    if (total >= 5 && rate > 0.5) {
      issues.push(`error rate ${Math.round(rate * 100)}% (${total} samples)`);
    }
    if (consecutiveOverflowErrors >= 3) {
      issues.push(`overflow errors ${consecutiveOverflowErrors}/${OVERFLOW_CONSECUTIVE_THRESHOLD}`);
    }
    if (resetRecently && lastSuccessTs > 0 && lastSuccessTs < lastResetTs) {
      issues.push("post-reset stall (no success since reset)");
    }

    return { transcriptMB, staleSec, errorRate: rate, errorTotal: total, overflowCount: consecutiveOverflowErrors, resetRecently, issues };
  }

  async function runHealthWatchdog(): Promise<void> {
    const stateDir = getStateDir();
    if (!stateDir) return;

    const transcript = getTranscriptSize();
    const now = Date.now();

    // ── Layer 1: Proactive session size check ────────────────────────────
    if (transcript && transcript.bytes >= SESSION_SIZE_WARNING_BYTES) {
      const sizeMB = (transcript.bytes / 1_000_000).toFixed(1);

      if (transcript.bytes >= SESSION_SIZE_RESTART_BYTES) {
        // Critical — force reset
        api.logger.warn(`sinain-hud: watchdog — transcript ${sizeMB}MB, forcing overflow reset`);
        if (performOverflowReset()) {
          lastResetTs = now;
          consecutiveOverflowErrors = 0;
          sendTelegramAlert("proactive_reset", "⚠️ *sinain-hud* proactive session reset", `• Transcript was ${sizeMB}MB → truncated\n• No downtime expected`, stateDir);
        }
      } else {
        // Warning — proactive reset at 1.5MB
        api.logger.info(`sinain-hud: watchdog — transcript ${sizeMB}MB, proactive reset`);
        if (performOverflowReset()) {
          lastResetTs = now;
          consecutiveOverflowErrors = 0;
          sendTelegramAlert("proactive_reset", "⚠️ *sinain-hud* proactive session reset", `• Transcript was ${sizeMB}MB → truncated\n• No downtime expected`, stateDir);
        }
      }
    }

    // ── Staleness check ──────────────────────────────────────────────────
    if (lastSuccessTs > 0 && recentOutcomes.length >= 3) {
      const staleMs = now - lastSuccessTs;

      if (staleMs >= STALENESS_WARNING_MS && staleMs < STALENESS_CRITICAL_MS) {
        const staleMin = Math.round(staleMs / 60_000);
        sendTelegramAlert("staleness_warning", "⚠️ *sinain-hud* response stale",
          `• No successful run in ${staleMin}min\n• Error rate: ${Math.round(computeErrorRate().rate * 100)}%`,
          stateDir);
      }
    }

    // ── Layer 2: Emergency restart — reset didn't recover ────────────────
    if (lastResetTs > 0 && lastSuccessTs > 0 && lastSuccessTs < lastResetTs) {
      const sinceResetMs = now - lastResetTs;
      if (sinceResetMs >= STALENESS_CRITICAL_MS) {
        // Reset was performed but no success since → queue is jammed
        const canRestart = (now - lastAutoRestartTs) >= AUTO_RESTART_COOLDOWN_MS;
        if (canRestart) {
          const staleMin = Math.round((now - lastSuccessTs) / 60_000);
          api.logger.warn(`sinain-hud: EMERGENCY RESTART — reset ${Math.round(sinceResetMs / 60_000)}min ago, no recovery`);
          // Send alert BEFORE exit so user sees it
          await sendTelegramAlert("emergency_restart", "🔴 *sinain-hud* EMERGENCY RESTART",
            `• Queue jammed — reset didn't recover in ${Math.round(sinceResetMs / 60_000)}min\n• Last success: ${staleMin}min ago\n• Gateway restarting now (~5s)`,
            stateDir);
          lastAutoRestartTs = now;
          // Give Telegram a moment to deliver
          await new Promise((r) => setTimeout(r, 1000));
          process.exit(1);
        } else {
          api.logger.warn("sinain-hud: watchdog — would restart but cooldown active (max 1/hour)");
        }
      }
    }

    // ── Error rate alert ─────────────────────────────────────────────────
    const { rate, total } = computeErrorRate();
    if (total >= 5 && rate > 0.5) {
      sendTelegramAlert("high_error_rate", "⚠️ *sinain-hud* high error rate",
        `• ${Math.round(rate * 100)}% failures over ${total} samples\n• Consecutive overflow errors: ${consecutiveOverflowErrors}/${OVERFLOW_CONSECUTIVE_THRESHOLD}`,
        stateDir);
    }

    // ── Overflow approaching threshold ───────────────────────────────────
    if (consecutiveOverflowErrors >= 3 && consecutiveOverflowErrors < OVERFLOW_CONSECUTIVE_THRESHOLD) {
      sendTelegramAlert("overflow_warning", "⚠️ *sinain-hud* overflow errors accumulating",
        `• ${consecutiveOverflowErrors}/${OVERFLOW_CONSECUTIVE_THRESHOLD} consecutive overflow errors\n• Auto-reset will trigger at ${OVERFLOW_CONSECUTIVE_THRESHOLD}`,
        stateDir);
    }
  }

  // ==========================================================================
  // Service registration
  // ==========================================================================

  api.registerService({
    id: "sinain-hud",
    start: () => {
      api.logger.info(
        `sinain-hud: service started (heartbeat: ${cfg.heartbeatPath ?? "not configured"})`,
      );

      // Start health watchdog — runs every 5 minutes, independent of curation
      watchdogInterval = setInterval(() => {
        runHealthWatchdog().catch((err) => {
          api.logger.warn(`sinain-hud: watchdog error: ${String(err)}`);
        });
      }, WATCHDOG_INTERVAL_MS);
      api.logger.info("sinain-hud: health watchdog started (5-min interval)");

      // Start curation timer — runs every 30 minutes
      curationInterval = setInterval(async () => {
        // Skip curation during outage — scripts would work (OpenRouter) but
        // results are wasted when no agent runs succeed
        if (outageDetected) {
          api.logger.info("sinain-hud: curation skipped — outage active");
          return;
        }

        // Find workspace dir from active sessions or last known
        let workspaceDir: string | undefined;
        for (const state of sessionStates.values()) {
          if (state.workspaceDir) { workspaceDir = state.workspaceDir; break; }
        }
        workspaceDir ??= lastWorkspaceDir ?? undefined;
        if (!workspaceDir) {
          api.logger.info("sinain-hud: curation skipped — no workspace dir");
          return;
        }
        try {
          await runCurationPipeline(workspaceDir);
        } catch (err) {
          api.logger.warn(`sinain-hud: curation pipeline error: ${String(err)}`);
        }

        // ── Proactive session hygiene ──────────────────────────────────
        // Check sinain session size/age and archive+truncate if needed.
        // This prevents context bloat from causing cascading RPC timeouts.
        try {
          const sessionsJsonPath = getSessionsJsonPath();
          if (sessionsJsonPath && cfg.sessionKey) {
            const sessionsData = JSON.parse(readFileSync(sessionsJsonPath, "utf-8"));
            const sinainSession = sessionsData[cfg.sessionKey];
            if (sinainSession?.sessionFile && existsSync(sinainSession.sessionFile)) {
              const size = statSync(sinainSession.sessionFile).size;
              const createdAt = typeof sinainSession.createdAt === "number"
                ? sinainSession.createdAt
                : Date.now();
              const ageMs = Date.now() - createdAt;
              if (size > SESSION_HYGIENE_SIZE_BYTES || ageMs > SESSION_HYGIENE_AGE_MS) {
                api.logger.info(
                  `sinain-hud: proactive session hygiene \u2014 size=${Math.round(size / 1024)}KB, age=${Math.round(ageMs / 3600000)}h`,
                );
                if (performOverflowReset()) {
                  consecutiveOverflowErrors = 0;
                  outageDetected = false;
                  consecutiveFailures = 0;
                  outageStartTs = 0;
                }
              }
            }
          }
        } catch (err) {
          api.logger.warn(`sinain-hud: session hygiene check error: ${String(err)}`);
        }
      }, 30 * 60 * 1000); // 30 minutes
    },
    stop: () => {
      if (curationInterval) {
        clearInterval(curationInterval);
        curationInterval = null;
      }
      if (watchdogInterval) {
        clearInterval(watchdogInterval);
        watchdogInterval = null;
      }
      api.logger.info("sinain-hud: service stopped");
      sessionStates.clear();
    },
  });
}
