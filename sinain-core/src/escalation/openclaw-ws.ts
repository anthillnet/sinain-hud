import { EventEmitter } from "node:events";
import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import WebSocket from "ws";
import type { OpenClawConfig } from "../types.js";
import { log, warn, error } from "../log.js";

const TAG = "openclaw";

// ── Device Identity ──────────────────────────────────────────────────────────

interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const spki = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  if (spki.length === ED25519_SPKI_PREFIX.length + 32 &&
      spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem: string): string {
  return createHash("sha256").update(derivePublicKeyRaw(publicKeyPem)).digest("hex");
}

function publicKeyRawBase64Url(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = createPrivateKey(privateKeyPem);
  return base64UrlEncode(sign(null, Buffer.from(payload, "utf8"), key) as unknown as Buffer);
}

function buildDeviceAuthPayloadV3(params: {
  deviceId: string; clientId: string; clientMode: string;
  role: string; scopes: string[]; signedAtMs: number;
  token: string | null; nonce: string; platform: string;
}): string {
  return [
    "v3", params.deviceId, params.clientId, params.clientMode,
    params.role, params.scopes.join(","), String(params.signedAtMs),
    params.token ?? "", params.nonce, params.platform.toLowerCase(), "",
  ].join("|");
}

const DEVICE_IDENTITY_PATH = join(homedir(), ".sinain", "device-identity.json");

