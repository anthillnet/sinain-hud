import type { AgentApprovalRequest, AgentEventFrame, ApprovalDecision } from "../types.js";
import { shortAgentInput } from "./registry.js";

interface PendingApproval {
  request: AgentApprovalRequest;
  timer: ReturnType<typeof setTimeout>;
  resolve: (decision: ApprovalDecision) => void;
}

export class ApprovalManager {
  private nextId = 1;
  private approvals = new Map<string, PendingApproval>();
  private onTimeout: ((request: AgentApprovalRequest) => void) | null;

  constructor(onTimeout?: (request: AgentApprovalRequest) => void) {
    this.onTimeout = onTimeout ?? null;
  }

  create(frame: AgentEventFrame, timeoutMs: number): { id: string; promise: Promise<ApprovalDecision> } {
    const id = `apr_${this.nextId++}`;
    const command = shortAgentInput(frame.tool_input) || frame.message || frame.prompt || "";
    const request: AgentApprovalRequest = {
      id,
      sessionId: frame.session_id,
      source: frame.source,
      title: `${frame.source} wants to run ${frame.tool_name ?? "a command"}`,
      command,
      ...(frame.cwd ? { cwd: frame.cwd } : {}),
      createdAt: Date.now(),
    };
    let resolvePromise!: (decision: ApprovalDecision) => void;
    const promise = new Promise<ApprovalDecision>((resolve) => { resolvePromise = resolve; });
    const timer = setTimeout(() => {
      const pending = this.approvals.get(id);
      if (!pending) return;
      this.approvals.delete(id);
      pending.resolve({ behavior: "ask" });
      this.onTimeout?.(pending.request);
    }, timeoutMs);
    this.approvals.set(id, { request, timer, resolve: resolvePromise });
    return { id, promise };
  }

  resolve(id: string, behavior: "allow" | "deny" | "always"): boolean {
    return this.settle(id, behavior);
  }

  cancel(id: string): boolean {
    return this.settle(id, "ask");
  }

  get(id: string): AgentApprovalRequest | undefined {
    return this.approvals.get(id)?.request;
  }

  pending(): AgentApprovalRequest[] {
    return [...this.approvals.values()].map((entry) => entry.request);
  }

  private settle(id: string, behavior: ApprovalDecision["behavior"]): boolean {
    const pending = this.approvals.get(id);
    if (!pending) return false;
    this.approvals.delete(id);
    clearTimeout(pending.timer);
    pending.resolve({ behavior });
    return true;
  }
}
