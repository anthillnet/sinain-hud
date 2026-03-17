import type { AgentEntry, ContextWindow, EscalationConfig, OpenClawConfig, FeedItem, SpawnTaskMessage, SpawnTaskStatus } from "../types.js";
import type { FeedBuffer } from "../buffers/feed-buffer.js";
import type { WsHandler } from "../overlay/ws-handler.js";
import type { Profiler } from "../profiler.js";
import type { FeedbackStore } from "../learning/feedback-store.js";
import type { SignalCollector } from "../learning/signal-collector.js";
import { randomUUID, createHash } from "node:crypto";
import { OpenClawWsClient } from "./openclaw-ws.js";
import { OutboundQueue, nextBackoff } from "./outbound-queue.js";
import type { QueueEntry } from "./outbound-queue.js";
import { shouldEscalate, calculateEscalationScore } from "./scorer.js";
import { buildEscalationMessage, isCodingContext } from "./message-builder.js";
import { loadPendingTasks, savePendingTasks, type PendingTaskEntry } from "../util/task-store.js";
import { log, warn, error } from "../log.js";

const TAG = "escalation";

export interface EscalatorDeps {
  feedBuffer: FeedBuffer;
  wsHandler: WsHandler;
  escalationConfig: EscalationConfig;
  openclawConfig: OpenClawConfig;
  profiler?: Profiler;
  feedbackStore?: FeedbackStore;
  signalCollector?: SignalCollector;
}

/**
 * Orchestrates escalation decisions and message delivery.
 * Combines scorer (should we escalate?) + message builder (what to send) +
 * OpenClaw WS delivery (how to send) into a single coordinator.
 *
 * Delivery uses a two-phase protocol:
 *   Phase 1 (10s): await "accepted" frame → delivery confirmed, worker unblocks
 *   Phase 2 (120s): await final frame → response arrives async, never trips circuit
 *
 * OutboundQueue persists messages to disk for crash recovery and
 * provides content-hash idempotency keys for gateway-level dedup.
 */
export class Escalator {
  private wsClient: OpenClawWsClient;
  private queue: OutboundQueue;
  private workerRunning = false;

  private lastEscalationTs = Date.now();
  private lastEscalatedDigest = "";

  // Spawn deduplication state
  private lastSpawnFingerprint = "";
  private lastSpawnTs = 0;
  private static readonly SPAWN_COOLDOWN_MS = 60_000; // 60 seconds between duplicate spawns

  // Prevent concurrent spawn RPCs (sibling spawns only — never blocks regular escalations)
  private spawnInFlight = false;

  // Track pending spawn tasks for result fetching (persisted to disk)
  private pendingSpawnTasks: Map<string, PendingTaskEntry>;

  // Cap concurrent polling loops to limit RPC load
  private static readonly MAX_CONCURRENT_POLLS = 5;
  private activePolls = 0;
  private pollQueue: string[] = [];

  // Store context from last escalation for response handling
  private lastEscalationContext: ContextWindow | null = null;

  private stats = {
    totalEscalations: 0,
    totalResponses: 0,
    totalErrors: 0,
    totalNoReply: 0,
    lastEscalationTs: 0,
    lastResponseTs: 0,
    // Health metrics
    totalTimeouts: 0,
    totalDirectResponses: 0,
    totalSpawnResponses: 0,
    avgResponseMs: 0,
    consecutiveTimeouts: 0,
    consecutivePhase2Timeouts: 0,
    lastTimeoutTs: 0,
  };

  private outboundBytes = 0;

  constructor(private deps: EscalatorDeps) {
    this.wsClient = new OpenClawWsClient(deps.openclawConfig);
    // Load persistent queue and reset any accepted entries to pending (crash recovery)
    this.queue = OutboundQueue.load(
      deps.openclawConfig.queueTtlMs,
      deps.openclawConfig.queueMaxSize,
    );
    // Load pending tasks from disk (crash recovery)
    this.pendingSpawnTasks = loadPendingTasks();
    // Drain queue on every WS reconnect
    this.wsClient.on("connected", () => this.drainQueue());
  }

