import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { UsageMessage } from "../types.js";
import { warn } from "../log.js";

const TAG = "claude-usage";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export type ClaudeUsageSnapshot = Omit<UsageMessage, "type">;

export class ClaudeUsageTracker {
  private accessToken: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private warnedMessages = new Set<string>();

  constructor(private readonly onUsage: (snapshot: ClaudeUsageSnapshot) => void) {}

  async fetchUsage(): Promise<ClaudeUsageSnapshot | null> {
    try {
      let response = await this.requestUsage();
      if (response.status === 401) {
        this.accessToken = null;
        response = await this.requestUsage();
      }
      if (!response.ok) throw new Error(`Claude usage request failed: HTTP ${response.status}`);
      return normalizeUsage(await response.json());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!this.warnedMessages.has(message)) {
        this.warnedMessages.add(message);
        warn(TAG, message);
      }
      return null;
    }
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), intervalMs);
    void this.poll();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    if (!this.timer || this.polling) return;
    this.polling = true;
    try {
      const snapshot = await this.fetchUsage();
      if (snapshot && this.timer) this.onUsage(snapshot);
    } finally {
      this.polling = false;
    }
  }

  private async requestUsage(): Promise<Response> {
    const token = this.accessToken ?? await this.readAccessToken();
    this.accessToken = token;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      return await fetch(USAGE_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readAccessToken(): Promise<string> {
    try {
      const raw = await readKeychainCredential();
      const token = accessTokenFromCredential(raw);
      if (token) return token;
    } catch { /* fall through to credentials file */ }

    try {
      const raw = await readFile(resolve(homedir(), ".claude", ".credentials.json"), "utf8");
      const token = accessTokenFromCredential(raw);
      if (token) return token;
    } catch { /* reported below */ }

    throw new Error("Claude OAuth access token not found");
  }
}

function readKeychainCredential(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 2_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolvePromise(stdout);
    });
  });
}

function accessTokenFromCredential(raw: string): string | null {
  try {
    const credential = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } };
    return typeof credential.claudeAiOauth?.accessToken === "string" && credential.claudeAiOauth.accessToken
      ? credential.claudeAiOauth.accessToken
      : null;
  } catch {
    return null;
  }
}

function normalizeUsage(value: unknown): ClaudeUsageSnapshot {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const fiveHour = normalizeWindow(record.fiveHour ?? record.five_hour);
  const sevenDay = normalizeWindow(record.sevenDay ?? record.seven_day);
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
  };
}

function normalizeWindow(value: unknown): { utilization: number; resetsAt?: number } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.utilization !== "number" || !Number.isFinite(record.utilization) || record.utilization < 0 || record.utilization > 100) return null;
  const resetsAt = normalizeTimestamp(record.resetsAt ?? record.resets_at);
  return {
    utilization: record.utilization,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value !== "string") return undefined;
  const numeric = Number(value);
  if (value.trim() && Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}
