/**
 * sinain-knowledge — Generic BackendAdapter
 *
 * Runs the knowledge system without OpenClaw — uses child_process for script
 * execution, a configurable workspace path, and console logging for alerts.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { ScriptResult } from "../../data/schema.js";
import type { BackendAdapter, BackendCapabilities, ScriptOptions } from "../interface.js";

// ============================================================================
// GenericAdapter
// ============================================================================

export class GenericAdapter implements BackendAdapter {
  readonly name = "generic";
  readonly capabilities: BackendCapabilities = {
    hasHeartbeatTool: false,
    hasRPC: false,
    hasSessionHistory: false,
    hasTranscriptAccess: false,
    supportsPython: true,
    hasTelegramAlerts: false,
  };

  constructor(private workspaceDir: string) {}

  getWorkspaceDir(): string | null {
    return this.workspaceDir;
  }

  async runScript(args: string[], opts: ScriptOptions): Promise<ScriptResult> {
    // Try uv first, fall back to python3
    const [cmd, ...rest] = this._resolveCommand(args);

    return new Promise((resolve, reject) => {
      const child = execFile(cmd, rest, {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error && (error as any).killed) {
          reject(new Error(`Command timed out after ${opts.timeoutMs}ms`));
          return;
        }
        resolve({
          code: error ? (error as any).code ?? 1 : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      });
    });
  }

  resolvePath(configPath: string): string {
    return resolve(configPath);
  }

  // No session management in generic mode

  // Alerts go to console
  async sendAlert(type: string, title: string, body: string): Promise<void> {
    console.log(`[sinain-alert:${type}] ${title}\n${body}`);
  }

  async initialize(): Promise<void> {
    // Detect python availability
    try {
      await this.runScript(["python3", "--version"], { timeoutMs: 5000, cwd: this.workspaceDir });
    } catch {
      console.warn("sinain-knowledge: python3 not found — some features will be unavailable");
    }
  }

  dispose(): void {
    // Nothing to clean up
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private _resolveCommand(args: string[]): string[] {
    // If args starts with "uv", try to use it, otherwise strip the uv prefix
    if (args[0] === "uv") {
      try {
        // Check if uv is available
        require("node:child_process").execFileSync("uv", ["--version"], { timeout: 3000 });
        return args;
      } catch {
        // Strip "uv run --with <pkg>" prefix → just run python3 directly
        const pythonIdx = args.indexOf("python3");
        if (pythonIdx >= 0) {
          return args.slice(pythonIdx);
        }
        return args;
      }
    }
    return args;
  }
}
