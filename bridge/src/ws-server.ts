import { WebSocketServer, WebSocket } from "ws";
import type {
  BridgeConfig,
  BridgeState,
  OutboundMessage,
  InboundMessage,
  FeedMessage,
  StatusMessage,
  Priority,
} from "./types.js";
import { log, warn, error } from "./log.js";

const TAG = "ws";
const HEARTBEAT_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 5_000;

type MessageHandler = (msg: InboundMessage, client: WebSocket) => void;

/**
 * WebSocket server for overlay connections.
 * Manages connected clients, heartbeat pings, and message routing.
 */
export class WsServer {
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private onMessage: MessageHandler | null = null;
  private port: number;
  private state: BridgeState = {
    audio: "active",
    screen: "active",
    connection: "disconnected",
  };
  private replayBuffer: FeedMessage[] = [];
  private static readonly MAX_REPLAY = 20;

  constructor(config: BridgeConfig) {
    this.port = config.wsPort;
  }

  /** Register handler for incoming overlay messages */
  onIncoming(handler: MessageHandler): void {
    this.onMessage = handler;
  }

  /** Start the WebSocket server */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.port, host: "127.0.0.1" });

      this.wss.on("listening", () => {
        log(TAG, `listening on ws://127.0.0.1:${this.port}`);
        this.startHeartbeat();
        resolve();
      });

      this.wss.on("error", (err) => {
        error(TAG, "server error:", err.message);
        reject(err);
      });

      this.wss.on("connection", (ws, req) => {
        const addr = req.socket.remoteAddress ?? "unknown";
        log(TAG, `client connected from ${addr}`);
        this.clients.add(ws);
        this.updateConnection("connected");

        // Mark as alive for heartbeat
        (ws as any).__alive = true;

        // Send current status on connect
        this.sendTo(ws, {
          type: "status",
          audio: this.state.audio,
          screen: this.state.screen,
          connection: this.state.connection,
        });

        // Replay recent feed messages so the client doesn't miss anything
        for (const msg of this.replayBuffer) {
          this.sendTo(ws, msg);
        }
        if (this.replayBuffer.length > 0) {
          log(TAG, `replayed ${this.replayBuffer.length} buffered messages to new client`);
        }

        ws.on("message", (raw) => {
          try {
            const data = JSON.parse(raw.toString()) as InboundMessage;
            this.handleMessage(data, ws);
          } catch (err) {
            warn(TAG, "bad message from client:", raw.toString().slice(0, 200));
          }
        });

        ws.on("pong", () => {
          (ws as any).__alive = true;
        });

        ws.on("close", (code, reason) => {
          log(TAG, `client disconnected: ${code} ${reason?.toString() ?? ""}`);
          this.clients.delete(ws);
          if (this.clients.size === 0) {
            this.updateConnection("disconnected");
          }
        });

        ws.on("error", (err) => {
          warn(TAG, "client error:", err.message);
          this.clients.delete(ws);
        });
      });
    });
  }

  /** Send a feed message to all connected overlays */
  broadcast(text: string, priority: Priority = "normal"): void {
    const msg: FeedMessage = {
      type: "feed",
      text,
      priority,
      ts: Date.now(),
    };
    // Buffer for replay to late-joining clients
    this.replayBuffer.push(msg);
    if (this.replayBuffer.length > WsServer.MAX_REPLAY) {
      this.replayBuffer.shift();
    }
    this.broadcastMessage(msg);
  }

  /** Send a status update to all connected overlays */
  broadcastStatus(): void {
    const msg: StatusMessage = {
      type: "status",
      audio: this.state.audio,
      screen: this.state.screen,
      connection: this.state.connection,
    };
    this.broadcastMessage(msg);
  }

  /** Update internal state and broadcast */
  updateState(partial: Partial<BridgeState>): void {
    Object.assign(this.state, partial);
    this.broadcastStatus();
  }

  /** Get current state */
  getState(): Readonly<BridgeState> {
    return { ...this.state };
  }

  /** Number of connected clients */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Graceful shutdown */
  async destroy(): Promise<void> {
    this.stopHeartbeat();
    // Close all clients
    for (const ws of this.clients) {
      ws.close(1001, "server shutting down");
    }
    this.clients.clear();

    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          log(TAG, "server closed");
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // ── Private ──

  private handleMessage(msg: InboundMessage, ws: WebSocket): void {
    switch (msg.type) {
      case "pong":
        (ws as any).__alive = true;
        log(TAG, "← app-level pong received");
        return;
      case "message":
        log(TAG, `← user message: ${msg.text.slice(0, 100)}`);
        break;
      case "command":
        log(TAG, `← command: ${msg.action}`);
        this.handleCommand(msg.action);
        break;
      default:
        warn(TAG, `unknown message type: ${(msg as any).type}`);
        return;
    }

    if (this.onMessage) {
      this.onMessage(msg, ws);
    }
  }

  private handleCommand(action: string): void {
    switch (action) {
      case "mute_audio":
        this.updateState({ audio: "muted" });
        log(TAG, "audio muted");
        break;
      case "unmute_audio":
        this.updateState({ audio: "active" });
        log(TAG, "audio unmuted");
        break;
      case "toggle_audio":
        this.updateState({
          audio: this.state.audio === "active" ? "muted" : "active",
        });
        log(TAG, `audio toggled → ${this.state.audio}`);
        break;
      case "screen_on":
        this.updateState({ screen: "active" });
        break;
      case "screen_off":
        this.updateState({ screen: "off" });
        break;
      case "toggle_screen":
        this.updateState({
          screen: this.state.screen === "active" ? "off" : "active",
        });
        log(TAG, `screen toggled → ${this.state.screen}`);
        break;
      case "switch_device":
        log(TAG, "switch_device command received");
        break;
      default:
        log(TAG, `unhandled command: ${action}`);
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

  private updateConnection(status: BridgeState["connection"]): void {
    this.state.connection = status;
    // Don't broadcast connection status recursively on disconnect
    if (this.clients.size > 0) {
      this.broadcastStatus();
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const ws of this.clients) {
        if ((ws as any).__alive === false) {
          log(TAG, "client failed heartbeat — closing (was silent for 2 cycles)");
          ws.close(4000, "heartbeat timeout");
          this.clients.delete(ws);
          if (this.clients.size === 0) {
            this.updateConnection("disconnected");
          }
          continue;
        }
        (ws as any).__alive = false;
        ws.ping();

        // Also send app-level ping (Flutter may not auto-handle protocol pings)
        this.sendTo(ws, { type: "ping", ts: Date.now() } as any);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