  /** Late-bind the signal collector (created after AgentLoop). */
  setSignalCollector(sc: SignalCollector): void {
    this.deps.signalCollector = sc;
  }

  /** Start the WS connection to OpenClaw. */
  start(): void {
    if (this.deps.escalationConfig.mode !== "off") {
      this.wsClient.connect();
      const tokenHash = this.deps.openclawConfig.gatewayToken
        ? createHash("sha256").update(this.deps.openclawConfig.gatewayToken).digest("hex").slice(0, 12)
        : "none";
      log(TAG, `mode: ${this.deps.escalationConfig.mode}, tokenHash: ${tokenHash}, wsUrl: ${this.deps.openclawConfig.gatewayWsUrl}`);
    }
    // Drain any queued messages that survived a crash (WS connected already on hot reload)
    if (this.queue.hasSendable) {
      log(TAG, `start: found ${this.queue.size} queued entries from previous run`);
      this.drainQueue();
    }
  }

  /** Stop and disconnect. */
  stop(): void {
    this.wsClient.disconnect();
  }

  /** Update escalation mode at runtime. */
  setMode(mode: EscalatorDeps["escalationConfig"]["mode"]): void {
    const wasOff = this.deps.escalationConfig.mode === "off";
    this.deps.escalationConfig.mode = mode;
    if (mode !== "off" && !this.wsClient.isConnected) {
      this.wsClient.resetConnection();
    }
    if (mode === "off") {
      this.wsClient.disconnect();
    }
    // Reset stale timer when transitioning from "off" to active (prevents immediate stale)
    if (wasOff && mode !== "off") {
      this.lastEscalationTs = Date.now();
    }
    log(TAG, `mode changed to: ${mode}`);
  }

  /**
   * Called after every agent analysis tick.
   * Decides whether to escalate and enqueues the message for delivery.
   */
  onAgentAnalysis(entry: AgentEntry, contextWindow: ContextWindow): void {
    // Skip entire escalation pipeline when circuit is open
    if (this.wsClient.isCircuitOpen) {
      log(TAG, `tick #${entry.id}: skipped — circuit breaker open`);
      return;
    }

    const { escalate, score, stale } = shouldEscalate(
      entry.digest,
      entry.hud,
      contextWindow,
      this.deps.escalationConfig.mode,
      this.lastEscalationTs,
      this.deps.escalationConfig.cooldownMs,
      this.lastEscalatedDigest,
      this.deps.escalationConfig.staleMs,
    );

    if (!escalate) {
      log(TAG, `tick #${entry.id}: not escalating (mode=${this.deps.escalationConfig.mode}, score=${score.total}, hud="${entry.hud.slice(0, 40)}")`);
      return;
    }

    // Mark cooldown immediately
    this.stats.totalEscalations++;
    this.deps.profiler?.gauge("escalation.totalEscalations", this.stats.totalEscalations);
    this.lastEscalationTs = Date.now();
    this.stats.lastEscalationTs = Date.now();
    this.lastEscalatedDigest = entry.digest;

    // Fetch recent feedback for inline context (non-blocking, defaults to empty)
    const recentFeedback = this.deps.feedbackStore?.queryRecent(5) ?? [];

    const escalationReason = stale ? "stale" : undefined;
    const message = buildEscalationMessage(
      entry.digest,
      contextWindow,
      entry,
      this.deps.escalationConfig.mode,
      escalationReason,
      recentFeedback,
    );

    const staleTag = stale ? ", STALE" : "";
    const wsState = this.wsClient.isConnected ? "ws=connected" : "ws=disconnected";
    log(TAG, `escalating tick #${entry.id} (score=${score.total}, reasons=[${score.reasons.join(",")}]${staleTag}, ${wsState})`);

    // Store context for response handling (used in pushResponse for coding-context max-length)
    this.lastEscalationContext = contextWindow;

    // Backpressure: skip if queue is too deep (Phase 2 stall)
    const bpThreshold = this.deps.openclawConfig.queueBackpressureThreshold;
    if (this.queue.size >= bpThreshold) {
      warn(TAG, `⚠ queue depth ${this.queue.size} ≥ ${bpThreshold} — backpressure, skipping escalation`);
      return;
    }

    // Enqueue — content-hash id deduplicates retries on the gateway side
    const queueEntry = this.queue.enqueue(message, this.deps.openclawConfig.sessionKey, {
      tickId: entry.id,
      hud: entry.hud,
      currentApp: contextWindow.currentApp,
      escalationScore: score.total,
      escalationReasons: score.reasons,
      codingContext: isCodingContext(contextWindow).coding,
      digest: entry.digest,
    });

    log(TAG, `tick #${entry.id} → queued id=${queueEntry.id} (queueSize=${this.queue.size})`);

    // Nudge the worker
    this.drainQueue();
  }

