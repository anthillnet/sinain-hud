/**
 * sinain-knowledge — OpenClaw BackendAdapter
 *
 * Wraps the OpenClaw plugin API to implement the BackendAdapter interface.
 * Handles script execution (via uv), session file access, transcript management,
 * and Telegram alerts using the bot token from openclaw.json.
 */

import { readFileSync, writeFileSync, existsSync, statSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";

import type { ScriptResult } from "../../data/schema.js";
import type { BackendAdapter, BackendCapabilities, ScriptOptions } from "../interface.js";

// ============================================================================
// Telegram alert helpers (self-contained within the adapter)
// ============================================================================

const ALERT_COOLDOWN_MS = 15 * 60_000;
const OVERFLOW_TRANSCRIPT_MIN_BYTES = 1_000_000;

let _cachedBotToken: string | null | undefined;
let _alertMissingConfigLogged = false;
const _alertCooldowns = new Map<string, number>();

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

// ============================================================================
// OpenClawAdapter
// ============================================================================

/**
 * Minimal type for the OpenClaw plugin API.
 * Only the methods we actually use — avoids importing the full SDK type.
 */
export interface OpenClawApi {
  pluginConfig: unknown;
  config: unknown;
  logger: { info(msg: string): void; warn(msg: string): void };
  resolvePath(configPath: string): string;
  runtime: {
    system: {
      runCommandWithTimeout(
        args: string[],
        opts: { timeoutMs: number; cwd: string },
      ): Promise<ScriptResult>;
    };
  };
}

export class OpenClawAdapter implements BackendAdapter {
  readonly name = "openclaw";
  readonly capabilities: BackendCapabilities = {
    hasHeartbeatTool: true,
    hasRPC: true,
    hasSessionHistory: true,
    hasTranscriptAccess: true,
    supportsPython: true,
    hasTelegramAlerts: true,
  };

  private workspaceDir: string | null = null;

  constructor(
    private api: OpenClawApi,
    private sessionKey: string | undefined,
  ) {}

  getWorkspaceDir(): string | null {
    return this.workspaceDir;
  }

  setWorkspaceDir(dir: string): void {
    this.workspaceDir = dir;
  }

  async runScript(args: string[], opts: ScriptOptions): Promise<ScriptResult> {
    return this.api.runtime.system.runCommandWithTimeout(args, opts);
  }

  resolvePath(configPath: string): string {
    return this.api.resolvePath(configPath);
  }

  // ── Session management ────────────────────────────────────────────────

  getSessionsJsonPath(): string | null {
    if (!this.workspaceDir) return null;
    const sessionsDir = join(dirname(this.workspaceDir), "agents", "main", "sessions");
    const p = join(sessionsDir, "sessions.json");
    return existsSync(p) ? p : null;
  }

  getTranscriptSize(): { path: string; bytes: number } | null {
    const sessionsJsonPath = this.getSessionsJsonPath();
    if (!sessionsJsonPath || !this.sessionKey) return null;
    try {
      const sessionsData = JSON.parse(readFileSync(sessionsJsonPath, "utf-8"));
      const session = sessionsData[this.sessionKey];
      const transcriptPath = session?.sessionFile as string | undefined;
      if (!transcriptPath || !existsSync(transcriptPath)) return null;
      return { path: transcriptPath, bytes: statSync(transcriptPath).size };
    } catch {
      return null;
    }
  }

  performTranscriptReset(): boolean {
    if (!this.sessionKey || !this.workspaceDir) {
      this.api.logger.warn("sinain-hud: overflow reset aborted — no sessionKey or workspace dir");
      return false;
    }
    const sessionsJsonPath = this.getSessionsJsonPath();
    if (!sessionsJsonPath) {
      this.api.logger.warn("sinain-hud: overflow reset aborted — sessions.json not found");
      return false;
    }
    let sessionsData: Record<string, Record<string, unknown>>;
    try {
      sessionsData = JSON.parse(readFileSync(sessionsJsonPath, "utf-8"));
    } catch (err) {
      this.api.logger.warn(`sinain-hud: overflow reset aborted — cannot parse sessions.json: ${err}`);
      return false;
    }
    const session = sessionsData[this.sessionKey];
    const transcriptPath = session?.sessionFile as string | undefined;
    if (!transcriptPath || !existsSync(transcriptPath)) {
      this.api.logger.warn(`sinain-hud: overflow reset aborted — transcript not found: ${transcriptPath}`);
      return false;
    }
    const size = statSync(transcriptPath).size;
    if (size < OVERFLOW_TRANSCRIPT_MIN_BYTES) {
      this.api.logger.info(
        `sinain-hud: overflow reset skipped — transcript only ${Math.round(size / 1024)}KB (threshold: ${Math.round(OVERFLOW_TRANSCRIPT_MIN_BYTES / 1024)}KB)`,
      );
      return false;
    }
    const archivePath = transcriptPath.replace(/\.jsonl$/, `.archived.${Date.now()}.jsonl`);
    try {
      copyFileSync(transcriptPath, archivePath);
    } catch (err) {
      this.api.logger.warn(`sinain-hud: overflow reset aborted — archive failed: ${err}`);
      return false;
    }
    writeFileSync(transcriptPath, "", "utf-8");
    try {
      session.contextTokens = 0;
      writeFileSync(sessionsJsonPath, JSON.stringify(sessionsData, null, 2), "utf-8");
    } catch {}
    this.api.logger.info(
      `sinain-hud: === OVERFLOW RESET === Transcript truncated (was ${Math.round(size / 1024)}KB). Archive: ${archivePath}`,
    );
    return true;
  }

  // ── Alerts ────────────────────────────────────────────────────────────

  async sendAlert(alertType: string, title: string, body: string): Promise<void> {
    const stateDir = this.getStateDir();
    if (!stateDir) return;

    const chatId = process.env.SINAIN_ALERT_CHAT_ID;
    const token = readBotToken(stateDir);

    if (!chatId || !token) {
      if (!_alertMissingConfigLogged) {
        _alertMissingConfigLogged = true;
        console.log("sinain-hud: Telegram alerts disabled (missing SINAIN_ALERT_CHAT_ID or bot token)");
      }
      return;
    }

    const lastSent = _alertCooldowns.get(alertType) ?? 0;
    if (Date.now() - lastSent < ALERT_COOLDOWN_MS) return;
    _alertCooldowns.set(alertType, Date.now());

    const text = `${title}\n${body}`;
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    }).catch(() => {});
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    // Pre-initialize workspace from config
    const cfgWorkspace = (this.api.config as any).agents?.defaults?.workspace as string | undefined;
    if (cfgWorkspace && existsSync(cfgWorkspace)) {
      this.workspaceDir = cfgWorkspace;
      this.api.logger.info(`sinain-hud: workspace pre-initialized from config: ${this.workspaceDir}`);
    }
  }

  dispose(): void {
    // Nothing to clean up
  }

  resetAlertState(): void {
    _alertCooldowns.clear();
    _cachedBotToken = undefined;
    _alertMissingConfigLogged = false;
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  private getStateDir(): string | null {
    if (!this.workspaceDir) return null;
    return dirname(this.workspaceDir);
  }
}
