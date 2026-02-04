import type { WsHandler } from "../overlay/ws-handler.js";
import type { FeedItem, SenseEvent, AgentEntry, ContextWindow } from "../types.js";
import type { Action, ActionFactory, ActionContext } from "./types.js";
import { TranscribeAction } from "./transcribe.js";
import { log, warn, error } from "../log.js";

const TAG = "actions";

export interface ActionRunnerDeps {
  wsHandler: WsHandler;
  outputDir: string;
}

export class ActionRunner {
  private readonly registry = new Map<string, ActionFactory>();
  private readonly actions = new Map<string, Action>();
  private readonly deps: ActionRunnerDeps;
  private nextId = 1;

  constructor(deps: ActionRunnerDeps) {
    this.deps = deps;

    // Built-in actions
    this.register("transcribe", (id, args) => new TranscribeAction(id, args));

    log(TAG, `initialized (outputDir=${deps.outputDir})`);
  }

  register(name: string, factory: ActionFactory): void {
    this.registry.set(name, factory);
  }

  /**
   * Try to handle a slash command. Returns true if handled, false to fall through.
   *
   * Supported patterns:
   *   /transcribe [label...]     → start transcription
   *   /transcribe stop           → stop transcription
   *   /stop                      → stop all running actions
   *   /actions                   → list running actions
   */
  handleSlashCommand(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("/")) return false;

    const parts = trimmed.slice(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const rest = parts.slice(1);

    // /actions — list
    if (cmd === "actions") {
      this.listActions();
      return true;
    }

    // /stop — stop all
    if (cmd === "stop") {
      this.stopAll();
      return true;
    }

    // Check registry
    if (!this.registry.has(cmd)) return false;

    // /name stop — stop specific action
    if (rest.length > 0 && rest[0].toLowerCase() === "stop") {
      this.stopByName(cmd);
      return true;
    }

    // /name [args...] — start new action
    this.startAction(cmd, rest);
    return true;
  }

  onFeedItem(item: FeedItem): void {
    for (const action of this.actions.values()) {
      if (action.status !== "running") continue;
      try {
        action.onFeedItem(item);
      } catch (err) {
        warn(TAG, `onFeedItem error in ${action.name}[${action.id}]:`, err);
      }
    }
  }

  onSenseEvent(event: SenseEvent): void {
    for (const action of this.actions.values()) {
      if (action.status !== "running") continue;
      try {
        action.onSenseEvent(event);
      } catch (err) {
        warn(TAG, `onSenseEvent error in ${action.name}[${action.id}]:`, err);
      }
    }
  }

  onAgentTick(entry: AgentEntry, ctx: ContextWindow): void {
    for (const action of this.actions.values()) {
      if (action.status !== "running") continue;
      try {
        action.onAgentTick?.(entry, ctx);
      } catch (err) {
        warn(TAG, `onAgentTick error in ${action.name}[${action.id}]:`, err);
      }
    }
  }

  async destroy(): Promise<void> {
    if (this.actions.size === 0) return;
    log(TAG, `shutting down ${this.actions.size} action(s)...`);
    await this.stopAll();
  }

  // ── Private ──

  private async startAction(name: string, args: string[]): Promise<void> {
    // One instance per action name
    for (const action of this.actions.values()) {
      if (action.name === name && action.status === "running") {
        this.broadcast(`⚠ Action "${name}" is already running. Use /${name} stop to end it.`);
        return;
      }
    }

    const factory = this.registry.get(name);
    if (!factory) return;

    const id = `${name}-${this.nextId++}`;
    const action = factory(id, args);
    this.actions.set(id, action);

    const ctx: ActionContext = {
      broadcast: (text) => this.broadcast(text),
      outputDir: this.deps.outputDir,
    };

    try {
      await action.start(ctx);
      const label = args.length > 0 ? ` (${args.join(" ")})` : "";
      this.broadcast(`▶ Action "${name}" started${label}`);
      log(TAG, `started action ${id}`);
    } catch (err) {
      error(TAG, `failed to start action ${id}:`, err);
      this.actions.delete(id);
      this.broadcast(`✘ Failed to start "${name}": ${err instanceof Error ? err.message : err}`);
    }
  }

  private async stopByName(name: string): Promise<void> {
    let found = false;
    for (const [id, action] of this.actions) {
      if (action.name === name && action.status === "running") {
        found = true;
        await this.stopAction(id);
      }
    }
    if (!found) {
      this.broadcast(`No running "${name}" action to stop.`);
    }
  }

  private async stopAll(): Promise<void> {
    const running = [...this.actions.entries()].filter(([, a]) => a.status === "running");
    if (running.length === 0) {
      this.broadcast("No actions running.");
      return;
    }
    for (const [id] of running) {
      await this.stopAction(id);
    }
  }

  private async stopAction(id: string): Promise<void> {
    const action = this.actions.get(id);
    if (!action) return;

    try {
      const summary = await action.stop();
      this.broadcast(`■ ${summary}`);
      log(TAG, `stopped action ${id}`);
    } catch (err) {
      error(TAG, `error stopping action ${id}:`, err);
      this.broadcast(`✘ Error stopping "${action.name}": ${err instanceof Error ? err.message : err}`);
    }

    // Clean up completed actions
    this.actions.delete(id);
  }

  private listActions(): void {
    const running = [...this.actions.values()].filter((a) => a.status === "running");
    if (running.length === 0) {
      this.broadcast("No actions running.");
      return;
    }
    const lines = running.map((a) => {
      const info = a.getInfo();
      const elapsed = Math.round((Date.now() - info.startedAt) / 1000);
      return `• ${info.name} [${info.id}] — ${info.progress.message} (${elapsed}s)`;
    });
    this.broadcast(`Running actions:\n${lines.join("\n")}`);
  }

  private broadcast(text: string): void {
    this.deps.wsHandler.broadcast(text, "normal");
  }
}
