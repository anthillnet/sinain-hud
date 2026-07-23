import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEventFrame, AppSessionsConfig } from "../types.js";
import type { AgentSessionRegistry } from "./registry.js";
import { warn } from "../log.js";

const TAG = "app-sessions";

/** Sessions the desktop-app watchers feed exclusively (cse_* bridge sessions,
 * chatgpt:* conversations) never emit a terminal hook, so each watcher sweeps
 * its own sessions to "done" after this much silence. */
const CLAUDE_APP_IDLE_MS = 30 * 60 * 1000;
const CHATGPT_IDLE_MS = 5 * 60 * 1000;

export type ClaudeAppLogEvent =
  | { kind: "frame"; sessionId: string; event: "SessionStart" | "UserPromptSubmit" | "Stop" | "StopFailure"; message?: string }
  | { kind: "waiting"; tool: string }
  | { kind: "resolved"; behavior: "allow" | "deny" };

/** Recognize session-lifecycle lines from the Claude desktop app's main.log
 * ([sessions-bridge] / [sessions-api] tags). Permission lines carry no session
 * id — the caller attributes them to the most recently seen bridge session. */
export function parseClaudeAppLine(line: string): ClaudeAppLogEvent | null {
  if (!line.includes("[sessions-bridge]")) return null;

  let match = line.match(/\[sessions-bridge\] Handling session work \{ sessionId: '([^']+)'/);
  if (match) return { kind: "frame", sessionId: match[1], event: "SessionStart" };

  match = line.match(/\[sessions-bridge\] Received user message for session (\S+)/);
  if (match) return { kind: "frame", sessionId: match[1], event: "UserPromptSubmit", message: "user message received" };

  match = line.match(/\[sessions-bridge\] Query completed for session (\S+) \(pendingTurns=\d+, isError=(true|false)\)/);
  if (match) {
    return match[2] === "true"
      ? { kind: "frame", sessionId: match[1], event: "StopFailure", message: "query errored" }
      : { kind: "frame", sessionId: match[1], event: "Stop", message: "turn completed — waiting for you" };
  }

  match = line.match(/waiting for user message via transport \{ sessionId: '([^']+)'/);
  if (match) return { kind: "frame", sessionId: match[1], event: "Stop", message: "waiting for your message" };

  match = line.match(/\[sessions-bridge\] Forwarded permission request \S+ \(([^)]+)\)/);
  if (match) return { kind: "waiting", tool: match[1] };

  match = line.match(/Received control_response for permission \S+: behavior=(allow|deny)/);
  if (match) return { kind: "resolved", behavior: match[1] as "allow" | "deny" };

  return null;
}

/** Tail the Claude desktop app's main.log and mirror its session lifecycle
 * into the agent-session registry (source "claude-app"). Starts at EOF so a
 * core restart never replays history; log rotation resets the offset. */
