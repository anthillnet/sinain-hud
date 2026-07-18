import { basename } from "node:path";
import type { AgentEventFrame, AgentSession } from "../types.js";

const DONE_TTL_MS = 60 * 60 * 1000;

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

export function shortAgentInput(input: unknown, max = 120): string {
  if (typeof input === "string") return truncate(input, max);
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["command", "file_path", "path", "query", "url"]) {
      if (typeof record[key] === "string") return truncate(record[key], max);
    }
  }
  if (input === undefined || input === null) return "";
  try {
    return truncate(JSON.stringify(input), max);
  } catch {
    return truncate(String(input), max);
  }
}

export class AgentSessionRegistry {
  private sessions = new Map<string, AgentSession>();
  private changeCb: (() => void) | null = null;

  onChange(cb: () => void): void {
    this.changeCb = cb;
  }

  handleEvent(frame: AgentEventFrame): AgentSession {
    const now = frame.ts ?? Date.now();
    let session = this.sessions.get(frame.session_id);
    if (!session) {
      const source = frame.source || "agent";
      session = {
        sessionId: frame.session_id,
        source,
        name: `${source} — ${frame.cwd ? basename(frame.cwd) : frame.session_id.slice(0, 8)}`,
        ...(frame.cwd ? { cwd: frame.cwd } : {}),
        ...(frame.model ? { model: frame.model } : {}),
        ...(frame.branch ? { branch: frame.branch } : {}),
        ...(frame.term ? { term: frame.term } : {}),
        state: "working",
        toolLine: "",
        startedAt: now,
        lastEventAt: now,
      };
      this.sessions.set(frame.session_id, session);
    }

    session.lastEventAt = now;
    if (frame.cwd) session.cwd = frame.cwd;
    if (frame.model) session.model = frame.model;
    if (frame.branch) session.branch = frame.branch;
    if (frame.term) session.term = frame.term;
    session.name = `${session.source} — ${session.cwd ? basename(session.cwd) : session.sessionId.slice(0, 8)}`;

    switch (frame.hook_event_name) {
      case "SessionStart":
        session.state = "working";
        delete session.endedAt;
        break;
      case "UserPromptSubmit":
        session.toolLine = `prompt · ${truncate(frame.prompt ?? frame.message ?? "", 80)}`;
        session.state = "working";
        break;
      case "PreToolUse":
      case "PostToolUse": {
        const detail = shortAgentInput(frame.tool_input);
        session.toolLine = `${frame.tool_name ?? "tool"}${detail ? ` · ${detail}` : ""}`;
        session.state = "working";
        break;
      }
      case "Notification":
        if (frame.message) session.toolLine = truncate(frame.message, 120);
        break;
      case "Stop":
      case "StopFailure":
      case "SessionEnd": {
        session.state = "done";
        session.endedAt = now;
        const summary = frame.message || frame.prompt || session.toolLine;
        if (summary) session.summary = frame.hook_event_name === "StopFailure" ? `failed: ${summary}` : summary;
        break;
      }
    }
    this.changeCb?.();
    return session;
  }

  markWaiting(sessionId: string, command: string, ts = Date.now()): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.state = "waiting";
    session.toolLine = `PermissionRequest${command ? ` · ${truncate(command, 120)}` : ""}`;
    session.lastEventAt = ts;
    this.changeCb?.();
  }

  finishApproval(sessionId: string, behavior: "allow" | "deny" | "always" | "ask", command: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === "done") return;
    session.state = "working";
    session.lastEventAt = Date.now();
    if (behavior === "deny") session.toolLine = `denied${command ? ` · ${truncate(command, 120)}` : ""}`;
    this.changeCb?.();
  }

  setThread(sessionId: string, threadId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.threadId === threadId) return;
    session.threadId = threadId;
    this.changeCb?.();
  }

  detachThread(threadId: string): void {
    let changed = false;
    for (const session of this.sessions.values()) {
      if (session.threadId === threadId && session.state !== "done") {
        delete session.threadId;
        changed = true;
      }
    }
    if (changed) this.changeCb?.();
  }

  snapshot(): AgentSession[] {
    const cutoff = Date.now() - DONE_TTL_MS;
    for (const [id, session] of this.sessions) {
      if (session.state === "done" && (session.endedAt ?? session.lastEventAt) < cutoff) this.sessions.delete(id);
    }
    const rank = { waiting: 0, working: 1, done: 2 } as const;
    return [...this.sessions.values()]
      .sort((a, b) => rank[a.state] - rank[b.state] || b.lastEventAt - a.lastEventAt)
      .map((session) => ({
        ...session,
        ...(session.term ? { term: { ...session.term } } : {}),
      }));
  }

  counts(): { working: number; waiting: number } {
    let working = 0;
    let waiting = 0;
    for (const session of this.snapshot()) {
      if (session.state === "working") working++;
      else if (session.state === "waiting") waiting++;
    }
    return { working, waiting };
  }
}
