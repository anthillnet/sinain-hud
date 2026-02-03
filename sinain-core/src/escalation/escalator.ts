import type { AgentEntry, ContextWindow, EscalationConfig, OpenClawConfig, FeedItem } from "../types.js";
import type { FeedBuffer } from "../buffers/feed-buffer.js";
import type { WsHandler } from "../overlay/ws-handler.js";
import { OpenClawWsClient } from "./openclaw-ws.js";
import { shouldEscalate } from "./scorer.js";
import { buildEscalationMessage } from "./message-builder.js";
import { log, warn, error } from "../log.js";

const TAG = "escalation";

export interface EscalatorDeps {
  feedBuffer: FeedBuffer;
  wsHandler: WsHandler;
  escalationConfig: EscalationConfig;
  openclawConfig: OpenClawConfig;
}

/**
 * Orchestrates escalation decisions and message delivery.
 * Combines scorer (should we escalate?) + message builder (what to send) +
 * OpenClaw WS/HTTP delivery (how to send) into a single coordinator.
 */
export class Escalator {
  private wsClient: OpenClawWsClient;
  private lastEscalationTs = 0;
  private lastEscalatedDigest = "";

  private stats = {
    totalEscalations: 0,
    totalResponses: 0,
    totalErrors: 0,
    totalNoReply: 0,
    lastEscalationTs: 0,
    lastResponseTs: 0,
  };

  constructor(private deps: EscalatorDeps) {
    this.wsClient = new OpenClawWsClient(deps.openclawConfig);
  }

  /** Start the WS connection to OpenClaw. */
  start(): void {
    if (this.deps.escalationConfig.mode !== "off") {
      this.wsClient.connect();
      log(TAG, `mode: ${this.deps.escalationConfig.mode}`);
    }
  }

  /** Stop and disconnect. */
  stop(): void {
    this.wsClient.disconnect();
  }

  /** Update escalation mode at runtime. */
  setMode(mode: EscalatorDeps["escalationConfig"]["mode"]): void {
    this.deps.escalationConfig.mode = mode;
    if (mode !== "off" && !this.wsClient.isConnected) {
      this.wsClient.connect();
    }
    if (mode === "off") {
      this.wsClient.disconnect();
    }
    log(TAG, `mode changed to: ${mode}`);
  }

  /**
   * Called after every agent analysis tick.
   * Decides whether to escalate and handles delivery.
   */
  onAgentAnalysis(entry: AgentEntry, contextWindow: ContextWindow): void {
    const { escalate, score } = shouldEscalate(
      entry.digest,
      entry.hud,
      contextWindow,
      this.deps.escalationConfig.mode,
      this.lastEscalationTs,
      this.deps.escalationConfig.cooldownMs,
      this.lastEscalatedDigest,
    );

    if (!escalate) return;

    // Mark cooldown immediately
    this.stats.totalEscalations++;
    this.lastEscalationTs = Date.now();
    this.stats.lastEscalationTs = Date.now();
    this.lastEscalatedDigest = entry.digest;

    const message = buildEscalationMessage(
      entry.digest,
      contextWindow,
      entry,
      this.deps.escalationConfig.mode,
    );
    const idemKey = `hud-${entry.id}-${Date.now()}`;

    log(TAG, `escalating tick #${entry.id} (score=${score.total}, reasons=[${score.reasons.join(",")}])`);

    // Fire async — don't block the agent tick loop
    this.doEscalate(message, idemKey, entry.digest).catch(err => {
      error(TAG, "escalation error:", err.message);
    });
  }

  /** Send a direct user message to OpenClaw. */
  async sendDirect(text: string): Promise<void> {
    const idemKey = `direct-${Date.now()}`;
    if (this.wsClient.isConnected) {
      try {
        await this.wsClient.sendAgentRpc(text, idemKey, this.deps.openclawConfig.sessionKey);
        return;
      } catch {
        // Fall through to HTTP
      }
    }
    await this.escalateViaHttp(text);
  }

