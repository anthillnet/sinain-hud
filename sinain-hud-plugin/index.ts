/**
 * sinain-hud OpenClaw Plugin
 *
 * Manages the sinain-hud agent lifecycle:
 * - Auto-deploys HEARTBEAT.md and SKILL.md to workspace on agent start
 * - Tracks tool usage patterns per session (fire-and-forget, sync only)
 * - Generates structured session summaries on agent end
 * - Strips <private> tags from tool results before persistence
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, chmodSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type {
  PluginConfig,
  SessionState,
  ParentContextCache,
} from "./sinain-knowledge/data/schema.js";
import { KnowledgeStore } from "./sinain-knowledge/data/store.js";
import { ResilienceManager, HealthWatchdog, OVERFLOW_CONSECUTIVE_THRESHOLD, SHORT_FAILURE_THRESHOLD_MS, ERROR_WINDOW_MS, SESSION_HYGIENE_SIZE_BYTES, SESSION_HYGIENE_AGE_MS, ALERT_COOLDOWN_MS } from "./sinain-knowledge/curation/resilience.js";
import type { ResilienceBackend } from "./sinain-knowledge/curation/resilience.js";
import { CurationEngine } from "./sinain-knowledge/curation/engine.js";
import { GitSnapshotStore } from "./sinain-knowledge/data/git-store.js";

// ============================================================================
// Privacy helpers
// ============================================================================

const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>/g;

// Resilience constants — only import what index.ts still uses directly
// (ResilienceManager, HealthWatchdog, CurationEngine own the rest)

// ============================================================================
// Parent context injection (subagent support)
// ============================================================================

const PARENT_CONTEXT_MAX_CHARS = 4000;
const PARENT_CONTEXT_TTL_MS = 10 * 60_000; // 10 minutes — stale cache won't be injected


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
// Plugin Definition
// ============================================================================

export default function sinainHudPlugin(api: OpenClawPluginApi): void {
  const cfg = (api.pluginConfig ?? {}) as PluginConfig;
  const sessionStates = new Map<string, SessionState>();
  let lastWorkspaceDir: string | null = null;

  // Pre-initialize from config so situation.update works immediately after gateway restart,
  // without waiting for the first before_agent_start event.
  const _cfgWorkspace = (api.config as any).agents?.defaults?.workspace as string | undefined;
  if (_cfgWorkspace && existsSync(_cfgWorkspace)) {
    lastWorkspaceDir = _cfgWorkspace;
    api.logger.info(`sinain-hud: workspace pre-initialized from config: ${lastWorkspaceDir}`);
  }

  // KnowledgeStore — wraps all file I/O for workspace, playbooks, modules, eval
  const store = new KnowledgeStore(lastWorkspaceDir ?? "/tmp/sinain-placeholder", api.logger);

  // Resilience layer
  const resilience = new ResilienceManager();

  // Parent context cache for subagent injection
  let parentContextCache: ParentContextCache | null = null;

  // ── Backend adapter for resilience (OpenClaw-specific) ──────────────────
  function getSessionsJsonPath(): string | null {
    if (!lastWorkspaceDir) return null;
    const sessionsDir = join(dirname(lastWorkspaceDir), "agents", "main", "sessions");
    const p = join(sessionsDir, "sessions.json");
    return existsSync(p) ? p : null;
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
    const OVERFLOW_TRANSCRIPT_MIN_BYTES = 1_000_000;
    const size = statSync(transcriptPath).size;
    if (size < OVERFLOW_TRANSCRIPT_MIN_BYTES) {
      api.logger.info(
        `sinain-hud: overflow reset skipped — transcript only ${Math.round(size / 1024)}KB (threshold: ${Math.round(OVERFLOW_TRANSCRIPT_MIN_BYTES / 1024)}KB)`,
      );
      return false;
    }
    const archivePath = transcriptPath.replace(/\.jsonl$/, `.archived.${Date.now()}.jsonl`);
    try { copyFileSync(transcriptPath, archivePath); } catch (err) {
      api.logger.warn(`sinain-hud: overflow reset aborted — archive failed: ${err}`);
      return false;
    }
    writeFileSync(transcriptPath, "", "utf-8");
    try {
      session.contextTokens = 0;
      writeFileSync(sessionsJsonPath, JSON.stringify(sessionsData, null, 2), "utf-8");
    } catch {}
    api.logger.info(
      `sinain-hud: === OVERFLOW RESET === Transcript truncated (was ${Math.round(size / 1024)}KB). Archive: ${archivePath}`,
    );
    return true;
  }

  function getStateDir(): string | null {
    if (!lastWorkspaceDir) return null;
    return dirname(lastWorkspaceDir);
  }

  const resilienceBackend: ResilienceBackend = {
    getTranscriptSize,
    performOverflowReset,
    async sendAlert(alertType: string, title: string, body: string): Promise<void> {
      const sd = getStateDir();
      if (sd) sendTelegramAlert(alertType, title, body, sd);
    },
  };

  // CurationEngine + HealthWatchdog
  const scriptRunner = (args: string[], opts: { timeoutMs: number; cwd: string }) =>
    api.runtime.system.runCommandWithTimeout(args, opts);
  const engine = new CurationEngine(store, scriptRunner, resilience, { userTimezone: cfg.userTimezone ?? "Europe/Berlin" }, api.logger);
  if (cfg.snapshotRepoPath) {
    engine.setGitSnapshotStore(new GitSnapshotStore(cfg.snapshotRepoPath, api.logger));
    api.logger.info(`sinain-hud: git snapshot store configured at ${cfg.snapshotRepoPath}`);
  }
  const watchdog = new HealthWatchdog(resilience, resilienceBackend, api.logger);

  function appendToContextCache(line: string): void {
    if (!parentContextCache) return;
    parentContextCache.contextText += "\n" + line;
    parentContextCache.capturedAt = Date.now();
    if (parentContextCache.contextText.length > PARENT_CONTEXT_MAX_CHARS) {
      const excess = parentContextCache.contextText.length - PARENT_CONTEXT_MAX_CHARS;
      const newStart = parentContextCache.contextText.indexOf("\n", excess);
      parentContextCache.contextText = newStart >= 0
        ? parentContextCache.contextText.slice(newStart + 1)
        : parentContextCache.contextText.slice(excess);
    }
  }

  api.logger.info("sinain-hud: plugin registered");

  // ==========================================================================
  // RPC: situation.update — receive fresh SITUATION.md from sinain-core
  // ==========================================================================

  api.registerGatewayMethod("situation.update", ({ params, respond }: { params: Record<string, unknown>; respond: (ok: boolean, result: unknown, error?: unknown) => void }) => {
    const content = params.content;
    if (typeof content !== "string" || !content) {
      respond(false, null, { code: "invalid_params", message: "content must be a non-empty string" });
      return;
    }
    if (!lastWorkspaceDir) {
      respond(false, null, { code: "not_ready", message: "workspace not initialized" });
      return;
    }
    try {
      store.writeSituation(content as string);
      respond(true, { ok: true, bytes: (content as string).length });
      api.logger.info(`sinain-hud: SITUATION.md updated via RPC (${(content as string).length} chars)`);
    } catch (err: any) {
      respond(false, null, { code: "write_error", message: err.message });
    }
  });

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

    // Track workspace dir in session state, store, and for curation timer
    lastWorkspaceDir = workspaceDir;
    store.setWorkspaceDir(workspaceDir);
    const sessionKey = ctx.sessionKey;
    if (sessionKey) {
      const state = sessionStates.get(sessionKey);
      if (state) {
        state.workspaceDir = workspaceDir;
      }
    }

    const now = Date.now();

    // ── Debounced file sync ──────────────────────────────────────────────
    if (resilience.isFileSyncDue()) {
      const heartbeatSource = cfg.heartbeatPath
        ? api.resolvePath(cfg.heartbeatPath)
        : undefined;
      const skillSource = cfg.skillPath
        ? api.resolvePath(cfg.skillPath)
        : undefined;

      store.deployFile(heartbeatSource, "HEARTBEAT.md");
      store.deployFile(skillSource, "SKILL.md");

      const memorySource = cfg.memoryPath ? api.resolvePath(cfg.memoryPath) : undefined;
      if (memorySource) {
        store.deployDir(memorySource, "sinain-memory");
        const gbPath = join(workspaceDir, "sinain-memory", "git_backup.sh");
        if (existsSync(gbPath)) try { chmodSync(gbPath, 0o755); } catch {}
      }

      const modulesSource = cfg.modulesPath ? api.resolvePath(cfg.modulesPath) : undefined;
      if (modulesSource && existsSync(modulesSource)) {
        store.deployModules(modulesSource);
      }

      resilience.markFileSynced();
    }

    // ── Debounced playbook generation ────────────────────────────────────
    if (resilience.isPlaybookGenDue()) {
      const modulesSource = cfg.modulesPath ? api.resolvePath(cfg.modulesPath) : undefined;
      if (modulesSource && existsSync(modulesSource)) {
        store.generateEffectivePlaybook();
        resilience.markPlaybookGenerated();
      }
    }

    // ── Fire-and-forget: ingest active module patterns into triple store
    try {
      const registry = store.readModuleRegistry();
      if (registry) {
        for (const [id, entry] of Object.entries(registry.modules)) {
          if (entry.status === "active") {
            api.runtime.system.runCommandWithTimeout(
              ["uv", "run", "--with", "requests", "python3",
               "sinain-memory/triple_ingest.py",
               "--memory-dir", "memory/",
               "--ingest-module", id,
               "--modules-dir", "modules/"],
              { timeoutMs: 15_000, cwd: workspaceDir },
            ).catch(() => {});
          }
        }
      }
    } catch {}

    // ── Memory dirs — always run (cheap, idempotent) ────────────────────
    store.ensureMemoryDirs();

    // ── Context capture + subagent injection ────────────────────────────
    const isSubagent = sessionKey ? isSubagentSession(sessionKey) : false;

    if (!isSubagent) {
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

    // ── Context assembly (delegated to CurationEngine) ────────────────
    const contextParts = await engine.assembleContext({
      isSubagent,
      parentContextText: parentContextCache?.contextText ?? null,
      parentContextAgeMs: parentContextCache ? now - parentContextCache.capturedAt : undefined,
      parentContextTtlMs: PARENT_CONTEXT_TTL_MS,
      heartbeatConfigured: !!cfg.heartbeatPath,
      heartbeatTargetExists: existsSync(join(workspaceDir, "HEARTBEAT.md")),
    });

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

    // ── Retry storm: track outcome via ResilienceManager ────────────────
    resilience.recentOutcomes.push({
      ts: Date.now(),
      success: isSuccess,
      error: isSuccess ? undefined : String(event.error ?? "unknown"),
    });

    if (isSuccess) {
      resilience.recordSuccess(resilienceBackend, api.logger);
    } else if (isShortFailure) {
      resilience.recordShortFailure(resilienceBackend, api.logger);
    }

    // ── Context overflow watchdog ──────────────────────────────────────
    if (sessionKey === cfg.sessionKey) {
      resilience.checkOverflow(isSuccess, event.error ? String(event.error) : undefined, durationMs, resilienceBackend, api.logger);
    }

    // ── Count tool usage by name ────────────────────────────────────────
    const toolCounts: Record<string, number> = {};
    for (const usage of state.toolUsage) {
      toolCounts[usage.toolName] = (toolCounts[usage.toolName] ?? 0) + 1;
    }

    // ── Write session summary (skip during outage — noise reduction) ───
    const skipSummary = resilience.outageDetected && isShortFailure;
    if (state.workspaceDir && !skipSummary) {
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
        store.appendSessionSummary(summary);
        api.logger.info(
          `sinain-hud: session summary written (${toolCount} tools, ${Math.round(durationMs / 1000)}s)`,
        );

        // Fire-and-forget: ingest session summary into triple store
        if (state.workspaceDir) {
          api.runtime.system.runCommandWithTimeout(
            ["uv", "run", "--with", "requests", "python3",
             "sinain-memory/triple_ingest.py",
             "--memory-dir", "memory/",
             "--ingest-session", JSON.stringify(summary),
             "--embed"],
            { timeoutMs: 15_000, cwd: state.workspaceDir },
          ).catch(() => {});
        }
      } catch (err) {
        api.logger.warn(
          `sinain-hud: failed to write session summary: ${String(err)}`,
        );
      }
    }

    // ── Heartbeat compliance (exempt during outage) ─────────────────────
    if ((ctx as Record<string, unknown>).messageProvider === "heartbeat") {
      if (resilience.outageDetected && isShortFailure) {
        api.logger.info(
          `sinain-hud: heartbeat compliance exempted (outage active, ${Math.round(durationMs / 1000)}s run)`,
        );
      } else if (!state.heartbeatToolCalled) {
        resilience.consecutiveHeartbeatSkips++;
        api.logger.warn(
          `sinain-hud: heartbeat compliance violation — tool not called (consecutive: ${resilience.consecutiveHeartbeatSkips})`,
        );
        if (resilience.consecutiveHeartbeatSkips >= 3) {
          api.logger.warn(
            `sinain-hud: ESCALATION — ${resilience.consecutiveHeartbeatSkips} consecutive heartbeat skips`,
          );
        }
      } else {
        resilience.consecutiveHeartbeatSkips = 0;
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
    resilience.resetAll();
    parentContextCache = null;
    _alertCooldowns.clear();
    _cachedBotToken = undefined;
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
      const { rate, total, failures } = resilience.computeErrorRate();
      lines.push("\n**Resilience**");
      lines.push(`- Outage: ${resilience.outageDetected ? `ACTIVE (${Math.round((Date.now() - resilience.outageStartTs) / 1000)}s, ${resilience.consecutiveFailures} consecutive failures)` : "clear"}`);
      lines.push(`- Error rate: ${Math.round(rate * 100)}% (${failures}/${total} in ${ERROR_WINDOW_MS / 60_000}min window)`);
      lines.push(`- Last success: ${resilience.lastSuccessTs > 0 ? `${Math.round((Date.now() - resilience.lastSuccessTs) / 1000)}s ago` : "never"}`);
      lines.push(`- Heartbeat skips: ${resilience.consecutiveHeartbeatSkips}`);
      lines.push(`- Overflow watchdog: ${resilience.consecutiveOverflowErrors}/${OVERFLOW_CONSECUTIVE_THRESHOLD}`);
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

      const registry = store.readModuleRegistry();
      if (!registry) {
        return { text: "Module system not initialized (no module-registry.json found)." };
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

      const lines: string[] = ["**Evaluation Report**\n"];

      // Find latest report
      const latestReport = store.readLatestEvalReport();
      if (latestReport) {
        lines.push(latestReport.trim());
      } else {
        lines.push("No eval reports generated yet.\n");
      }

      // Show latest eval-log entries
      const recentLogs = store.readRecentEvalLogs(5);
      if (recentLogs.length > 0) {
        lines.push("\n**Recent Tick Evaluations** (last 5):");
        for (const line of recentLogs) {
          try {
            const e = JSON.parse(line) as Record<string, unknown>;
            const judges = e.judges ? ` judgeAvg=${e.judgeAvg ?? "?"}` : "";
            lines.push(`  ${e.tickTs} — passRate=${e.passRate}${judges}`);
          } catch {
            // skip malformed line
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
      const checks = watchdog.runChecks();
      const lines: string[] = ["**Health Watchdog Report**\n"];

      lines.push(`Transcript: ${checks.transcriptMB !== null ? `${checks.transcriptMB}MB` : "unknown"}`);
      lines.push(`Last success: ${checks.staleSec > 0 ? `${checks.staleSec}s ago` : resilience.lastSuccessTs > 0 ? "just now" : "never"}`);
      lines.push(`Error rate: ${Math.round(checks.errorRate * 100)}% (${checks.errorTotal} samples)`);
      lines.push(`Overflow counter: ${checks.overflowCount}/${OVERFLOW_CONSECUTIVE_THRESHOLD}`);
      lines.push(`Last reset: ${resilience.lastResetTs > 0 ? `${Math.round((Date.now() - resilience.lastResetTs) / 1000)}s ago` : "never"}`);
      lines.push(`Last auto-restart: ${resilience.lastAutoRestartTs > 0 ? `${Math.round((Date.now() - resilience.lastAutoRestartTs) / 1000)}s ago` : "never"}`);
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
          store.setWorkspaceDir(workspaceDir);
          const result = await engine.executeHeartbeatTick(params);

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
  // Service registration
  // ==========================================================================

  api.registerService({
    id: "sinain-hud",
    start: () => {
      api.logger.info(
        `sinain-hud: service started (heartbeat: ${cfg.heartbeatPath ?? "not configured"})`,
      );

      // Start health watchdog — runs every 5 minutes
      watchdog.start();

      // Start curation timer — runs every 30 minutes
      const resolveWorkspaceDir = (): string | null => {
        for (const state of sessionStates.values()) {
          if (state.workspaceDir) return state.workspaceDir;
        }
        return lastWorkspaceDir;
      };
      engine.startCurationTimer(
        () => resilience.outageDetected,
        resolveWorkspaceDir,
      );

      // Proactive session hygiene on a 30-min curation cycle
      // (piggybacks on the curation timer — checked after each pipeline run)
      setInterval(() => {
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
                  `sinain-hud: proactive session hygiene — size=${Math.round(size / 1024)}KB, age=${Math.round(ageMs / 3600000)}h`,
                );
                if (performOverflowReset()) {
                  resilience.consecutiveOverflowErrors = 0;
                  resilience.outageDetected = false;
                  resilience.consecutiveFailures = 0;
                  resilience.outageStartTs = 0;
                }
              }
            }
          }
        } catch (err) {
          api.logger.warn(`sinain-hud: session hygiene check error: ${String(err)}`);
        }
      }, 30 * 60 * 1000);
    },
    stop: () => {
      engine.stopCurationTimer();
      watchdog.stop();
      api.logger.info("sinain-hud: service stopped");
      sessionStates.clear();
    },
  });
}