  /** Push fresh SITUATION.md content to the gateway server (fire-and-forget). */
  pushSituationMd(content: string): void {
    if (!this.wsClient.isConnected) return;
    this.wsClient.sendRpc("situation.update", { content }, 10_000)
      .catch((err: any) => warn(TAG, `situation.update rpc failed: ${err.message}`));
  }

  /** Send a direct user message to OpenClaw. */
  async sendDirect(text: string): Promise<void> {
    const idemKey = `direct-${Date.now()}`;
    if (this.wsClient.isConnected) {
      try {
        await this.wsClient.sendAgentRpc(text, idemKey, this.deps.openclawConfig.sessionKey);
        return;
      } catch (err: any) {
        warn(TAG, `sendDirect RPC failed: ${err.message}`);
      }
    }
    // WS disconnected or RPC failed — surface error to HUD
    const errMsg = `[⚠] Gateway disconnected — message not sent`;
    this.deps.feedBuffer.push(errMsg, "normal", "openclaw", "stream");
    this.deps.wsHandler.broadcast(errMsg, "normal", "stream");
  }

  /**
   * Send a periodic feedback summary to the OpenClaw agent.
   * Called on a timer from index.ts when learning is enabled.
   * Returns true if the summary was sent successfully.
   */
  async sendFeedbackSummary(): Promise<boolean> {
    if (!this.deps.feedbackStore) return false;
    if (!this.wsClient.isConnected) return false;

    const stats = this.deps.feedbackStore.getStats();
    const totalRecords = stats.totalRecords as number;
    if (totalRecords < 3) return false;

    const recent = this.deps.feedbackStore.queryRecent(5);
    const withSignals = recent.filter(r => r.signals.compositeScore !== 0 || r.signals.errorCleared !== null);
    if (withSignals.length === 0) return false;

    // Format compact summary
    const topTags = (stats.topTags as [string, number][] || [])
      .slice(0, 5)
      .map(([tag, count]) => `${tag} (${count})`)
      .join(", ");

    const recentLines = withSignals.slice(0, 5).map(r => {
      const ok = r.signals.compositeScore >= 0.2;
      const icon = ok ? "✓" : "✗";
      const score = r.signals.compositeScore.toFixed(2);
      const tags = r.tags.slice(0, 3).join(", ");
      const details: string[] = [];
      if (r.signals.errorCleared === true) details.push("error cleared");
      if (r.signals.errorCleared === false) details.push("error persisted");
      if (r.signals.noReEscalation === true) details.push("no re-escalation");
      if (r.signals.noReEscalation === false) details.push("re-escalated");
      if (r.signals.quickAppSwitch === true) details.push("quick switch");
      return `  ${icon} ${score} [${tags}]${details.length > 0 ? " — " + details.join(", ") : ""}`;
    });

    const message = `[sinain-core:feedback-summary]

Escalations: ${totalRecords} | Avg score: ${stats.avgCompositeScore ?? "n/a"} | Avg latency: ${stats.avgLatencyMs ?? "n/a"}ms
Top tags: ${topTags || "none"}

Recent (last ${withSignals.length}):
${recentLines.join("\n")}`;

    const idemKey = `feedback-summary-${Date.now()}`;
    try {
      await this.wsClient.sendAgentRpc(message, idemKey, this.deps.openclawConfig.sessionKey);
      log(TAG, `feedback summary sent (${totalRecords} records, ${withSignals.length} with signals)`);
      return true;
    } catch (err: any) {
      warn(TAG, `feedback summary send failed: ${err.message}`);
      return false;
    }
  }

