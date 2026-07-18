import { basename } from "node:path";
import type { AgentSession } from "../types.js";
import type { AgentSessionRegistry } from "./registry.js";

export interface ActiveSession {
  id: string;
  threadId: string;
  label: string;
  startTs: number;
  paused: boolean;
}

export class AttachmentCoordinator {
  private detached = new Map<string, Set<string>>();
  private countByThread = new Map<string, number>();

  constructor(
    private registry: AgentSessionRegistry,
    private getActiveSessions: () => ActiveSession[],
    private onCountsChanged: (threadId: string) => void,
  ) {}

  sync(): void {
    const sessions = this.registry.snapshot();
    for (const session of sessions) {
      if (session.state === "done") {
        for (const ids of this.detached.values()) ids.delete(session.sessionId);
        continue;
      }
      if (session.threadId) continue;

      const candidates = this.getActiveSessions().filter(
        (active) => active.startTs <= session.startedAt
          && !this.detached.get(active.threadId)?.has(session.sessionId),
      );
      let match: ActiveSession | undefined;
      if (candidates.length === 1) {
        match = candidates[0];
      } else if (candidates.length > 1 && session.cwd) {
        const project = basename(session.cwd).toLowerCase();
        if (project) {
          const matching = candidates.filter((active) =>
            active.label.toLowerCase().includes(project)
              || active.threadId.toLowerCase().includes(project));
          if (matching.length === 1) match = matching[0];
        }
      }
      if (match) this.registry.setThread(session.sessionId, match.threadId);
    }

    this.notifyCountChanges();
    // Orphan agent sessions deliberately do not seed Session Sense candidates.
  }

  augmentsFor(threadId: string): { working: number; receipts: string[] } {
    const attached = this.registry.snapshot().filter((session) => session.threadId === threadId);
    const working = attached.filter((session) => session.state === "working" || session.state === "waiting").length;
    const receipts = attached
      .filter((session) => session.state === "done")
      .sort((a, b) => a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId))
      .map((session) => this.receiptFor(session));
    return { working, receipts };
  }

  onWrap(threadId: string): void {
    const liveIds = this.registry.snapshot()
      .filter((session) => session.threadId === threadId && session.state !== "done")
      .map((session) => session.sessionId);
    if (liveIds.length) {
      const ids = this.detached.get(threadId) ?? new Set<string>();
      for (const id of liveIds) ids.add(id);
      this.detached.set(threadId, ids);
    }
    this.registry.detachThread(threadId);
    this.notifyCountChanges();
  }

  private receiptFor(session: AgentSession): string {
    const end = session.endedAt ?? session.lastEventAt;
    const minutes = Math.max(1, Math.ceil(Math.max(0, end - session.startedAt) / 60_000));
    return `agent: ${session.name} — ${session.summary ?? session.toolLine} (${minutes}m)`;
  }

  private notifyCountChanges(): void {
    const next = new Map<string, number>();
    for (const session of this.registry.snapshot()) {
      if (session.threadId && (session.state === "working" || session.state === "waiting")) {
        next.set(session.threadId, (next.get(session.threadId) ?? 0) + 1);
      }
    }
    const threadIds = new Set([...this.countByThread.keys(), ...next.keys()]);
    for (const threadId of threadIds) {
      if ((this.countByThread.get(threadId) ?? 0) !== (next.get(threadId) ?? 0)) {
        this.onCountsChanged(threadId);
      }
    }
    this.countByThread = next;
  }
}
