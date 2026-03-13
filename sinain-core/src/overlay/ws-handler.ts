import { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type {
  BridgeState,
  OutboundMessage,
  InboundMessage,
  FeedMessage,
  StatusMessage,
  SpawnTaskMessage,
  Priority,
  FeedChannel,
} from "../types.js";
import { log, warn } from "../log.js";

const TAG = "ws";
const HEARTBEAT_INTERVAL_MS = 10_000;
const SPAWN_TASK_PRUNE_INTERVAL_MS = 60_000; // background pruning every 60s
const MAX_REPLAY = 20;
const SPAWN_TASK_TTL_MS = 120_000; // prune terminal tasks after 120s

type MessageHandler = (msg: InboundMessage, client: WebSocket) => void;
type ProfilingHandler = (msg: any) => void;
type HudEngagementHandler = (action: "copy" | "scroll" | "dismissed", ts: number) => void;

/**
 * WebSocket handler for overlay connections.
 * Manages connected clients, heartbeat pings, replay buffer, and message routing.
 * Ported from bridge/ws-server.ts — now runs on the same port as HTTP via the shared http.Server.
 */
export class WsHandler {
  private clients: Set<WebSocket> = new Set();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private spawnTaskPruneTimer: ReturnType<typeof setInterval> | null = null;
  private onMessage: MessageHandler | null = null;
  private onProfilingCb: ProfilingHandler | null = null;
  private onHudEngagementCb: HudEngagementHandler | null = null;
  private state: BridgeState = {
    audio: "muted",
    mic: "muted",
    screen: "off",
    connection: "disconnected",
  };
  private replayBuffer: FeedMessage[] = [];
  private spawnTaskBuffer: Map<string, SpawnTaskMessage> = new Map();

  // Total connection/disconnection counters for diagnostics
  private totalConnects = 0;
  private totalDisconnects = 0;

  constructor() {
    this.startHeartbeat();
    this.startSpawnTaskPruner();
  }

  /** Register handler for incoming overlay messages. */
  onIncoming(handler: MessageHandler): void {
    this.onMessage = handler;
  }

  /** Register handler for profiling messages from overlay. */
  onProfiling(handler: ProfilingHandler): void {
    this.onProfilingCb = handler;
  }

  /** Register handler for HUD engagement events from overlay. */
  onHudEngagement(handler: HudEngagementHandler): void {
    this.onHudEngagementCb = handler;
  }

  /** Handle a new WS connection (called from server.ts wss.on('connection')). */
  handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const addr = req.socket.remoteAddress ?? "unknown";
    this.totalConnects++;
    log(TAG, `client connected from ${addr} (total=${this.totalConnects}, active=${this.clients.size + 1})`);
    this.clients.add(ws);
    this.updateConnection("connected");

    (ws as any).__alive = true;
    (ws as any).__connectedAt = Date.now();

    // Send current status immediately on connect
    this.sendTo(ws, {
      type: "status",
      audio: this.state.audio,
      mic: this.state.mic,
      screen: this.state.screen,
      connection: this.state.connection,
    });

    // Replay recent feed messages for late-joining clients
    const replayStart = Date.now();
    for (const msg of this.replayBuffer) {
      this.sendTo(ws, msg);
    }
    if (this.replayBuffer.length > 0) {
      log(TAG, `replayed ${this.replayBuffer.length} feed messages in ${Date.now() - replayStart}ms`);
    }

    // Replay active spawn tasks (prune stale ones first)
    const beforePrune = this.spawnTaskBuffer.size;
    this.pruneSpawnTasks();
    const pruned = beforePrune - this.spawnTaskBuffer.size;
    if (pruned > 0) {
      log(TAG, `pruned ${pruned} expired spawn tasks before replay`);
    }
    for (const msg of this.spawnTaskBuffer.values()) {
      this.sendTo(ws, msg);
    }
    if (this.spawnTaskBuffer.size > 0) {
      log(TAG, `replayed ${this.spawnTaskBuffer.size} active spawn task(s)`);
    }

    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString()) as InboundMessage;
        this.handleIncoming(data, ws);
      } catch {
        warn(TAG, "bad message from client:", raw.toString().slice(0, 200));
      }
    });

    ws.on("pong", () => {
      (ws as any).__alive = true;
    });

    ws.on("close", (code, reason) => {
      const connectedFor = Date.now() - ((ws as any).__connectedAt ?? Date.now());
      const reasonStr = reason?.toString() || "";
      this.totalDisconnects++;
      log(TAG, `client disconnected from ${addr}: code=${code}${reasonStr ? ` reason="${reasonStr}"` : ""} uptime=${Math.round(connectedFor / 1000)}s (total disconnects=${this.totalDisconnects}, remaining=${this.clients.size - 1})`);
      this.clients.delete(ws);
      ws.removeAllListeners();
      if (this.clients.size === 0) {
        log(TAG, "no clients remaining — marking connection=disconnected");
        this.updateConnection("disconnected");
      }
    });

    ws.on("error", (err) => {
      warn(TAG, `client error from ${addr}: ${err.message}`);
      this.clients.delete(ws);
      ws.removeAllListeners();
    });
  }

  /** Broadcast a feed message to all connected overlays. */
  broadcast(text: string, priority: Priority = "normal", channel: FeedChannel = "stream"): void {
    const msg: FeedMessage = {
      type: "feed",
      text,
      priority,
      ts: Date.now(),
      channel,
    };
    this.replayBuffer.push(msg);
    if (this.replayBuffer.length > MAX_REPLAY) {
      this.replayBuffer.shift();
    }
    this.broadcastMessage(msg);
  }

  /** Send a status update to all connected overlays. */
  broadcastStatus(): void {
    const msg: StatusMessage = {
      type: "status",
      audio: this.state.audio,
      mic: this.state.mic,
      screen: this.state.screen,
      connection: this.state.connection,
    };
    this.broadcastMessage(msg);
  }

  /** Broadcast any outbound message (used by escalator for spawn_task events). */
  broadcastRaw(msg: OutboundMessage): void {
    if (msg.type === "spawn_task") {
      const taskMsg = msg as SpawnTaskMessage;
      this.spawnTaskBuffer.set(taskMsg.taskId, taskMsg);
      this.pruneSpawnTasks();
      log(TAG, `spawn_task buffered: taskId=${taskMsg.taskId}, status=${taskMsg.status}, buffer=${this.spawnTaskBuffer.size}, clients=${this.clients.size}`);
    }
    this.broadcastMessage(msg);
  }

  /** Update internal state and broadcast. */
  updateState(partial: Partial<BridgeState>): void {
    Object.assign(this.state, partial);
    this.broadcastStatus();
  }

  /** Get current state. */
  getState(): Readonly<BridgeState> {
    return { ...this.state };
  }

  /** Number of connected clients. */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Graceful shutdown. */
  destroy(): void {
    log(TAG, `destroy: closing ${this.clients.size} client(s)`);
    this.stopHeartbeat();
    this.stopSpawnTaskPruner();
    for (const ws of this.clients) {
      ws.close(1001, "server shutting down");
    }
    this.clients.clear();
  }

  // ── Private ──

  private handleIncoming(msg: InboundMessage, ws: WebSocket): void {
    switch (msg.type) {
      case "pong":
        (ws as any).__alive = true;
        return;
      case "message":
        log(TAG, `\u2190 user message: ${msg.text.slice(0, 100)}`);
        break;
      case "command":
        log(TAG, `\u2190 command: ${msg.action}`);
        break;
      case "profiling":
        if (this.onProfilingCb) this.onProfilingCb(msg);
        return;
      case "hud_engagement": {
        const em = msg as import("../types.js").HudEngagementMessage;
        const action = em.action;
        if (["copy", "scroll", "dismissed"].includes(action)) {
          log(TAG, `← hud_engagement action=${action}`);
          if (this.onHudEngagementCb) this.onHudEngagementCb(action, em.ts ?? Date.now());
        }
        return;
      }
      default:
        warn(TAG, `unknown message type: ${(msg as any).type}`);
        return;
    }
    if (this.onMessage) {
      this.onMessage(msg, ws);
    }
  }

  private sendTo(ws: WebSocket, msg: OutboundMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private broadcastMessage(msg: OutboundMessage): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  private pruneSpawnTasks(): void {
    const now = Date.now();
    const terminal = new Set(["completed", "failed", "timeout"]);
    for (const [id, msg] of this.spawnTaskBuffer) {
      if (terminal.has(msg.status) && msg.completedAt && now - msg.completedAt > SPAWN_TASK_TTL_MS) {
        this.spawnTaskBuffer.delete(id);
      }
    }
  }

  private updateConnection(status: BridgeState["connection"]): void {
    this.state.connection = status;
    if (this.clients.size > 0) {
      this.broadcastStatus();
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const ws of this.clients) {
        if ((ws as any).__alive === false) {
          const addr = (ws as any).__addr ?? "unknown";
          const connectedFor = Date.now() - ((ws as any).__connectedAt ?? Date.now());
          log(TAG, `heartbeat: client ${addr} missed pong after ${Math.round(connectedFor / 1000)}s — closing (code=4000)`);
          ws.close(4000, "heartbeat timeout");
          this.clients.delete(ws);
          if (this.clients.size === 0) {
            this.updateConnection("disconnected");
          }
          continue;
        }
        (ws as any).__alive = false;
        ws.ping();
        // App-level ping for Flutter clients that don't handle protocol pings
        this.sendTo(ws, { type: "ping", ts: Date.now() });
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Background timer that prunes expired spawn tasks regardless of client activity. */
  private startSpawnTaskPruner(): void {
    this.spawnTaskPruneTimer = setInterval(() => {
      const before = this.spawnTaskBuffer.size;
      this.pruneSpawnTasks();
      const pruned = before - this.spawnTaskBuffer.size;
      if (pruned > 0) {
        log(TAG, `spawn task pruner: removed ${pruned} expired task(s), ${this.spawnTaskBuffer.size} remaining`);
      }
    }, SPAWN_TASK_PRUNE_INTERVAL_MS);
  }

  private stopSpawnTaskPruner(): void {
    if (this.spawnTaskPruneTimer) {
      clearInterval(this.spawnTaskPruneTimer);
      this.spawnTaskPruneTimer = null;
    }
  }
}