  /** Force-reconnect the gateway WS client. */
  reconnectGateway(): void {
    this.wsClient.resetConnection();
  }

  /** Get stats for /health. */
  getStats(): Record<string, unknown> {
    return {
      mode: this.deps.escalationConfig.mode,
      gatewayConnected: this.wsClient.isConnected,
      circuitOpen: this.wsClient.isCircuitOpen,
      queueSize: this.queue.size,
      queueHead: this.queue.peekSendable()?.id ?? null,
      spawnInFlight: this.spawnInFlight,
      cooldownMs: this.deps.escalationConfig.cooldownMs,
      staleMs: this.deps.escalationConfig.staleMs,
      pendingSpawnTasks: this.pendingSpawnTasks.size,
      ...this.stats,
    };
  }

  /**
   * Dispatch a task to a spawned subagent via direct child session addressing.
   * Creates a unique child session key and sends the task directly to the gateway
   * agent RPC — bypassing the main session to avoid dedup/NO_REPLY issues.
   */
  async dispatchSpawnTask(task: string, label?: string): Promise<void> {
    // Prevent sibling spawn RPCs from piling up (independent from escalation queue)
    if (this.spawnInFlight) {
      log(TAG, `spawn-task skipped — spawn RPC already in-flight`);
      return;
    }

    // --- Fingerprint dedup — hash the task content ---
    const fingerprint = createHash("sha256").update(task.trim()).digest("hex").slice(0, 16);
    const now = Date.now();

    if (fingerprint === this.lastSpawnFingerprint &&
        now - this.lastSpawnTs < Escalator.SPAWN_COOLDOWN_MS) {
      log(TAG, `spawn-task skipped (duplicate fingerprint ${fingerprint})`);
      return;
    }

    this.lastSpawnFingerprint = fingerprint;
    this.lastSpawnTs = now;

    const taskId = `spawn-${Date.now()}`;
    const startedAt = Date.now();
    const labelStr = label ? ` (label: "${label}")` : "";
    const idemKey = `spawn-task-${Date.now()}`;

    // Generate a unique child session key — bypasses the main agent entirely
    const childSessionKey = `agent:main:subagent:${randomUUID()}`;
    const mainSessionKey = this.deps.openclawConfig.sessionKey;

    this.outboundBytes += Buffer.byteLength(task);
    this.deps.profiler?.gauge("network.escalationOutBytes", this.outboundBytes);
    log(TAG, `dispatching spawn-task${labelStr} → child=${childSessionKey}: "${task.slice(0, 80)}..."`);

    // ★ Broadcast "spawned" BEFORE the RPC — TSK tab shows ··· immediately
    this.broadcastTaskEvent(taskId, "spawned", label, startedAt);

    if (!this.wsClient.isConnected) {
      warn(TAG, `spawn-task ${taskId}: WS disconnected — cannot dispatch`);
      this.broadcastTaskEvent(taskId, "failed", label, startedAt);
      return;
    }

    // ★ Set spawnInFlight BEFORE first await — cleared in finally regardless of outcome.
    // Dedicated lane flag: never touches the escalation queue so regular escalations
    // continue unblocked while this spawn RPC is pending.
    this.spawnInFlight = true;
    try {
      // Send directly to a new child session via the gateway agent RPC
      const result = await this.wsClient.sendRpc("agent", {
        message: task,
        sessionKey: childSessionKey,
        lane: "subagent",
        extraSystemPrompt: this.buildChildSystemPrompt(task, label),
        deliver: false,
        spawnedBy: mainSessionKey,
        idempotencyKey: idemKey,
        label: label || undefined,
      }, 45_000, { expectFinal: true });

      log(TAG, `spawn-task RPC response: ${JSON.stringify(result).slice(0, 500)}`);
      this.stats.totalSpawnResponses++;

      // Extract result — child agent actually ran the task and returned content
      const payloads = result?.payload?.result?.payloads;
      const runId = result?.payload?.runId || taskId;

      if (Array.isArray(payloads) && payloads.length > 0) {
        const output = payloads.map((pl: any) => pl.text || "").join("\n").trim();
        if (output) {
          this.pushResponse(`${label || "Background task"}:\n${output}`);
          this.broadcastTaskEvent(taskId, "completed", label, startedAt, output);
        } else {
          log(TAG, `spawn-task: ${payloads.length} payloads but empty text, trying chat.history`);
          const historyText = await this.fetchChildResult(childSessionKey);
          this.broadcastTaskEvent(taskId, "completed", label, startedAt,
            historyText || "task completed (no output)");
          if (historyText) {
            this.pushResponse(`${label || "Background task"}:\n${historyText}`);
          }
        }
      } else {
        // No payloads — fallback: fetch from chat.history on child session
        log(TAG, `spawn-task: no payloads, fetching chat.history for child=${childSessionKey}`);
        const historyText = await this.fetchChildResult(childSessionKey);
        if (historyText) {
          this.pushResponse(`${label || "Background task"}:\n${historyText}`);
          this.broadcastTaskEvent(taskId, "completed", label, startedAt, historyText);
        } else {
          this.broadcastTaskEvent(taskId, "completed", label, startedAt,
            "task completed (no output captured)");
        }
      }

      // Persist for crash recovery (no polling needed — result already in hand)
      this.pendingSpawnTasks.set(taskId, {
        runId,
        childSessionKey,
        label,
        startedAt,
        pollingEmitted: false,
      });
      savePendingTasks(this.pendingSpawnTasks);

      // Clean up immediately since we already have the result
      this.pendingSpawnTasks.delete(taskId);
      savePendingTasks(this.pendingSpawnTasks);
    } catch (err: any) {
      error(TAG, `spawn-task failed: ${err.message}`);
      this.broadcastTaskEvent(taskId, "failed", label, startedAt);
    } finally {
      this.spawnInFlight = false;
    }
  }

