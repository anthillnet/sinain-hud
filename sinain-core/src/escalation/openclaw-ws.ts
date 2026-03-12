import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { OpenClawConfig } from "../types.js";
import { log, warn, error } from "../log.js";

const TAG = "openclaw";

interface PendingRpc {
  method: string;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout: ReturnType<typeof setTimeout>;
  expectFinal: boolean;
  sentAt: number;
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
  private stopped = false;

  // Exponential backoff
  private reconnectDelay = 1000;
  private maxReconnectDelay = 60000;

  // Circuit breaker (time-window based)
  private recentFailures: number[] = [];  // timestamps of recent failures
  private circuitOpen = false;
  private circuitResetTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly CIRCUIT_THRESHOLD = 5;
  private static readonly CIRCUIT_WINDOW_MS = 2 * 60 * 1000; // 2-minute sliding window
  private circuitResetDelay = 300_000;       // starts at 5 min, doubles on each trip
  private readonly MAX_CIRCUIT_RESET = 1_800_000;  // caps at 30 min

  // Connection attempt counter for diagnostics
  private connectAttempts = 0;
  private connectedAt: number | null = null;

  constructor(private config: OpenClawConfig) {
    super();
  }

  /** Connect to the OpenClaw gateway. */
  connect(): void {
    if (!this.config.gatewayToken && !this.config.hookUrl) {
      log(TAG, "connect: no gateway token or hookUrl — skipping");
      return;
    }
    if (this.stopped) {
      log(TAG, "connect: stopped — skipping");
      return;
    }
    if (this.circuitOpen) {
      log(TAG, "connect: circuit breaker open — skipping");
      return;
    }

    // If a ws instance exists but is in a non-usable state, terminate it cleanly
    // before creating a new one. This prevents the circuit-reset path from being
    // blocked by a stale CLOSING/CLOSED socket that hasn't triggered cleanup yet.
    if (this.ws) {
      const state = this.ws.readyState;
      if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
        log(TAG, `connect: already ${state === WebSocket.OPEN ? "open" : "connecting"} — skipping`);
        return;
      }
      log(TAG, `connect: terminating stale socket (readyState=${state})`);
      try { this.ws.terminate(); } catch {}
      this.ws = null;
      this.authenticated = false;
    }