  /** Get stats for /health. */
  getStats(): Record<string, unknown> {
    return {
      mode: this.deps.escalationConfig.mode,
      gatewayConnected: this.wsClient.isConnected,
      cooldownMs: this.deps.escalationConfig.cooldownMs,
      ...this.stats,
    };
  }

  // ── Private ──

  private async doEscalate(message: string, idemKey: string, digest: string): Promise<void> {
    // Primary: WS RPC
    if (this.wsClient.isConnected) {
      try {
        const result = await this.wsClient.sendAgentRpc(
          message, idemKey, this.deps.openclawConfig.sessionKey,
        );

        if (result.ok && result.payload) {
          const p = result.payload;
          log(TAG, `WS RPC ok \u2192 runId=${p.runId}, status=${p.status}`);

          const payloads = p.result?.payloads;
          if (Array.isArray(payloads) && payloads.length > 0) {
            const output = payloads.map((pl: any) => pl.text || "").join("\n").trim();
            if (output) {
              this.pushResponse(output);
            } else {
              this.stats.totalNoReply++;
              log(TAG, `empty text in ${payloads.length} payloads`);
            }
          } else {
            // No payloads = agent said NO_REPLY
            this.stats.totalNoReply++;
            if ((this.deps.escalationConfig.mode === "focus" || this.deps.escalationConfig.mode === "rich") && digest) {
              this.pushResponse(digest);
              log(TAG, "focus-mode NO_REPLY \u2014 pushed digest as fallback");
            } else {
              log(TAG, "agent returned no payloads (NO_REPLY)");
            }
          }
        } else if (!result.ok) {
          const errDetail = JSON.stringify(result.error || result.payload);
          log(TAG, `agent RPC error: ${errDetail}`);
          this.pushError(errDetail);
          this.stats.totalErrors++;
        }
        return;
      } catch (err: any) {
        log(TAG, `agent RPC failed: ${err.message} \u2014 falling back to HTTP`);
        this.pushError(`RPC exception: ${err.message}`);
      }
    }

    // Fallback: HTTP POST (fire-and-forget)
    if (this.deps.openclawConfig.hookUrl) {
      const ok = await this.escalateViaHttp(message);
      if (!ok) this.stats.totalErrors++;
    } else {
      log(TAG, "no WS and no hookUrl \u2014 escalation skipped");
    }
  }

  private async escalateViaHttp(message: string): Promise<boolean> {
    try {
      const resp = await fetch(this.deps.openclawConfig.hookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.deps.openclawConfig.hookToken
            ? { "Authorization": `Bearer ${this.deps.openclawConfig.hookToken}` }
            : {}),
        },
        body: JSON.stringify({
          message,
          name: "sinain-core",
          sessionKey: this.deps.openclawConfig.sessionKey,
          wakeMode: "now",
          deliver: false,
        }),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        error(TAG, `HTTP hook failed: ${resp.status} ${body.slice(0, 200)}`);
        return false;
      }
      log(TAG, "escalated via HTTP (fire-and-forget)");
      return true;
    } catch (err: any) {
      error(TAG, "HTTP hook error:", err.message);
      return false;
    }
  }

  private pushResponse(output: string): void {
    const text = `[\ud83e\udd16] ${output.trim().slice(0, 2000)}`;
    this.deps.feedBuffer.push(text, "high", "openclaw", "agent");
    this.deps.wsHandler.broadcast(text, "high", "agent");
    this.stats.totalResponses++;
    this.stats.lastResponseTs = Date.now();
    log(TAG, `response pushed: "${output.slice(0, 80)}..."`);
  }

  private pushError(detail: string): void {
    const text = `[\ud83e\udd16 err] ${detail.slice(0, 500)}`;
    this.deps.feedBuffer.push(text, "normal", "openclaw", "stream");
  }
}