  /** Build a focused system prompt for the child subagent. */
  private buildChildSystemPrompt(task: string, label?: string): string {
    return [
      "# Subagent Context",
      "",
      "You are a **subagent** spawned for a specific task.",
      "",
      "## Your Role",
      `- Task: ${task.replace(/\s+/g, " ").trim().slice(0, 500)}`,
      "- Complete this task. That's your entire purpose.",
      "",
      "## Rules",
      "1. Stay focused — do your assigned task, nothing else",
      "2. Your final message will be reported to the requester",
      "3. Be concise but informative",
      "",
      label ? `Label: ${label}` : "",
    ].filter(Boolean).join("\n");
  }

  /** Fetch the latest assistant reply from a child session's chat history. */
  private async fetchChildResult(childSessionKey: string): Promise<string | null> {
    try {
      const historyResult = await this.wsClient.sendRpc("chat.history", {
        sessionKey: childSessionKey,
        limit: 10,
      }, 10_000);
      return this.extractLatestAssistantReply(historyResult);
    } catch (err: any) {
      warn(TAG, `chat.history fetch failed for ${childSessionKey}: ${err.message}`);
      return null;
    }
  }

  /** Poll for task completion and push result to HUD (preserved for crash recovery). */
  private async pollTaskCompletion(taskId: string): Promise<void> {
    // Enforce concurrency cap — queue excess tasks
    if (this.activePolls >= Escalator.MAX_CONCURRENT_POLLS) {
      log(TAG, `poll queued (${this.activePolls} active): taskId=${taskId}`);
      this.pollQueue.push(taskId);
      return;
    }

    this.activePolls++;
    this.deps.profiler?.gauge("escalation.activePolls", this.activePolls);

    const task = this.pendingSpawnTasks.get(taskId);
    if (!task) {
      this.finishPoll();
      return;
    }

    const maxWaitMs = 5 * 60 * 1000; // 5 minutes
    const pollIntervalMs = 5000; // 5 seconds

    const poll = async (): Promise<void> => {
      const elapsed = Date.now() - task.startedAt;
      if (elapsed > maxWaitMs) {
        log(TAG, `spawn-task timeout: taskId=${taskId}`);
        this.broadcastTaskEvent(taskId, "timeout", task.label, task.startedAt);
        this.pendingSpawnTasks.delete(taskId);
        savePendingTasks(this.pendingSpawnTasks);
        this.finishPoll();
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
          runId: task.runId,
          timeoutMs: pollIntervalMs,
        }, pollIntervalMs + 2000);

        // Debug: log the poll result
        log(TAG, `poll result: taskId=${taskId}, status=${waitResult?.payload?.status}, ok=${waitResult?.ok}`);

        // Accept multiple completion statuses
        const completedStatuses = ["ok", "completed", "done", "finished", "success"];
        const status = waitResult?.payload?.status;

        if (waitResult?.ok && completedStatuses.includes(status)) {
          log(TAG, `spawn-task completed: taskId=${taskId}, status=${status}`);

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
            log(TAG, `spawn-task completed but no result text: taskId=${taskId}`);
          }

          this.broadcastTaskEvent(taskId, "completed", task.label, task.startedAt, resultText ?? undefined);
          this.pendingSpawnTasks.delete(taskId);
          savePendingTasks(this.pendingSpawnTasks);
          this.finishPoll();
          return;
        }

