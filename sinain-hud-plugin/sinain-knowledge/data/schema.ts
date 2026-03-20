/**
 * sinain-knowledge — Shared type definitions
 *
 * All types used across the knowledge system layers.
 * No runtime dependencies — pure type definitions + interfaces.
 */

// ============================================================================
// Logger interface (decoupled from OpenClaw)
// ============================================================================

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

// ============================================================================
// Plugin config
// ============================================================================

export type PluginConfig = {
  heartbeatPath?: string;
  skillPath?: string;
  memoryPath?: string;
  modulesPath?: string;
  sessionKey?: string;
  userTimezone?: string;
  snapshotRepoPath?: string;
};

// ============================================================================
// Module system
// ============================================================================

export type ModuleRegistryEntry = {
  status: "active" | "suspended" | "disabled";
  priority: number;
  activatedAt: string | null;
  lastTriggered: string | null;
  locked: boolean;
};

export type ModuleRegistry = {
  version: number;
  modules: Record<string, ModuleRegistryEntry>;
};

// ============================================================================
// Session tracking
// ============================================================================

export type ToolUsageEntry = {
  toolName: string;
  ts: number;
  durationMs?: number;
  error?: string;
};

export type SessionState = {
  startedAt: number;
  toolUsage: ToolUsageEntry[];
  workspaceDir?: string;
  heartbeatToolCalled?: boolean;
};

// ============================================================================
// Parent context injection (subagent support)
// ============================================================================

export type ParentContextCache = {
  sessionKey: string;
  capturedAt: number;
  contextText: string;
};

// ============================================================================
// Script execution abstraction
// ============================================================================

export type ScriptResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type ScriptRunner = (
  args: string[],
  opts: { timeoutMs: number; cwd: string },
) => Promise<ScriptResult>;