export class ClaudeAppLogWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private offset = -1;
  private remainder = "";
  private lastSessionId: string | null = null;
  private lastFrameAt = new Map<string, number>();
  private warned = false;

  constructor(
    private readonly registry: AgentSessionRegistry,
    private readonly logPath: string,
    private readonly pollMs = 2_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    try {
      const info = await stat(this.logPath);
      if (this.offset < 0 || info.size < this.offset) {
        // First poll (start at EOF) or the log rotated/truncated under us.
        this.offset = this.offset < 0 ? info.size : 0;
        this.remainder = "";
      }
      if (info.size > this.offset) await this.consume(info.size);
      this.sweepIdle();
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        warn(TAG, `claude-app log unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async consume(size: number): Promise<void> {
    // Cap each read so a huge burst can't monopolize the tick; the rest is
    // picked up next poll.
    const length = Math.min(size - this.offset, 512 * 1024);
    const handle = await open(this.logPath, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
      this.offset += bytesRead;
      const chunk = this.remainder + buffer.toString("utf8", 0, bytesRead);
      const lines = chunk.split("\n");
      this.remainder = lines.pop() ?? "";
      for (const line of lines) this.handleLine(line);
    } finally {
      await handle.close();
    }
  }

  private handleLine(line: string): void {
    const event = parseClaudeAppLine(line);
    if (!event) return;
    const now = Date.now();
    if (event.kind === "frame") {
      this.lastSessionId = event.sessionId;
      this.lastFrameAt.set(event.sessionId, now);
      const frame: AgentEventFrame = {
        session_id: event.sessionId,
        hook_event_name: event.event,
        source: "claude-app",
        ts: now,
        ...(event.message ? { message: event.message } : {}),
      };
      this.registry.handleEvent(frame);
    } else if (event.kind === "waiting" && this.lastSessionId) {
      this.lastFrameAt.set(this.lastSessionId, now);
      this.registry.markWaiting(this.lastSessionId, event.tool, now);
    } else if (event.kind === "resolved" && this.lastSessionId) {
      this.lastFrameAt.set(this.lastSessionId, now);
      this.registry.finishApproval(this.lastSessionId, event.behavior, "");
    }
  }

  /** The bridge logs nothing mid-turn, so "working" persists between user
   * message and query completion. If completion never arrives (app quit,
   * pattern drift), assume idle after a long silence. */
  private sweepIdle(): void {
    const cutoff = Date.now() - CLAUDE_APP_IDLE_MS;
    const stale = [...this.lastFrameAt].filter(([, at]) => at < cutoff);
    if (!stale.length) return;
    const sessions = new Map(this.registry.snapshot().map((s) => [s.sessionId, s]));
    for (const [sessionId] of stale) {
      this.lastFrameAt.delete(sessionId);
      const session = sessions.get(sessionId);
      if (!session || session.state === "done") continue;
      this.registry.handleEvent({
        session_id: sessionId,
        hook_event_name: "Stop",
        source: "claude-app",
        ts: Date.now(),
        message: "assumed idle (no bridge activity 30m)",
      });
    }
  }
}

/** Watch the ChatGPT app's conversation store for mtime changes. Content is
 * encrypted — mtimes are the only signal, which is exactly the privacy
 * boundary we want: presence and recency, never text. */
export class ChatGptConversationsWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private mtimes = new Map<string, number>();
  private active = new Map<string, number>();
  private baselined = false;
  private warned = false;

  constructor(
    private readonly registry: AgentSessionRegistry,
    private readonly dataDir: string,
    private readonly pollMs = 15_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    void this.poll();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    try {
      const now = Date.now();
      for (const [id, mtime] of await this.scan()) {
        const previous = this.mtimes.get(id);
        this.mtimes.set(id, mtime);
        // First scan only records a baseline — old conversations must not
        // surface as active on core startup.
        if (!this.baselined || previous === mtime) continue;
        this.active.set(id, now);
        this.registry.handleEvent({
          session_id: `chatgpt:${id}`,
          hook_event_name: "Notification",
          source: "chatgpt",
          ts: now,
          message: "conversation active",
        });
      }
      this.baselined = true;
      const cutoff = now - CHATGPT_IDLE_MS;
      for (const [id, lastActive] of this.active) {
        if (lastActive >= cutoff) continue;
        this.active.delete(id);
        this.registry.handleEvent({
          session_id: `chatgpt:${id}`,
          hook_event_name: "SessionEnd",
          source: "chatgpt",
          ts: now,
          message: "conversation idle",
        });
      }
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        warn(TAG, `chatgpt store unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async scan(): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const dirs = (await readdir(this.dataDir)).filter((name) => name.startsWith("conversations-v3-"));
    for (const dir of dirs) {
      for (const file of await readdir(join(this.dataDir, dir))) {
        if (!file.endsWith(".data")) continue;
        try {
          const info = await stat(join(this.dataDir, dir, file));
          result.set(file.slice(0, -".data".length), info.mtimeMs);
        } catch { /* conversation deleted mid-scan */ }
      }
    }
    return result;
  }
}

/** Facade owning both desktop-app watchers. */
export class AppSessionWatchers {
  private readonly watchers: Array<{ start(): void; stop(): void }>;

  constructor(registry: AgentSessionRegistry, config: AppSessionsConfig) {
    this.watchers = [
      new ClaudeAppLogWatcher(registry, config.claudeAppLogPath),
      new ChatGptConversationsWatcher(registry, config.chatgptDataDir),
    ];
  }

  start(): void {
    for (const watcher of this.watchers) watcher.start();
  }

  stop(): void {
    for (const watcher of this.watchers) watcher.stop();
  }
}
