import { execFile } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentEventFrame, AppSessionsConfig } from "../types.js";
import type { AgentSessionRegistry } from "./registry.js";
import { debug, log, warn } from "../log.js";

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
        // Bare uuid as session id: the registry labels sessions from the id's
        // first 8 chars when there is no cwd, so a "chatgpt:" prefix would
        // render every conversation as "chatgpt — chatgpt:".
        this.registry.handleEvent({
          session_id: id,
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
          session_id: id,
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

const execFileAsync = promisify(execFile);

/** One poll's worth of traffic that counts as user activity. Idle background
 * noise measures well under 1KB per 15s; even a short message exchange
 * (POST + SSE stream) lands in the tens of KB. */
const CHATGPT_NET_ACTIVE_BYTES = 8 * 1024;

/** Transient nettop failures (timeouts under load) shouldn't kill the lane;
 * this many consecutive errors means it genuinely can't work here. */
const NETTOP_MAX_CONSECUTIVE_ERRORS = 5;

/** Detect active use of the current (Chromium-based) ChatGPT app via nettop
 * byte-counter deltas on its network-service process. The modern build keeps
 * conversation state server-side and flushes its profile lazily, so file
 * mtimes say nothing — network traffic is the only local, deterministic
 * signal. App-level granularity (one aggregate session), no content access. */
export class ChatGptAppNetworkWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private pid: number | null = null;
  private connBytes = new Map<string, number>();
  private baselined = false;
  private lastActiveAt = 0;
  private sessionActive = false;
  private errorStreak = 0;
  private unavailable = false;

  constructor(
    private readonly registry: AgentSessionRegistry,
    private readonly pollMs = 15_000,
    private readonly idleMs = CHATGPT_IDLE_MS,
  ) {}

  start(): void {
    if (this.timer || process.platform !== "darwin") return;
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    if (this.polling || this.unavailable) return;
    this.polling = true;
    try {
      const delta = await this.readDelta();
      this.errorStreak = 0;
      const now = Date.now();
      if (delta >= CHATGPT_NET_ACTIVE_BYTES) {
        if (!this.sessionActive) log(TAG, `chatgpt app active (${Math.round(delta / 1024)}KB in ${Math.round(this.pollMs / 1000)}s)`);
        this.lastActiveAt = now;
        this.sessionActive = true;
        // Aggregate id: nettop can't attribute traffic to a conversation.
        this.registry.handleEvent({
          session_id: "app",
          hook_event_name: "Notification",
          source: "chatgpt",
          ts: now,
          message: "app active",
        });
      } else if (this.sessionActive && now - this.lastActiveAt > this.idleMs) {
        log(TAG, "chatgpt app idle");
        this.sessionActive = false;
        this.registry.handleEvent({
          session_id: "app",
          hook_event_name: "SessionEnd",
          source: "chatgpt",
          ts: now,
          message: "app idle",
        });
      }
    } catch (err) {
      if (++this.errorStreak >= NETTOP_MAX_CONSECUTIVE_ERRORS) {
        this.unavailable = true;
        warn(TAG, `chatgpt nettop lane disabled: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      this.polling = false;
    }
  }

  /** Bytes transferred since the previous poll by the ChatGPT app's Chromium
   * network service. nettop's per-process totals cover only *live* sockets —
   * closing a connection silently drops its bytes from the sum, masking real
   * traffic — so track per-connection counters instead: a new connection
   * contributes its full count, a persisting one its positive delta. */
  private async readDelta(): Promise<number> {
    const pid = await this.resolvePid();
    if (pid === null) {
      this.connBytes.clear();
      this.baselined = false;
      return 0;
    }
    const { stdout } = await execFileAsync(
      "nettop",
      ["-x", "-L", "1", "-p", String(pid)],
      { timeout: 10_000 },
    );
    const next = new Map<string, number>();
    let delta = 0;
    for (const row of stdout.split("\n")) {
      // Connection row: time, "tcp4 a:p<->b:q", interface, state, bytes_in, bytes_out, …
      const cols = row.split(",");
      if (cols.length < 6 || !cols[1]?.includes("<->")) continue;
      const bytes = Number(cols[4]) + Number(cols[5]);
      if (!Number.isFinite(bytes)) continue;
      const tuple = cols[1];
      next.set(tuple, bytes);
      const previous = this.connBytes.get(tuple);
      delta += previous === undefined ? bytes : Math.max(0, bytes - previous);
    }
    this.connBytes = next;
    if (!this.baselined) {
      // First read after start/app-launch sees every connection as new;
      // don't count pre-existing traffic as activity.
      this.baselined = true;
      return 0;
    }
    if (delta > 0) debug(TAG, `chatgpt net delta ${delta}B across ${next.size} connections`);
    return delta;
  }

  private async resolvePid(): Promise<number | null> {
    if (this.pid !== null && await this.pidAlive(this.pid)) return this.pid;
    this.pid = null;
    try {
      const { stdout } = await execFileAsync(
        "pgrep",
        ["-f", "utility-sub-type=network.mojom.NetworkService"],
        { timeout: 5_000 },
      );
      for (const line of stdout.split("\n")) {
        const pid = Number(line.trim());
        if (!pid) continue;
        const { stdout: command } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], { timeout: 5_000 });
        // The profile path contains a space ("Application Support"), so match
        // the trailing /Codex segment (followed by the next --flag or EOL)
        // rather than trying to span the whole path without spaces.
        if (command.includes("--user-data-dir=") && /\/Codex(\s+--|\s*$)/.test(command)) {
          this.pid = pid;
          break;
        }
      }
    } catch { /* pgrep exits 1 when nothing matches — app not running */ }
    return this.pid;
  }

  private async pidAlive(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

/** Facade owning the desktop-app watchers. */
export class AppSessionWatchers {
  private readonly watchers: Array<{ start(): void; stop(): void }>;

  constructor(registry: AgentSessionRegistry, config: AppSessionsConfig) {
    this.watchers = [
      new ClaudeAppLogWatcher(registry, config.claudeAppLogPath),
      new ChatGptConversationsWatcher(registry, config.chatgptDataDir),
      new ChatGptAppNetworkWatcher(registry),
    ];
  }

  start(): void {
    for (const watcher of this.watchers) watcher.start();
  }

  stop(): void {
    for (const watcher of this.watchers) watcher.stop();
  }
}