    this.connectAttempts++;
    const wsUrl = this.config.gatewayWsUrl;
    log(TAG, `connect: attempt #${this.connectAttempts} → ${wsUrl}`);

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        log(TAG, `ws open (attempt #${this.connectAttempts}), awaiting challenge...`);
      });

      this.ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
          this.handleMessage(msg);
        } catch (err: any) {
          error(TAG, "ws message parse error:", err.message);
        }
      });

      this.ws.on("close", (code, reason) => {
        const reasonStr = reason?.toString() || "";
        const uptime = this.connectedAt ? `${Math.round((Date.now() - this.connectedAt) / 1000)}s uptime` : "never authenticated";
        log(TAG, `ws closed: code=${code}${reasonStr ? ` reason="${reasonStr}"` : ""} (${uptime})`);
        this.connectedAt = null;
        this.cleanup("ws closed");
        this.scheduleReconnect();
      });

      this.ws.on("error", (err) => {
        // error event always precedes close; log it but let close handler drive cleanup
        error(TAG, `ws error: ${err.message}`);
      });
    } catch (err: any) {
      error(TAG, `connect: instantiation failed: ${err.message}`);
      this.ws = null;
    }
  }

  /** Send an agent RPC call. Returns the response payload. */
  async sendAgentRpc(
    message: string,
    idemKey: string,
    sessionKey: string,
  ): Promise<any> {
    if (this.circuitOpen) {
      warn(TAG, "sendAgentRpc: circuit breaker open — skipping");
      return null;
    }
    log(TAG, `sendAgentRpc: session=${sessionKey} idemKey=${idemKey} msgLen=${message.length}`);
    const result = await this.sendRpc("agent", {
      message,
      idempotencyKey: idemKey,
      sessionKey,
      deliver: false,
    }, 120000, { expectFinal: true });
    if (result?.ok) {
      this.circuitResetDelay = 300_000; // reset backoff on success
    }
    return result;
  }

  /** Check if connected and authenticated. */
  get isConnected(): boolean {
    return !!(this.ws && this.ws.readyState === WebSocket.OPEN && this.authenticated);
  }

  /** Check if the circuit breaker is currently open. */
  get isCircuitOpen(): boolean {
    return this.circuitOpen;
  }

  /** Graceful disconnect — does not schedule reconnect. */
  disconnect(): void {
    log(TAG, `disconnect: stopping (pending=${this.pending.size})`);
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.circuitResetTimer) { clearTimeout(this.circuitResetTimer); this.circuitResetTimer = null; }
    if (this.ws) { try { this.ws.close(1000, "graceful shutdown"); } catch {} this.ws = null; }
    this.authenticated = false;
    this.connectedAt = null;
    this.rejectAllPending("disconnected");
  }

  // ── Private ──

  private handleMessage(msg: any): void {
    // Handle connect.challenge
    if (msg.type === "event" && msg.event === "connect.challenge") {
      log(TAG, "received connect.challenge — sending auth");
      this.ws?.send(JSON.stringify({
        type: "req",
        id: "connect-1",
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          role: "operator",
          scopes: ["operator.read", "operator.write", "operator.admin"],
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
        this.connectedAt = Date.now();
        this.reconnectDelay = 1000; // Reset backoff on successful auth
        log(TAG, `authenticated ✓ (attempt #${this.connectAttempts}, reconnectDelay reset to 1s)`);
        this.emit("connected");
      } else {
        const errInfo = msg.error || msg.payload?.error || "unknown";
        const authReason = msg.error?.details?.authReason
          || msg.payload?.error?.details?.authReason;
        error(TAG, `auth failed: ${JSON.stringify(errInfo)}`);

        // Permanent auth errors — don't retry, token won't fix itself
        if (authReason === "token_mismatch") {
          error(TAG, "permanent auth failure (token_mismatch) — stopping. Check OPENCLAW_GATEWAY_TOKEN.");
          this.disconnect();
          return;
        }

        log(TAG, "auth failed (transient) — closing to trigger reconnect");
        this.ws?.close();
      }
      return;
    }

    // Handle RPC responses
    const msgId = msg.id != null ? String(msg.id) : null;
    if (msg.type === "res" && msgId && this.pending.has(msgId)) {
      const pending = this.pending.get(msgId)!;
      const elapsed = Date.now() - pending.sentAt;

      // Skip intermediate "accepted" frame when expecting final
      if (pending.expectFinal && msg.payload?.status === "accepted") {
        log(TAG, `rpc ${msgId} (${pending.method}): accepted after ${elapsed}ms, waiting for final`);
        return;
      }

      clearTimeout(pending.timeout);
      this.pending.delete(msgId);

      if (msg.ok) {
        log(TAG, `rpc ${msgId} (${pending.method}): ok in ${elapsed}ms, status=${msg.payload?.status ?? "n/a"}`);
      } else {
        warn(TAG, `rpc ${msgId} (${pending.method}): error in ${elapsed}ms: ${JSON.stringify(msg.error ?? msg.payload?.error).slice(0, 200)}`);
      }

      pending.resolve(msg);
      return;
    }

    // Unmatched response — might be for a pending that was already timed out
    if (msg.type === "res" && msgId) {
      warn(TAG, `rpc ${msgId}: received response for unknown/expired pending call`);
    }
  }

  /** Send a generic RPC call. Returns the response. */
  sendRpc(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 90000,
    opts: { expectFinal?: boolean } = {},
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated) {
        const reason = !this.ws ? "no socket" : !this.authenticated ? "not authenticated" : `ws state=${this.ws.readyState}`;
        warn(TAG, `sendRpc(${method}): not ready — ${reason}`);
        reject(new Error(`gateway not connected: ${reason}`));
        return;
      }

      const id = String(this.rpcId++);
      const sentAt = Date.now();
      log(TAG, `sendRpc → id=${id} method=${method} timeout=${timeoutMs}ms pending=${this.pending.size + 1}`);

      const timeout = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          const elapsed = Date.now() - sentAt;
          warn(TAG, `rpc ${id} (${method}): TIMEOUT after ${elapsed}ms`);
          this.onRpcFailure();
          reject(new Error(`rpc timeout: ${method}`));
        }
      }, timeoutMs);

      this.pending.set(id, {
        method,
        resolve,
        reject: (reason) => { this.onRpcFailure(); reject(reason); },
        timeout,
        expectFinal: !!opts.expectFinal,
        sentAt,
      });

      try {
        this.ws.send(JSON.stringify({ type: "req", method, id, params }));
      } catch (err: any) {
        // send() threw synchronously — connection is broken
        clearTimeout(timeout);
        this.pending.delete(id);
        error(TAG, `sendRpc(${method}): ws.send() threw: ${err.message}`);
        reject(new Error(`ws.send failed: ${err.message}`));
      }
    });
  }

  private cleanup(reason: string): void {
    const pendingCount = this.pending.size;
    this.ws = null;
    this.authenticated = false;
    if (pendingCount > 0) {
      log(TAG, `cleanup (${reason}): rejecting ${pendingCount} pending RPCs`);
      this.rejectAllPending(`gateway disconnected: ${reason}`);
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      log(TAG, `  rejecting pending rpc ${id} (${pending.method}), was pending ${Date.now() - pending.sentAt}ms`);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      log(TAG, "scheduleReconnect: stopped — not scheduling");
      return;
    }
    if (this.reconnectTimer) {
      log(TAG, "scheduleReconnect: already scheduled");
      return;
    }
    if (this.circuitOpen) {
      log(TAG, "scheduleReconnect: circuit open — deferring to circuit reset");
      return;
    }
    log(TAG, `scheduleReconnect: in ${this.reconnectDelay}ms (backoff=${this.reconnectDelay}ms)`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      log(TAG, "scheduleReconnect: firing — calling connect()");
      this.connect();
    }, this.reconnectDelay);
    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private onRpcFailure(): void {
    const now = Date.now();
    this.recentFailures.push(now);

    // Trim entries outside the sliding window
    const cutoff = now - OpenClawWsClient.CIRCUIT_WINDOW_MS;
    this.recentFailures = this.recentFailures.filter(ts => ts > cutoff);

    if (this.recentFailures.length >= 3) {
      warn(TAG, `${this.recentFailures.length} RPC failures in last ${OpenClawWsClient.CIRCUIT_WINDOW_MS / 1000}s (threshold: ${OpenClawWsClient.CIRCUIT_THRESHOLD})`);
    }

    if (this.recentFailures.length >= OpenClawWsClient.CIRCUIT_THRESHOLD && !this.circuitOpen) {
      this.circuitOpen = true;
      // Add 0-30s random jitter to prevent thundering herd on service recovery
      const jitterMs = Math.floor(Math.random() * 30000);
      const resetDelayMs = this.circuitResetDelay + jitterMs;
      warn(TAG, `circuit breaker OPENED after ${this.recentFailures.length} failures — pausing ${Math.round(resetDelayMs / 1000)}s (next reset: ${Math.round(Math.min(this.circuitResetDelay * 2, this.MAX_CIRCUIT_RESET) / 1000)}s)`);
      this.circuitResetTimer = setTimeout(() => {
        this.circuitResetTimer = null;
        this.circuitOpen = false;
        this.recentFailures = [];
        log(TAG, "circuit breaker RESET — calling connect()");
        this.connect();
      }, resetDelayMs);
      // Progressive backoff: double the delay for next trip, capped at MAX
      this.circuitResetDelay = Math.min(this.circuitResetDelay * 2, this.MAX_CIRCUIT_RESET);
    }
  }
}
