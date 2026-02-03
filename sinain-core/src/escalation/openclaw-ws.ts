import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { OpenClawConfig } from "../types.js";
import { log, warn, error } from "../log.js";

const TAG = "openclaw";

interface PendingRpc {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout: ReturnType<typeof setTimeout>;
  expectFinal: boolean;
}

/**
 * Persistent WebSocket client to OpenClaw gateway.
 * Ported from relay with added circuit breaker and exponential backoff.
 *
 * Protocol:
 *   1. Server sends connect.challenge → client responds with connect + auth token
 *   2. Client sends 'agent' RPC → server responds with two-frame protocol (accepted + final)
 *   3. Client extracts text from payload.result.payloads[].text
 */
export class OpenClawWsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private authenticated = false;
  private rpcId = 1;
  private pending = new Map<string, PendingRpc>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Exponential backoff
  private reconnectDelay = 1000;
  private maxReconnectDelay = 60000;

  // Circuit breaker
  private consecutiveFailures = 0;
  private circuitOpen = false;
  private circuitResetTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly CIRCUIT_THRESHOLD = 5;
  private static readonly CIRCUIT_RESET_MS = 5 * 60 * 1000; // 5 minutes

  constructor(private config: OpenClawConfig) {
    super();
  }

  /** Connect to the OpenClaw gateway. */
  connect(): void {
    if (!this.config.gatewayToken && !this.config.hookUrl) return;
    if (this.ws) return;
    if (this.circuitOpen) {
      log(TAG, "circuit breaker open \u2014 skipping connect");
      return;
    }

    try {
      const wsUrl = this.config.gatewayWsUrl;
      this.ws = new WebSocket(wsUrl);
      this.authenticated = false;

      this.ws.on("open", () => {
        log(TAG, `ws connected: ${wsUrl} (awaiting challenge)`);
        this.reconnectDelay = 1000; // Reset backoff on successful connect
        this.consecutiveFailures = 0;
      });

      this.ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
          this.handleMessage(msg);
        } catch (err: any) {
          error(TAG, "ws message handler error:", err);
        }
      });

      this.ws.on("close", () => {
        log(TAG, "gateway disconnected");
        this.cleanup();
        this.scheduleReconnect();
      });

      this.ws.on("error", (err) => {
        error(TAG, "ws error:", err.message || "connection failed");
      });
    } catch (err: any) {
      error(TAG, "connect failed:", err.message);
      this.ws = null;
    }
  }

  /** Send an agent RPC call. Returns the response payload. */
  async sendAgentRpc(
    message: string,
    idemKey: string,
    sessionKey: string,
  ): Promise<any> {
    return this.sendRpc("agent", {
      message,
      idempotencyKey: idemKey,
      sessionKey,
      deliver: false,
    }, 120000, { expectFinal: true });
  }

  /** Check if connected and authenticated. */
  get isConnected(): boolean {
    return !!(this.ws && this.ws.readyState === WebSocket.OPEN && this.authenticated);
  }

  /** Graceful disconnect. */
  disconnect(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.circuitResetTimer) { clearTimeout(this.circuitResetTimer); this.circuitResetTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    this.authenticated = false;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("disconnected"));
    }
    this.pending.clear();
  }

  // ── Private ──

  private handleMessage(msg: any): void {
    // Handle connect.challenge
    if (msg.type === "event" && msg.event === "connect.challenge") {
      log(TAG, "received challenge, authenticating...");
      this.ws?.send(JSON.stringify({
        type: "req",
        id: "connect-1",
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: "gateway-client",
            displayName: "Sinain Core",
            version: "1.0.0",
            platform: process.platform,
            mode: "backend",
          },
          auth: { token: this.config.gatewayToken },
        },
      }));
      return;
    }

    // Handle connect response
    if (msg.type === "res" && msg.id === "connect-1") {
      if (msg.ok) {
        this.authenticated = true;
        log(TAG, "gateway authenticated");
        this.emit("connected");
      } else {
        error(TAG, "auth failed:", msg.error || msg.payload?.error || "unknown");
        this.ws?.close();
      }
      return;
    }

    // Handle RPC responses
    const msgId = msg.id != null ? String(msg.id) : null;
    if (msg.type === "res" && msgId && this.pending.has(msgId)) {
      const pending = this.pending.get(msgId)!;
      // Skip intermediate "accepted" frame when expecting final
      if (pending.expectFinal && msg.payload?.status === "accepted") {
        log(TAG, `rpc ${msgId}: accepted (waiting for final)`);
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(msgId);
      pending.resolve(msg);
    }
  }

  private sendRpc(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 90000,
    opts: { expectFinal?: boolean } = {},
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated) {
        reject(new Error("gateway not connected or not authenticated"));
        return;
      }

      const id = String(this.rpcId++);
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        this.onRpcFailure();
        reject(new Error(`rpc timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => { this.consecutiveFailures = 0; resolve(value); },
        reject: (reason) => { this.onRpcFailure(); reject(reason); },
        timeout,
        expectFinal: !!opts.expectFinal,
      });

      this.ws.send(JSON.stringify({ type: "req", method, id, params }));
    });
  }

  private cleanup(): void {
    this.ws = null;
    this.authenticated = false;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("gateway disconnected"));
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    log(TAG, `reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private onRpcFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= OpenClawWsClient.CIRCUIT_THRESHOLD && !this.circuitOpen) {
      this.circuitOpen = true;
      warn(TAG, `circuit breaker opened after ${this.consecutiveFailures} failures \u2014 pausing for 5 min`);
      this.circuitResetTimer = setTimeout(() => {
        this.circuitOpen = false;
        this.consecutiveFailures = 0;
        log(TAG, "circuit breaker reset \u2014 resuming");
        this.connect();
      }, OpenClawWsClient.CIRCUIT_RESET_MS);
    }
  }
}