function loadOrCreateDeviceIdentity(): DeviceIdentity {
  try {
    if (existsSync(DEVICE_IDENTITY_PATH)) {
      const parsed = JSON.parse(readFileSync(DEVICE_IDENTITY_PATH, "utf8"));
      if (parsed?.version === 1 && parsed.deviceId && parsed.publicKeyPem && parsed.privateKeyPem) {
        const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
        return { deviceId: derivedId, publicKeyPem: parsed.publicKeyPem, privateKeyPem: parsed.privateKeyPem };
      }
    }
  } catch {}

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const deviceId = fingerprintPublicKey(publicKeyPem);

  const dir = dirname(DEVICE_IDENTITY_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(DEVICE_IDENTITY_PATH, JSON.stringify({ version: 1, deviceId, publicKeyPem, privateKeyPem }, null, 2) + "\n", { mode: 0o600 });
  log(TAG, `generated device identity → ${deviceId.slice(0, 12)}… (${DEVICE_IDENTITY_PATH})`);

  return { deviceId, publicKeyPem, privateKeyPem };
}

/** Ping timeout — if no pong arrives within this window after a ping, terminate. */
const PING_TIMEOUT_MS = 5_000;

interface PendingRpc {
  method: string;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout: ReturnType<typeof setTimeout>;
  expectFinal: boolean;
  sentAt: number;
  // For split RPCs (sendAgentRpcSplit):
  isSplit?: boolean;
  acceptedResolve?: () => void;
  acceptedReject?: (err: any) => void;
  finalResolve?: (value: any) => void;
  finalReject?: (reason: any) => void;
}

interface PendingFinalRpc {
  finalResolve: (value: any) => void;
  finalReject: (reason: any) => void;
  finalTimeout: ReturnType<typeof setTimeout>;
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
 *
 * Split RPC protocol (sendAgentRpcSplit):
 *   Phase 1 (10s timeout): await accepted frame → blocks queue worker
 *   Phase 2 (120s timeout): final frame → resolved async, never trips circuit
 */
export class OpenClawWsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private authenticated = false;
  private deviceIdentity: DeviceIdentity;
  private rpcId = 1;
  private pending = new Map<string, PendingRpc>();
  /** Phase 2 of split RPCs — resolved by final frame, rejected by 120s timeout or disconnect. */
  private pendingFinal = new Map<string, PendingFinalRpc>();
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

  // WS ping keepalive
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private config: OpenClawConfig) {
    super();
    this.deviceIdentity = loadOrCreateDeviceIdentity();
    log(TAG, `device identity: ${this.deviceIdentity.deviceId.slice(0, 12)}…`);
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

      this.ws.on("pong", () => {
        if (this.pingTimeoutTimer) {
          clearTimeout(this.pingTimeoutTimer);
          this.pingTimeoutTimer = null;
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
    }, 45000, { expectFinal: true });
    if (result?.ok) {
      this.circuitResetDelay = 300_000; // reset backoff on success
    }
    return result;
  }

  /**
   * Send a split-phase agent RPC.
   *
   * Returns two promises:
   *   acceptedPromise — resolves when Phase 1 (accepted frame) arrives within 10s.
   *     Rejection counts as a circuit-breaker failure (real delivery failure).
   *   finalPromise — resolves when Phase 2 (final frame) arrives within 120s.
   *     Timeout/rejection does NOT trip circuit breaker (agent slowness ≠ delivery failure).
   *
   * Queue worker awaits acceptedPromise, then releases immediately.
   * finalPromise is handled async — response arrives later.
   */
  sendAgentRpcSplit(
    message: string,
    idemKey: string,
    sessionKey: string,
  ): { acceptedPromise: Promise<void>; finalPromise: Promise<any> } {
    let acceptedResolve!: () => void;
    let acceptedReject!: (err: any) => void;
    let finalResolve!: (value: any) => void;
    let finalReject!: (err: any) => void;

    const acceptedPromise = new Promise<void>((res, rej) => {
      acceptedResolve = res;
      acceptedReject = rej;
    });
    const finalPromise = new Promise<any>((res, rej) => {
      finalResolve = res;
      finalReject = rej;
    });

    if (this.circuitOpen) {
      const err = new Error("circuit breaker open");
      acceptedReject(err);
      finalReject(err);
      return { acceptedPromise, finalPromise };
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated) {
      const reason = !this.ws ? "no socket" : !this.authenticated ? "not authenticated" : `ws state=${this.ws.readyState}`;
      const err = new Error(`gateway not connected: ${reason}`);
      acceptedReject(err);
      finalReject(err);
      return { acceptedPromise, finalPromise };
    }

    const id = String(this.rpcId++);
    const sentAt = Date.now();
    log(TAG, `sendAgentRpcSplit → id=${id} idemKey=${idemKey} msgLen=${message.length}`);

    const phase1Timeout = setTimeout(() => {
      if (this.pending.has(id)) {
        this.pending.delete(id);
        const elapsed = Date.now() - sentAt;
        warn(TAG, `rpc ${id} (agent) Phase 1 TIMEOUT after ${elapsed}ms`);
        this.onRpcFailure();
        const err = new Error(`rpc phase1 timeout: agent`);
        acceptedReject(err);
        finalReject(err);
      }
    }, this.config.phase1TimeoutMs);

    this.pending.set(id, {
      method: "agent",
      resolve: () => {},  // unused for split RPCs
      reject: () => {},   // unused for split RPCs
      timeout: phase1Timeout,
      expectFinal: false, // we handle the accepted frame ourselves
      sentAt,
      isSplit: true,
      acceptedResolve,
      acceptedReject,
      finalResolve,
      finalReject,
    });

    try {
      this.ws.send(JSON.stringify({
        type: "req",
        method: "agent",
        id,
        params: {
          message,
          idempotencyKey: idemKey,
          sessionKey,
          deliver: false,
        },
      }));
    } catch (err: any) {
      clearTimeout(phase1Timeout);
      this.pending.delete(id);
      error(TAG, `sendAgentRpcSplit: ws.send() threw: ${err.message}`);
      const sendErr = new Error(`ws.send failed: ${err.message}`);
      acceptedReject(sendErr);
      finalReject(sendErr);
    }

    return { acceptedPromise, finalPromise };
  }

  /** Check if connected and authenticated. */
  get isConnected(): boolean {
    return !!(this.ws && this.ws.readyState === WebSocket.OPEN && this.authenticated);
  }

  /** Check if the circuit breaker is currently open. */
  get isCircuitOpen(): boolean {
    return this.circuitOpen;
  }

  /** Force reconnection — resets stopped state and reconnect delay. */
  resetConnection(): void {
    log(TAG, "resetConnection: clearing stopped state, reconnecting");
    this.stopped = false;
    this.reconnectDelay = 1000;
    if (this.ws) {
      try { this.ws.close(1000, "reset"); } catch {}
      this.ws = null;
      this.authenticated = false;
    }
    this.connect();
  }

  /** Graceful disconnect — does not schedule reconnect. */
  disconnect(): void {
    log(TAG, `disconnect: stopping (pending=${this.pending.size}, pendingFinal=${this.pendingFinal.size})`);
    this.stopped = true;
    this.stopPing();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.circuitResetTimer) { clearTimeout(this.circuitResetTimer); this.circuitResetTimer = null; }
    if (this.ws) { try { this.ws.close(1000, "graceful shutdown"); } catch {} this.ws = null; }
    this.authenticated = false;
    this.connectedAt = null;
    this.rejectAllPending("disconnected");
    this.rejectAllPendingFinal("disconnected");
  }

  // ── Private ──

  private handleMessage(msg: any): void {
    // Handle connect.challenge
    if (msg.type === "event" && msg.event === "connect.challenge") {
      const nonce: string = msg.payload?.nonce ?? msg.nonce ?? "";
      const tokenHash = this.config.gatewayToken
        ? createHash("sha256").update(this.config.gatewayToken).digest("hex").slice(0, 12)
        : "none";
      log(TAG, `received connect.challenge — sending auth (tokenHash=${tokenHash}, device=${this.deviceIdentity.deviceId.slice(0, 12)}…)`);

      const scopes = ["operator.read", "operator.write", "operator.admin"];
      const signedAtMs = Date.now();
      const payload = buildDeviceAuthPayloadV3({
        deviceId: this.deviceIdentity.deviceId,
        clientId: "gateway-client",
        clientMode: "backend",
        role: "operator",
        scopes,
        signedAtMs,
        token: this.config.gatewayToken || null,
        nonce,
        platform: process.platform,
      });
      const signature = signDevicePayload(this.deviceIdentity.privateKeyPem, payload);

      this.ws?.send(JSON.stringify({
        type: "req",
        id: "connect-1",
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          role: "operator",
          scopes,
          client: {
            id: "gateway-client",
            displayName: "Sinain Core",
            version: "1.0.0",
            platform: process.platform,
            mode: "backend",
          },
          auth: { token: this.config.gatewayToken },
          device: {
            id: this.deviceIdentity.deviceId,
            publicKey: publicKeyRawBase64Url(this.deviceIdentity.publicKeyPem),
            signature,
            signedAt: signedAtMs,
            nonce,
          },
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
        this.startPing();
        this.emit("connected");
      } else {
        const errInfo = msg.error || msg.payload?.error || "unknown";
        const authReason = msg.error?.details?.authReason
          || msg.payload?.error?.details?.authReason;
        error(TAG, `auth failed: ${JSON.stringify(errInfo)}`);

        // Auth errors — retry with long backoff (token may become valid after gateway restart)
        if (authReason === "token_mismatch") {
          error(TAG, "auth failure (token_mismatch) — will retry with long backoff. Check OPENCLAW_GATEWAY_TOKEN.");
          this.reconnectDelay = Math.min(this.reconnectDelay * 4, this.maxReconnectDelay);
          this.ws?.close();
          return;
        }

        log(TAG, "auth failed (transient) — closing to trigger reconnect");
        this.ws?.close();
      }
      return;
    }

    // Handle RPC responses
    const msgId = msg.id != null ? String(msg.id) : null;

    // Check pendingFinal first — Phase 2 final frames for split RPCs
    if (msg.type === "res" && msgId && this.pendingFinal.has(msgId)) {
      const pf = this.pendingFinal.get(msgId)!;
      clearTimeout(pf.finalTimeout);
      this.pendingFinal.delete(msgId);
      const elapsed = Date.now() - pf.sentAt;
      if (msg.ok) {
        log(TAG, `rpc ${msgId} Phase 2 final: ok in ${elapsed}ms, status=${msg.payload?.status ?? "n/a"}`);
        this.circuitResetDelay = 300_000; // success — reset circuit backoff
        pf.finalResolve(msg);
      } else {
        warn(TAG, `rpc ${msgId} Phase 2 final: error in ${elapsed}ms: ${JSON.stringify(msg.error ?? msg.payload?.error).slice(0, 200)}`);
        pf.finalReject(new Error(JSON.stringify(msg.error ?? msg.payload?.error ?? "phase2 error").slice(0, 200)));
      }
      return;
    }

    if (msg.type === "res" && msgId && this.pending.has(msgId)) {
      const pending = this.pending.get(msgId)!;
      const elapsed = Date.now() - pending.sentAt;

      // Split RPC: handle accepted frame → transition to Phase 2
      if (pending.isSplit) {
        clearTimeout(pending.timeout);
        this.pending.delete(msgId);

        if (msg.payload?.status === "accepted") {
          log(TAG, `rpc ${msgId} (agent) Phase 1 accepted in ${elapsed}ms`);
          const phase2Timeout = setTimeout(() => {
            if (this.pendingFinal.has(msgId)) {
              const pf = this.pendingFinal.get(msgId)!;
              this.pendingFinal.delete(msgId);
              warn(TAG, `rpc ${msgId} Phase 2 TIMEOUT (${Date.now() - pf.sentAt}ms) — agent slow, unblocking`);
              pf.finalReject(new Error("rpc phase2 timeout: agent"));
              // Intentionally NOT calling onRpcFailure() — agent slowness ≠ delivery failure
            }
          }, this.config.phase2TimeoutMs);
          this.pendingFinal.set(msgId, {
            finalResolve: pending.finalResolve!,
            finalReject: pending.finalReject!,
            finalTimeout: phase2Timeout,
            sentAt: pending.sentAt,
          });
          pending.acceptedResolve!();
        } else {
          // Phase 1 error response (not accepted)
          warn(TAG, `rpc ${msgId} (agent) Phase 1 error in ${elapsed}ms: ${JSON.stringify(msg.error ?? msg.payload?.error).slice(0, 200)}`);
          this.onRpcFailure();
          const err = new Error(JSON.stringify(msg.error ?? msg.payload?.error ?? "phase1 error").slice(0, 200));
          pending.acceptedReject!(err);
          pending.finalReject!(err);
        }
        return;
      }

      // Regular RPC: skip intermediate "accepted" frame when expecting final
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

  private startPing(): void {
    this.stopPing();
    if (!this.config.pingIntervalMs || this.config.pingIntervalMs <= 0) return;
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.pingTimeoutTimer = setTimeout(() => {
        warn(TAG, "ping timeout — terminating connection");
        this.ws?.terminate();
      }, PING_TIMEOUT_MS);
      this.ws.ping();
    }, this.config.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.pingTimeoutTimer) { clearTimeout(this.pingTimeoutTimer); this.pingTimeoutTimer = null; }
  }

  private cleanup(reason: string): void {
    this.stopPing();
    const pendingCount = this.pending.size;
    const finalCount = this.pendingFinal.size;
    this.ws = null;
    this.authenticated = false;
    if (pendingCount > 0 || finalCount > 0) {
      log(TAG, `cleanup (${reason}): rejecting ${pendingCount} pending, ${finalCount} pendingFinal RPCs`);
      this.rejectAllPending(`gateway disconnected: ${reason}`);
      // Phase 2 rejections — no onRpcFailure() (agent slowness ≠ connection failure)
      this.rejectAllPendingFinal(`gateway disconnected: ${reason}`);
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      log(TAG, `  rejecting pending rpc ${id} (${pending.method}), was pending ${Date.now() - pending.sentAt}ms`);
      if (pending.isSplit) {
        // Phase 1 disconnect = real delivery failure → count for circuit breaker
        this.onRpcFailure();
        const err = new Error(reason);
        pending.acceptedReject?.(err);
        pending.finalReject?.(err);
      } else {
        pending.reject(new Error(reason));
      }
    }
    this.pending.clear();
  }

  /** Reject all Phase 2 pending RPCs. Does NOT call onRpcFailure(). */
  private rejectAllPendingFinal(reason: string): void {
    for (const [id, pf] of this.pendingFinal) {
      clearTimeout(pf.finalTimeout);
      log(TAG, `  rejecting pendingFinal rpc ${id}, was pending ${Date.now() - pf.sentAt}ms`);
      pf.finalReject(new Error(reason));
    }
    this.pendingFinal.clear();
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