        if (waitResult?.payload?.status === "error" || waitResult?.payload?.status === "failed") {
          log(TAG, `spawn-task failed: taskId=${taskId}, error=${waitResult?.payload?.error || "unknown"}`);
          this.broadcastTaskEvent(taskId, "failed", task.label, task.startedAt);
          this.pendingSpawnTasks.delete(taskId);
          savePendingTasks(this.pendingSpawnTasks);
          this.finishPoll();
          return;
        }

        // Status is "timeout" or still running — emit polling once
        if (!task.pollingEmitted) {
          task.pollingEmitted = true;
          this.broadcastTaskEvent(taskId, "polling", task.label, task.startedAt);
        }
        setTimeout(() => poll(), 1000);
      } catch (err: any) {
        warn(TAG, `poll error for taskId=${taskId}: ${err.message}`);
        // Retry on transient errors
        setTimeout(() => poll(), pollIntervalMs);
      }
    };

    // Start polling
    poll();
  }

  /** Decrement active polls and drain the queue. */
  private finishPoll(): void {
    this.activePolls--;
    this.deps.profiler?.gauge("escalation.activePolls", this.activePolls);
    this.deps.profiler?.gauge("escalation.pendingSpawns", this.pendingSpawnTasks.size);
    // Drain queued tasks
    while (this.pollQueue.length > 0 && this.activePolls < Escalator.MAX_CONCURRENT_POLLS) {
      const nextId = this.pollQueue.shift()!;
      if (this.pendingSpawnTasks.has(nextId)) {
        log(TAG, `poll dequeued: taskId=${nextId}`);
        this.pollTaskCompletion(nextId);
      }
    }
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

  /**
   * Background worker: drains the outbound queue.
   *
   * Blocks on Phase 1 (acceptedPromise) — guarantees exactly 1 in-flight delivery at a time.
   * Releases after Phase 1; Phase 2 (finalPromise) runs async without blocking the worker.
   */
  private async drainQueue(): Promise<void> {
    if (this.workerRunning || !this.wsClient.isConnected) return;
    this.workerRunning = true;
    try {
      while (this.queue.hasSendable) {
        if (!this.wsClient.isConnected) break;
        const entry = this.queue.peekSendable()!;
        try {
          this.outboundBytes += Buffer.byteLength(entry.message);
          this.deps.profiler?.gauge("network.escalationOutBytes", this.outboundBytes);

          const rpcStart = Date.now();
          const { acceptedPromise, finalPromise } = this.wsClient.sendAgentRpcSplit(
            entry.message, entry.id, entry.sessionKey,
          );

          // ★ Phase 1: block until delivery confirmed (10s timeout)
          await acceptedPromise;
          const phase1Ms = Date.now() - rpcStart;
          this.queue.markAccepted(entry.id);
          log(TAG, `Phase 1 accepted id=${entry.id} (${phase1Ms}ms) — worker releasing`);

          // ★ Phase 2: async — never blocks the worker
          finalPromise.then(result => {
            this.queue.markDelivered(entry.id);
            this.handleEscalationResponse(result, entry, Date.now() - rpcStart);
          }).catch(err => {
            warn(TAG, `Phase 2 failed id=${entry.id}: ${err.message} — entry unblocked`);
            this.queue.markDelivered(entry.id);
            const isPhase2Timeout = /phase2 timeout/i.test(err.message);
            if (isPhase2Timeout) {
              this.stats.consecutivePhase2Timeouts++;
              if (this.stats.consecutivePhase2Timeouts >= 3) {
                const dropped = this.queue.dropAccepted();
                warn(TAG, `⚠ ${this.stats.consecutivePhase2Timeouts} consecutive Phase 2 timeouts — dropped ${dropped} stale accepted entries`);
              }
            } else {
              this.stats.consecutivePhase2Timeouts = 0;
            }
          });

        } catch (phase1Err: any) {
          // Phase 1 failure: real delivery failure → circuit counts it
          const isTimeout = /phase1 timeout|rpc timeout/i.test(phase1Err.message);
          if (isTimeout) {
            this.stats.totalTimeouts++;
            this.stats.consecutiveTimeouts++;
            this.stats.lastTimeoutTs = Date.now();
            this.deps.profiler?.gauge("escalation.totalTimeouts", this.stats.totalTimeouts);
            if (this.stats.consecutiveTimeouts >= 3) {
              warn(TAG, `⚠ ${this.stats.consecutiveTimeouts} consecutive Phase 1 timeouts`);
            }
          }
          warn(TAG, `Phase 1 failed id=${entry.id}: ${phase1Err.message}`);

          const retained = this.queue.markAttemptFailed(entry.id);
          if (retained) {
            const backoff = nextBackoff(entry.attempts);
            if (backoff > 0) {
              setTimeout(() => this.drainQueue(), backoff);
              break;
            }
            // backoff=0: continue loop immediately (first retry)
          }
          // entry dropped (maxRetries): continue loop to process next entry
        }
      }
    } finally {
      this.workerRunning = false;
    }
  }

  /** Process the agent response arriving in Phase 2. */
  private handleEscalationResponse(result: any, entry: QueueEntry, rpcLatencyMs: number): void {
    if (result?.ok && result.payload) {
      const p = result.payload;
      log(TAG, `WS RPC ok → runId=${p.runId}, status=${p.status}, latency=${rpcLatencyMs}ms`);

      this.stats.totalDirectResponses++;
      this.stats.consecutiveTimeouts = 0;
      this.stats.consecutivePhase2Timeouts = 0;
      // EMA α=0.2: smooths latency while reacting to sustained changes
      this.stats.avgResponseMs = this.stats.avgResponseMs === 0
        ? rpcLatencyMs
        : this.stats.avgResponseMs * 0.8 + rpcLatencyMs * 0.2;

      const payloads = p.result?.payloads;
      let responseText = "";
      if (Array.isArray(payloads) && payloads.length > 0) {
        const output = payloads.map((pl: any) => pl.text || "").join("\n").trim();
        responseText = output;
        if (output && !output.startsWith("NO_REPLY")) {
          this.pushResponse(output, this.lastEscalationContext);
        } else {
          this.stats.totalNoReply++;
          this.deps.profiler?.gauge("escalation.totalNoReply", this.stats.totalNoReply);
          log(TAG, output ? `agent returned NO_REPLY as text — silent` : `empty text in ${payloads.length} payloads`);
        }
      } else {
        this.stats.totalNoReply++;
        this.deps.profiler?.gauge("escalation.totalNoReply", this.stats.totalNoReply);
        log(TAG, "agent returned NO_REPLY — silent");
      }

      // Record feedback (async, non-blocking)
      if (entry.feedbackCtx) {
        const { digest, ...ctx } = entry.feedbackCtx;
        this.recordFeedback(ctx, digest, entry.message, responseText, rpcLatencyMs);
      }
    } else if (result && !result.ok) {
      const errDetail = JSON.stringify(result.error || result.payload);
      log(TAG, `agent RPC error: ${errDetail}`);
      this.pushError(errDetail);
      this.stats.totalErrors++;
      this.deps.profiler?.gauge("escalation.errors", this.stats.totalErrors);
    }
  }

  private broadcastTaskEvent(
    taskId: string,
    status: SpawnTaskStatus,
    label?: string,
    startedAt?: number,
    resultPreview?: string,
  ): void {
    const now = Date.now();
    const isTerminal = status === "completed" || status === "failed" || status === "timeout";
    const msg: SpawnTaskMessage = {
      type: "spawn_task",
      taskId,
      label: label || "Background task",
      status,
      startedAt: startedAt || now,
      ...(isTerminal ? { completedAt: now } : {}),
      ...(resultPreview ? { resultPreview: resultPreview.slice(0, 200) } : {}),
    };
    log(TAG, `broadcast spawn_task: taskId=${taskId}, status=${status}, clients=${this.deps.wsHandler.clientCount}`);
    this.deps.wsHandler.broadcastRaw(msg);
  }

  private pushResponse(output: string, context?: ContextWindow | null): void {
    // Allow longer responses for coding contexts
    const { coding } = context ? isCodingContext(context) : { coding: false };
    const maxLen = coding ? 4000 : 3000;

    const text = `[🤖] ${output.trim().slice(0, maxLen)}`;
    this.deps.feedBuffer.push(text, "high", "openclaw", "agent");
    this.deps.wsHandler.broadcast(text, "high", "agent");
    this.stats.totalResponses++;
    this.deps.profiler?.gauge("escalation.totalResponses", this.stats.totalResponses);
    this.stats.lastResponseTs = Date.now();
    log(TAG, `response pushed (coding=${coding}, maxLen=${maxLen}): "${output.slice(0, 80)}..."`);
  }

  private pushError(detail: string): void {
    const text = `[\ud83e\udd16 err] ${detail.slice(0, 500)}`;
    this.deps.feedBuffer.push(text, "normal", "openclaw", "stream");
  }

  /** Record a feedback entry after successful escalation. Safe — never throws. */
  private recordFeedback(
    ctx: { tickId: number; hud: string; currentApp: string; escalationScore: number; escalationReasons: string[]; codingContext: boolean } | undefined,
    digest: string,
    escalationMessage: string,
    openclawResponse: string,
    responseLatencyMs: number,
  ): void {
    if (!ctx || !this.deps.feedbackStore || !this.deps.signalCollector) return;
    try {
      const record = this.deps.feedbackStore.createRecord({
        tickId: ctx.tickId,
        digest,
        hud: ctx.hud,
        currentApp: ctx.currentApp,
        escalationScore: ctx.escalationScore,
        escalationReasons: ctx.escalationReasons,
        codingContext: ctx.codingContext,
        escalationMessage,
        openclawResponse,
        responseLatencyMs,
      });
      this.deps.feedbackStore.append(record);
      this.deps.signalCollector.schedule(record);
    } catch (err: any) {
      warn(TAG, `feedback record failed: ${err.message}`);
    }
  }
}
