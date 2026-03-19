/**
 * sinain-knowledge — BackendAdapter interface
 *
 * Abstracts the runtime environment (OpenClaw, generic CLI, etc.) so the
 * knowledge system (KnowledgeStore + CurationEngine) can run on any backend.
 */

import type { ScriptResult } from "../data/schema.js";

// ============================================================================
// Capabilities
// ============================================================================

export interface BackendCapabilities {
  hasHeartbeatTool: boolean;
  hasRPC: boolean;
  hasSessionHistory: boolean;
  hasTranscriptAccess: boolean;
  supportsPython: boolean;
  hasTelegramAlerts: boolean;
}

// ============================================================================
// Script execution options
// ============================================================================

export interface ScriptOptions {
  timeoutMs: number;
  cwd: string;
}

// ============================================================================
// BackendAdapter
// ============================================================================

export interface BackendAdapter {
  readonly name: string;
  readonly capabilities: BackendCapabilities;

  /** Get the current workspace directory, if available. */
  getWorkspaceDir(): string | null;

  /** Execute a command and return its result. */
  runScript(args: string[], opts: ScriptOptions): Promise<ScriptResult>;

  /** Resolve a config-relative path to an absolute path. */
  resolvePath(configPath: string): string;

  // ── Session management (optional) ─────────────────────────────────────

  /** Path to sessions.json, if accessible. */
  getSessionsJsonPath?(): string | null;

  /** Get transcript file size for overflow detection. */
  getTranscriptSize?(): { path: string; bytes: number } | null;

  /** Truncate and archive the current session transcript. */
  performTranscriptReset?(): boolean;

  // ── Alerts (optional) ─────────────────────────────────────────────────

  /** Send an alert notification (Telegram, webhook, etc.). */
  sendAlert?(type: string, title: string, body: string): Promise<void>;

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /** Initialize the adapter (called once at plugin startup). */
  initialize(): Promise<void>;

  /** Dispose resources (called at plugin shutdown). */
  dispose(): void;
}
