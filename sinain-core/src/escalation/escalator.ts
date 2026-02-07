import type { AgentEntry, ContextWindow, EscalationConfig, OpenClawConfig, FeedItem } from "../types.js";
import type { FeedBuffer } from "../buffers/feed-buffer.js";
import type { WsHandler } from "../overlay/ws-handler.js";
import { OpenClawWsClient } from "./openclaw-ws.js";
import { shouldEscalate } from "./scorer.js";
import { buildEscalationMessage, isCodingContext } from "./message-builder.js";
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

  // Spawn deduplication state
  private lastSpawnedTask = "";
  private lastSpawnTs = 0;
  private static readonly SPAWN_COOLDOWN_MS = 60_000; // 60 seconds between duplicate spawns

  // Track pending spawn tasks for result fetching
  private pendingSpawnTasks = new Map<string, {
    runId: string;
    childSessionKey: string;
    label?: string;
    startedAt: number;
  }>();

  // Store context from last escalation for response handling
  private lastEscalationContext: ContextWindow | null = null;

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

    // Store context for response handling
    this.lastEscalationContext = contextWindow;

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

  /**
   * Dispatch a task to be handled by a spawned subagent.
   * This sends a specially-formatted message that the main agent recognizes
   * and spawns a subagent to process.
   */
  async dispatchSpawnTask(task: string, label?: string): Promise<void> {
    // --- Deduplication check ---
    const normalizedTask = task.toLowerCase().trim();
    const now = Date.now();

    // Skip if same task within cooldown
    if (normalizedTask === this.lastSpawnedTask &&
        now - this.lastSpawnTs < Escalator.SPAWN_COOLDOWN_MS) {
      log(TAG, `spawn-task skipped (duplicate within cooldown): "${task.slice(0, 50)}..."`);
      return;
    }

    // Update dedup state
    this.lastSpawnedTask = normalizedTask;
    this.lastSpawnTs = now;
    // --- End deduplication check ---

    const labelStr = label ? ` (label: "${label}")` : "";
    const message = `[sinain-core:spawn-task]${labelStr}

Please spawn a subagent to handle this task:

${task}

Use sessions_spawn with the task above. The subagent will process and announce the result.`;

    const idemKey = `spawn-task-${Date.now()}`;
    log(TAG, `dispatching spawn-task${labelStr}: "${task.slice(0, 80)}..."`);

    // Send RPC and extract spawn info from response
    if (this.wsClient.isConnected) {
      try {
        const result = await this.wsClient.sendAgentRpc(
          message, idemKey, this.deps.openclawConfig.sessionKey,
        );

        // Debug: log the raw response structure
        log(TAG, `spawn-task RPC response: ${JSON.stringify(result).slice(0, 500)}`);

        const spawnInfo = this.extractSpawnInfo(result);
        if (spawnInfo) {
          this.pendingSpawnTasks.set(spawnInfo.runId, {
            ...spawnInfo,
            label,
            startedAt: Date.now(),
          });
          log(TAG, `spawn-task tracked: runId=${spawnInfo.runId}, childSessionKey=${spawnInfo.childSessionKey}`);

          // Start async polling for this task
          this.pollTaskCompletion(spawnInfo.runId);
        } else {
          log(TAG, "spawn-task: could not extract runId/childSessionKey from response");
        }
        return;
      } catch (err: any) {
        error(TAG, `spawn-task failed: ${err.message}`);
      }
    }

    // Fallback to regular escalation (HTTP)
    await this.doEscalate(message, idemKey, "");
  }

  /** Extract spawn info (runId, childSessionKey) from agent RPC response. */
  private extractSpawnInfo(result: any): { runId: string; childSessionKey: string } | null {
    if (!result?.ok || !result?.payload) {
      log(TAG, `extractSpawnInfo: no ok/payload in result`);
      return null;
    }

    // The agent's response contains tool results with spawn info
    const payloads = result.payload.result?.payloads;
    log(TAG, `extractSpawnInfo: payloads count=${payloads?.length}, first text=${payloads?.[0]?.text?.slice(0, 200)}`);

    if (!Array.isArray(payloads)) return null;

    for (const pl of payloads) {
      if (typeof pl.text !== "string") continue;

      // Strategy 1: Find all JSON-like objects and try to parse each
      // This handles nested JSON that the old regex couldn't match
      const jsonMatches = this.findJsonObjects(pl.text);
      for (const jsonStr of jsonMatches) {
        try {
          const parsed = JSON.parse(jsonStr);
          if (parsed.runId && parsed.childSessionKey) {
            return { runId: parsed.runId, childSessionKey: parsed.childSessionKey };
          }
        } catch { /* skip malformed JSON */ }
      }

      // Strategy 2: Try parsing the entire text as JSON
      try {
        const parsed = JSON.parse(pl.text);
        if (parsed.runId && parsed.childSessionKey) {
          return { runId: parsed.runId, childSessionKey: parsed.childSessionKey };
        }
      } catch { /* skip */ }
    }

    return null;
  }

  /** Find JSON objects in text, handling nested braces properly. */
  private findJsonObjects(text: string): string[] {
    const results: string[] = [];
    let i = 0;

    while (i < text.length) {
      if (text[i] === "{") {
        let depth = 1;
        let start = i;
        i++;

        while (i < text.length && depth > 0) {
          if (text[i] === "{") depth++;
          else if (text[i] === "}") depth--;
          i++;
        }

        if (depth === 0) {
          results.push(text.slice(start, i));
        }
      } else {
        i++;
      }
    }

    return results;
  }

  /** Poll for task completion and push result to HUD. */
  private async pollTaskCompletion(runId: string): Promise<void> {
    const task = this.pendingSpawnTasks.get(runId);
    if (!task) return;

    const maxWaitMs = 5 * 60 * 1000; // 5 minutes
    const pollIntervalMs = 5000; // 5 seconds

    const poll = async (): Promise<void> => {
      const elapsed = Date.now() - task.startedAt;
      if (elapsed > maxWaitMs) {
        log(TAG, `spawn-task timeout: runId=${runId}`);
        this.pendingSpawnTasks.delete(runId);
        return;
      }

      if (!this.wsClient.isConnected) {
        // Retry later
        setTimeout(() => poll(), pollIntervalMs);
        return;
      }

      try {
        // Wait for completion (short timeout to poll periodically)
        const waitResult = await this.wsClient.sendRpc("agent.wait", {
          runId,
          timeoutMs: pollIntervalMs,
        }, pollIntervalMs + 2000);

        // Debug: log the poll result
        log(TAG, `poll result: status=${waitResult?.payload?.status}, ok=${waitResult?.ok}`);

        // Accept multiple completion statuses
        const completedStatuses = ["ok", "completed", "done", "finished", "success"];
        const status = waitResult?.payload?.status;

        if (waitResult?.ok && completedStatuses.includes(status)) {
          log(TAG, `spawn-task completed: runId=${runId}, status=${status}`);

          // Fetch the result from chat history
          const historyResult = await this.wsClient.sendRpc("chat.history", {
            sessionKey: task.childSessionKey,
            limit: 10,
          }, 10000);

          const resultText = this.extractLatestAssistantReply(historyResult);
          if (resultText) {
            const labelDisplay = task.label || "Background task";
            this.pushResponse(`${labelDisplay}:\n${resultText}`);
          } else {
            log(TAG, `spawn-task completed but no result text: runId=${runId}`);
          }

          this.pendingSpawnTasks.delete(runId);
          return;
        }

        if (waitResult?.payload?.status === "error" || waitResult?.payload?.status === "failed") {
          log(TAG, `spawn-task failed: runId=${runId}, error=${waitResult?.payload?.error || "unknown"}`);
          this.pendingSpawnTasks.delete(runId);
          return;
        }

        // Status is "timeout" or still running - poll again
        setTimeout(() => poll(), 1000);
      } catch (err: any) {
        warn(TAG, `poll error for runId=${runId}: ${err.message}`);
        // Retry on transient errors
        setTimeout(() => poll(), pollIntervalMs);
      }
    };

    // Start polling
    poll();
  }

  /** Extract the latest assistant reply from chat history. */
  private extractLatestAssistantReply(historyResult: any): string | null {
    // Try multiple paths to find messages (different API response formats)
    const messages = historyResult?.payload?.messages
      || historyResult?.messages
      || historyResult?.payload?.result?.messages
      || historyResult?.result?.messages;

    // Debug: log what we found
    log(TAG, `extractLatestAssistantReply: messages=${Array.isArray(messages) ? messages.length : "none"}`);

    if (!Array.isArray(messages)) {
      // Maybe it's a direct text response
      if (typeof historyResult?.payload?.text === "string") {
        log(TAG, `extractLatestAssistantReply: found payload.text`);
        return historyResult.payload.text;
      }
      if (typeof historyResult?.text === "string") {
        log(TAG, `extractLatestAssistantReply: found text`);
        return historyResult.text;
      }
      if (typeof historyResult?.payload?.result?.text === "string") {
        log(TAG, `extractLatestAssistantReply: found payload.result.text`);
        return historyResult.payload.result.text;
      }
      log(TAG, `extractLatestAssistantReply: no messages array found, historyResult keys=${Object.keys(historyResult || {}).join(",")}`);
      return null;
    }

    // Find the last assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        // Extract text content
        if (typeof msg.content === "string") return msg.content;
        if (Array.isArray(msg.content)) {
          const textPart = msg.content.find((p: any) => p.type === "text");
          if (textPart?.text) return textPart.text;
        }
      }
    }

    log(TAG, `extractLatestAssistantReply: no assistant message found in ${messages.length} messages`);
    return null;
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
              this.pushResponse(output, this.lastEscalationContext);
            } else {
              this.stats.totalNoReply++;
              log(TAG, `empty text in ${payloads.length} payloads`);
            }
          } else {
            // No payloads = agent said NO_REPLY
            this.stats.totalNoReply++;
            if ((this.deps.escalationConfig.mode === "focus" || this.deps.escalationConfig.mode === "rich") && digest) {
              this.pushResponse(digest, this.lastEscalationContext);
              log(TAG, "focus-mode NO_REPLY — pushed digest as fallback");
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

  private pushResponse(output: string, context?: ContextWindow | null): void {
    // Allow longer responses for coding contexts
    const { coding } = context ? isCodingContext(context) : { coding: false };
    const maxLen = coding ? 4000 : 2000;

    const text = `[🤖] ${output.trim().slice(0, maxLen)}`;
    this.deps.feedBuffer.push(text, "high", "openclaw", "agent");
    this.deps.wsHandler.broadcast(text, "high", "agent");
    this.stats.totalResponses++;
    this.stats.lastResponseTs = Date.now();
    log(TAG, `response pushed (coding=${coding}, maxLen=${maxLen}): "${output.slice(0, 80)}..."`);
  }

  private pushError(detail: string): void {
    const text = `[\ud83e\udd16 err] ${detail.slice(0, 500)}`;
    this.deps.feedBuffer.push(text, "normal", "openclaw", "stream");
  }
}
