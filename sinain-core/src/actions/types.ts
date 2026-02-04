import type { FeedItem, SenseEvent, AgentEntry, ContextWindow } from "../types.js";

export type ActionStatus = "pending" | "running" | "completed" | "failed";

export interface ActionProgress {
  pct: number | null;     // 0-100 or null if indeterminate
  message: string;        // one-liner for HUD
}

export interface ActionInfo {
  id: string;
  name: string;
  status: ActionStatus;
  startedAt: number;
  stoppedAt: number | null;
  progress: ActionProgress;
  meta: Record<string, unknown>;
}

export interface ActionContext {
  broadcast: (text: string) => void;   // push to overlay
  outputDir: string;                   // where to write files
}

export interface Action {
  readonly id: string;
  readonly name: string;
  readonly status: ActionStatus;
  readonly progress: ActionProgress;
  start(ctx: ActionContext): Promise<void>;
  stop(): Promise<string>;                      // returns summary
  onFeedItem(item: FeedItem): void;
  onSenseEvent(event: SenseEvent): void;
  onAgentTick?(entry: AgentEntry, ctx: ContextWindow): void;
  getInfo(): ActionInfo;
}

export type ActionFactory = (id: string, args: string[]) => Action;
export type ActionRegistry = Map<string, ActionFactory>;
