import type { AgentEntry, ContextWindow, EscalationConfig, OpenClawConfig, FeedItem, SpawnTaskMessage, SpawnTaskStatus, UserCommand } from "../types.js";
import type { FeedBuffer } from "../buffers/feed-buffer.js";
import type { WsHandler } from "../overlay/ws-handler.js";
import type { Profiler } from "../profiler.js";
import type { FeedbackStore } from "../learning/feedback-store.js";
import type { SignalCollector } from "../learning/signal-collector.js";
import { randomUUID, createHash } from "node:crypto";
import { OpenClawWsClient } from "./openclaw-ws.js";
import { EscalationSlot } from "./escalation-slot.js";
import type { SlotEntry, QueueFeedbackCtx } from "./escalation-slot.js";
import { shouldEscalate, calculateEscalationScore } from "./scorer.js";
import { isCodingContext, buildEscalationMessage, fetchKnowledgeFacts } from "./message-builder.js";
import { loadPendingTasks, savePendingTasks, type PendingTaskEntry } from "../util/task-store.js";
import { log, warn, error } from "../log.js";

export interface HttpPendingEscalation {
  id: string;
  message: string;
  score: number;
  codingContext: boolean;
  ts: number;
  feedbackCtx: QueueFeedbackCtx | undefined;
}

const TAG = "escalation";

export interface EscalatorDeps {
  feedBuffer: FeedBuffer;
  wsHandler: WsHandler;
  escalationConfig: EscalationConfig;
  openclawConfig: OpenClawConfig;
  profiler?: Profiler;
  feedbackStore?: FeedbackStore;
  signalCollector?: SignalCollector;
  queryKnowledgeFacts?: (entities: string[], maxFacts: number) => Promise<string>;
  /** Returns the currently-selected spawn-lane agent from the bare-agent
   *  roster ("" = Off). When a local agent is selected, dispatchSpawnTask
   *  prefers the HTTP bare-agent path over the OpenClaw gateway WS path,
   *  so the overlay's agent-selector choice is respected even when the
   *  gateway is connected. */
  getSpawnAgent?: () => string;
  /** Returns the currently-selected escalation-lane agent. Gateway-typed
   *  profiles (any agent whose `type` is "openclaw" — see isGatewayAgent)
   *  route via WS; any other non-empty value routes to the local bare
   *  agent via HTTP httpPending. */
  getEscalationAgent?: () => string;
  /** Returns true if the named profile is a gateway-style profile
   *  (i.e. dispatched via WS RPC, not invoked as a local CLI). Lookup is
   *  by `agentsCfg.profiles[name].type === "openclaw"`. Custom profiles
   *  like "nemoclaw" or "nanoclaw-prod" with that type get WS dispatch
   *  automatically — the routing key is type, not name. */
  isGatewayAgent?: (name: string) => boolean;
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
  private slot: EscalationSlot;
  private httpPending: HttpPendingEscalation | null = null;

  // Grace window for stale escalation IDs — when analyzer rotates the pending
  // slot mid-response (agent takes 10-30s on MCP flow while ticks fire every
  // 3-6s), the agent's respondHttp(oldId) would fail. Keep last 5 IDs for ~60s
  // so those responses still land on HUD instead of being silently dropped.
  private recentHttpIds: Array<{ id: string; ts: number }> = [];
  private static readonly STALE_ID_GRACE_MS = 60_000;
  private static readonly STALE_ID_BUFFER_SIZE = 5;

  private lastEscalationTs = 0;
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

  // Knowledge enrichment is skipped on the very first escalation per process
  // to avoid the 5s fetchKnowledgeFacts() cold-start tax on user-perceived
  // first-response latency. Each subsequent escalation does its own fetch
  // independently — no cross-escalation cache, no shared content state.
  private firstEscalationDone = false;

  // User command to inject into the next escalation
  private pendingUserCommand: UserCommand | null = null;
  private static readonly USER_COMMAND_EXPIRY_MS = 120_000; // 2 minutes

  // HTTP spawn queue — for bare agents that poll (mirrors httpPending for escalation)
  private spawnHttpPending: { id: string; task: string; label: string; ts: number } | null = null;

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
    lastTimeoutTs: 0,
  };

  private outboundBytes = 0;

  constructor(private deps: EscalatorDeps) {
    this.wsClient = new OpenClawWsClient(deps.openclawConfig);
    this.slot = new EscalationSlot(this.wsClient, deps.openclawConfig, {
      onResponse: (result, entry, latencyMs) => this.handleEscalationResponse(result, entry, latencyMs),
      onPhase1Failure: (isTimeout) => {
        if (isTimeout) {
          this.stats.totalTimeouts++;
          this.stats.consecutiveTimeouts++;
          this.stats.lastTimeoutTs = Date.now();
          this.deps.profiler?.gauge("escalation.totalTimeouts", this.stats.totalTimeouts);
          if (this.stats.consecutiveTimeouts >= 3) {
            warn(TAG, `⚠ ${this.stats.consecutiveTimeouts} consecutive Phase 1 timeouts`);
          }
        }
      },
      onOutboundBytes: (n) => {
        this.outboundBytes += n;
        this.deps.profiler?.gauge("network.escalationOutBytes", this.outboundBytes);
      },
    });
    // Load pending tasks from disk (crash recovery)
    this.pendingSpawnTasks = loadPendingTasks();
    // Attempt delivery on every WS reconnect
    this.wsClient.on("connected", () => this.slot.onConnected());
  }

  /** Late-bind the signal collector (created after AgentLoop). */
  setSignalCollector(sc: SignalCollector): void {
    this.deps.signalCollector = sc;
  }

  /** Queue a user command to inject into the next escalation. */
  setUserCommand(text: string, source: "text" | "voice" = "text"): void {
    this.pendingUserCommand = { text, ts: Date.now(), source };
    const preview = text.length > 60 ? text.slice(0, 60) + "…" : text;
    this.deps.feedBuffer.push(`⌘ Command queued: ${preview}`, "normal", "system", "stream");
    this.deps.wsHandler.broadcast(`⌘ Command queued: ${preview}`, "normal");
    log(TAG, `user command set: "${preview}"`);
  }

  /** True iff a gateway-typed profile is the active agent on at least one
   *  lane. WS-bearing operations (connect, reset, situation push) are gated
   *  on this so a user with a configured-but-unselected gateway pays no
   *  reconnect tax. */
  private isGatewayLaneSelected(): boolean {
    const isGw = this.deps.isGatewayAgent;
    if (!isGw) return false;
    const esc = this.deps.getEscalationAgent?.() ?? "";
    const spawn = this.deps.getSpawnAgent?.() ?? "";
    return isGw(esc) || isGw(spawn);
  }

  /** Public predicate so the agent loop / index.ts can ask "should I do
   *  openclaw-only side-effects on this tick?" without depending on the
   *  internals. Mirrors isGatewayLaneSelected. */
  shouldDriveGateway(): boolean {
    const wsConfigured = !!this.deps.openclawConfig.gatewayWsUrl;
    return wsConfigured && this.isGatewayLaneSelected();
  }

  /** Start the WS connection to OpenClaw.
   *
   * Connects whenever the gateway URL is configured AND a gateway-typed
   * profile is selected on a lane AND escalation isn't fully off. WS is
   * the transport for the openclaw lane — the user selects it via the
   * overlay's agent picker, and dispatch routes accordingly. Removing the
   * openclaw profile from agents.json (and unsetting the env vars) leaves
   * gatewayWsUrl empty → no connect attempt. Likewise, if the profile
   * exists but no lane selects it, no connect attempt.
   */
  start(): void {
    if (this.deps.escalationConfig.mode !== "off" && this.shouldDriveGateway()) {
      this.wsClient.connect();
      const tokenHash = this.deps.openclawConfig.gatewayToken
        ? createHash("sha256").update(this.deps.openclawConfig.gatewayToken).digest("hex").slice(0, 12)
        : "none";
      log(TAG, `mode: ${this.deps.escalationConfig.mode}, tokenHash: ${tokenHash}, wsUrl: ${this.deps.openclawConfig.gatewayWsUrl}`);
    }
  }

  /** Stop and disconnect. */
  stop(): void {
    this.wsClient.disconnect();
  }

  /** Re-evaluate WS lifecycle after lane selection changes. Connects when a
   *  gateway lane just got selected; disconnects when the user moved off
   *  every gateway lane. Called from the set_agent overlay handler. */
  evaluateGatewayLifecycle(): void {
    const shouldConnect =
      this.deps.escalationConfig.mode !== "off" && this.shouldDriveGateway();
    if (shouldConnect && !this.wsClient.isConnected) {
      log(TAG, "lane switched to gateway — connecting WS");
      this.wsClient.resetConnection();
    } else if (!shouldConnect && this.wsClient.isConnected) {
      log(TAG, "lane switched off gateway — disconnecting WS");
      this.wsClient.disconnect();
    }
  }

  /** Update escalation mode at runtime. */
  setMode(mode: EscalatorDeps["escalationConfig"]["mode"]): void {
    const wasOff = this.deps.escalationConfig.mode === "off";
    this.deps.escalationConfig.mode = mode;
    if (mode !== "off" && !this.wsClient.isConnected && this.shouldDriveGateway()) {
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
  async onAgentAnalysis(entry: AgentEntry, contextWindow: ContextWindow): Promise<void> {
    // Expire stale user commands (safety net — 120s is generous)
    if (this.pendingUserCommand && Date.now() - this.pendingUserCommand.ts > Escalator.USER_COMMAND_EXPIRY_MS) {
      warn(TAG, `user command expired after ${Escalator.USER_COMMAND_EXPIRY_MS / 1000}s — no escalation occurred`);
      this.deps.feedBuffer.push("⚠ Command expired — no escalation occurred", "normal", "system", "stream");
      this.deps.wsHandler.broadcast("⚠ Command expired — no escalation occurred", "normal");
      this.pendingUserCommand = null;
    }

    // Early skip when circuit is open AND the user has selected openclaw —
    // saves the cost of building the escalation message just to drop it.
    // Local-agent lanes (claude, openclaude, etc.) bypass this since they
    // route via HTTP and don't depend on WS.
    if (this.wsClient.isCircuitOpen) {
      const escalationAgent = this.deps.getEscalationAgent?.() || "";
      if (this.deps.isGatewayAgent?.(escalationAgent)) {
        log(TAG, `tick #${entry.id}: skipped — circuit breaker open and gateway agent "${escalationAgent}" selected`);
        return;
      }
    }

    // If user command is pending, force escalation (bypass score + cooldown)
    const hasUserCommand = this.pendingUserCommand !== null;

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

    if (!escalate && !hasUserCommand) {
      log(TAG, `tick #${entry.id}: not escalating (mode=${this.deps.escalationConfig.mode}, score=${score.total}, hud="${entry.hud.slice(0, 40)}")`);
      return;
    }

    // Mark cooldown immediately
    this.stats.totalEscalations++;
    this.deps.profiler?.gauge("escalation.totalEscalations", this.stats.totalEscalations);
    this.lastEscalationTs = Date.now();
    this.stats.lastEscalationTs = Date.now();
    this.lastEscalatedDigest = entry.digest;

    const staleTag = stale ? ", STALE" : "";
    const cmdTag = hasUserCommand ? ", USER_CMD" : "";
    const wsState = this.wsClient.isConnected ? "ws=connected" : "ws=disconnected";
    log(TAG, `escalating tick #${entry.id} (score=${score.total}, reasons=[${score.reasons.join(",")}]${staleTag}${cmdTag}, ${wsState})`);

    // Store context for response handling (used in pushResponse for coding-context max-length)
    this.lastEscalationContext = contextWindow;

    const escalationReason = hasUserCommand
      ? `user_command: ${this.pendingUserCommand!.text.slice(0, 80)}`
      : score.reasons.join(", ");
    let message = buildEscalationMessage(
      entry.digest,
      contextWindow,
      entry,
      this.deps.escalationConfig.mode,
      escalationReason,
      undefined,
      this.pendingUserCommand ?? undefined,
      this.deps.wsHandler.getState().responseSize ?? "medium",
    );

    // Clear user command after building the message (consumed once)
    this.pendingUserCommand = null;

    // Enrich with long-term knowledge facts (best-effort, 5s max).
    // Skipped on the inaugural escalation per process to eliminate cold-start
    // latency — the user's first response shouldn't wait for KG warmup.
    if (this.deps.queryKnowledgeFacts && this.firstEscalationDone) {
      try {
        const knowledgeSection = await fetchKnowledgeFacts(
          contextWindow, entry.digest, this.deps.queryKnowledgeFacts,
        );
        if (knowledgeSection) {
          message = message + "\n\n" + knowledgeSection;
          log(TAG, `knowledge enrichment injected (${knowledgeSection.length} chars)`);
        }
      } catch (err) {
        log(TAG, `knowledge enrichment failed: ${String(err)}`);
      }
    } else if (!this.firstEscalationDone) {
      log(TAG, `first escalation: skipping knowledge fetch (fast path)`);
    }
    this.firstEscalationDone = true;

    const slotId = createHash("sha256").update(this.deps.openclawConfig.sessionKey + entry.ts).digest("hex").slice(0, 16);
    const slotEntry: SlotEntry = {
      id: slotId,
      message,
      sessionKey: this.deps.openclawConfig.sessionKey,
      feedbackCtx: {
        tickId: entry.id,
        hud: entry.hud,
        currentApp: contextWindow.currentApp,
        escalationScore: score.total,
        escalationReasons: score.reasons,
        codingContext: isCodingContext(contextWindow).coding,
        digest: entry.digest,
      },
      ts: entry.ts,
    };

    // Per-lane dispatch: agent identity *is* the transport.
    //   - profile.type === "openclaw" (gateway-style) → WS dispatch
    //   - any other non-empty agent (local CLI: claude, openclaude, ...) → HTTP
    //   - empty (Off) → escalator.setMode("off") should have stopped us
    //     upstream; defensive bailout.
    //
    // Routing keys off the profile's `type` field, not its name, so custom
    // gateway profiles like "nemoclaw" or "nanoclaw-prod" route via WS
    // automatically as long as they declare `type: "openclaw"` in agents.json.
    //
    // openclaw + WS-disconnected drops with a toast (no HTTP fallback),
    // because the bare agent can't run a gateway profile as a local CLI —
    // the fallback caused infinite skip loops historically.
    const escalationAgent = this.deps.getEscalationAgent?.() || "";
    const isGateway = this.deps.isGatewayAgent?.(escalationAgent) ?? false;
    let useHttp: boolean;
    if (isGateway) {
      if (!this.wsClient.isConnected) {
        log(TAG, `escalation dropped: gateway agent "${escalationAgent}" selected but WS disconnected`);
        this.deps.wsHandler.broadcast(
          `⚠ Gateway disconnected — escalation dropped. Pick a local agent or check the ${escalationAgent} gateway.`,
          "high",
        );
        return;
      }
      useHttp = false;
    } else if (escalationAgent) {
      useHttp = true;
    } else {
      log(TAG, `escalation dropped: lane is Off (escalationAgent="")`);
      return;
    }

    if (useHttp) {
      // Remember the outgoing ID before overwriting so late-arriving responses
      // still find a valid match in respondHttp's grace window.
      if (this.httpPending) {
        this.recentHttpIds.push({ id: this.httpPending.id, ts: this.httpPending.ts });
        if (this.recentHttpIds.length > Escalator.STALE_ID_BUFFER_SIZE) {
          this.recentHttpIds.shift();
        }
      }
      // Store in HTTP pending slot (newest wins, like EscalationSlot)
      this.httpPending = {
        id: slotId,
        message,
        score: score.total,
        codingContext: isCodingContext(contextWindow).coding,
        ts: entry.ts,
        feedbackCtx: slotEntry.feedbackCtx,
      };
      log(TAG, `tick #${entry.id} → httpPending id=${slotId} (lane=${escalationAgent || "<default>"})`);
    } else {
      log(TAG, `tick #${entry.id} → slot.insert id=${slotId} depth=${this.slot.depth}`);
      this.slot.insert(slotEntry);
    }
  }

  /** Redispatch a stale httpPending escalation through the WS slot.
   *
   * Called by index.ts when the escalation lane flips to a gateway-typed
   * agent (e.g., openclaude → openclaw): an escalation queued for HTTP
   * before the switch is now mis-routed. Rather than letting the bare
   * agent skip it (which posts a confusing "[skipped: gateway-routed]"
   * to the user's HUD), we move it into the WS slot so the gateway
   * actually handles the user's pending question.
   *
   * If WS isn't connected, silently clear httpPending — the agent loop
   * will produce a new escalation through the proper drop-with-toast
   * path on the next tick. Better than the user seeing the skip message
   * AND the gateway-disconnect toast for the same logical event.
   *
   * Returns true if a redispatch (or clear) actually happened, so the
   * caller can log meaningfully.
   */
  redispatchHttpPendingToWs(): boolean {
    if (!this.httpPending) return false;
    const stale = this.httpPending;
    this.httpPending = null;
    if (!this.wsClient.isConnected) {
      log(TAG, `redispatch skipped: WS not connected — cleared stale httpPending id=${stale.id}`);
      return true;
    }
    const slotEntry: SlotEntry = {
      id: stale.id,
      message: stale.message,
      sessionKey: this.deps.openclawConfig.sessionKey,
      feedbackCtx: stale.feedbackCtx,
      ts: stale.ts,
    };
    log(TAG, `redispatching stale httpPending id=${stale.id} → WS slot (lane switched to gateway)`);
    this.slot.insert(slotEntry);
    return true;
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

  /** Return the current HTTP pending escalation (or null). */
  getPendingHttp(): HttpPendingEscalation | null {
    return this.httpPending;
  }

  /** Respond to an HTTP pending escalation. */
  respondHttp(id: string, response: string): { ok: boolean; error?: string } {
    // Grace path: the agent's response arrived for a stale ID because the
    // analyzer rotated the pending slot mid-flight. Still push to HUD — the
    // response was written against context that was fresh seconds ago and is
    // almost certainly still relevant — but don't clear the current pending,
    // so the agent can still address the newer escalation on its next poll.
    if (!this.httpPending || this.httpPending.id !== id) {
      const recent = this.recentHttpIds.find((e) => e.id === id);
      if (recent && Date.now() - recent.ts < Escalator.STALE_ID_GRACE_MS) {
        // Grace path: response was generated against a context that's now
        // stale (analyzer rotated the slot mid-flight) but still recent
        // enough that the answer is almost certainly still relevant.
        // Push to HUD and return a clean ok=true — don't surface the
        // grace marker on the wire, because generic LLM clients read
        // any non-empty `error` field as a failure signal and write
        // apologetic meta-messages to the user. The breadcrumb stays
        // in this log for debug.
        log(TAG, `respondHttp grace: id=${id} is stale (rotated ${((Date.now() - recent.ts) / 1000).toFixed(1)}s ago) — pushing to HUD anyway`);
        this.pushResponse(response, this.lastEscalationContext);
        return { ok: true };
      }
      return this.httpPending
        ? { ok: false, error: `id mismatch: expected ${this.httpPending.id}` }
        : { ok: false, error: "no pending escalation" };
    }

    this.pushResponse(response, this.lastEscalationContext);

    // Record feedback (async, non-blocking)
    if (this.httpPending.feedbackCtx) {
      const { digest, ...ctx } = this.httpPending.feedbackCtx;
      this.recordFeedback(ctx, digest, this.httpPending.message, response, Date.now() - this.httpPending.ts);
    }

    log(TAG, `httpPending id=${id} responded (${response.length} chars)`);
    this.httpPending = null;
    return { ok: true };
  }

  /** Return the current HTTP pending spawn task (or null). */
  getSpawnPending(): { id: string; task: string; label: string; ts: number } | null {
    return this.spawnHttpPending;
  }

  /** Respond to a pending spawn task from a bare agent. */
  respondSpawn(id: string, result: string): { ok: boolean; error?: string } {
    if (!this.spawnHttpPending) {
      return { ok: false, error: "no pending spawn task" };
    }
    if (this.spawnHttpPending.id !== id) {
      return { ok: false, error: `id mismatch: expected ${this.spawnHttpPending.id}` };
    }

    const label = this.spawnHttpPending.label;
    const startedAt = this.spawnHttpPending.ts;

    // Push result to HUD feed
    const maxLen = 3000;
    const text = `[🔧 ${label}] ${result.trim().slice(0, maxLen)}`;
    this.deps.feedBuffer.push(text, "high", "openclaw", "agent");
    this.deps.wsHandler.broadcast(text, "high", "agent");

    // Broadcast completion
    this.broadcastTaskEvent(id, "completed", label, startedAt, result.slice(0, 200));

    log(TAG, `spawn ${id} responded (${result.length} chars)`);
    this.spawnHttpPending = null;
    return { ok: true };
  }

  /** Whether the gateway WS client is currently connected. */
  get isGatewayConnected(): boolean {
    return this.wsClient.isConnected;
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
      slotDepth: this.slot.depth,
      slotInFlight: this.slot.inFlightId,
      httpPendingId: this.httpPending?.id ?? null,
      spawnInFlight: this.spawnInFlight,
      cooldownMs: this.deps.escalationConfig.cooldownMs,
      staleMs: this.deps.escalationConfig.staleMs,
      pendingSpawnTasks: this.pendingSpawnTasks.size,
      pendingUserCommand: this.pendingUserCommand ? this.pendingUserCommand.text.slice(0, 80) : null,
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

    this.outboundBytes += Buffer.byteLength(task);
    this.deps.profiler?.gauge("network.escalationOutBytes", this.outboundBytes);
    log(TAG, `dispatching spawn-task${labelStr} → child=${childSessionKey}: "${task.slice(0, 80)}..."`);

    // ★ Broadcast "spawned" BEFORE the RPC — TSK tab shows ··· immediately
    this.broadcastTaskEvent(taskId, "spawned", label, startedAt);

    // Route explicitly by the overlay's spawn-agent selection:
    //   "openclaw" (or "" with WS connected) → send to remote gateway via WS RPC
    //   any other non-empty value             → queue for local bare agent HTTP poll
    //   "" with WS disconnected               → queue for HTTP fallback (same)
    // This makes the overlay's choice authoritative. Before openclaw was a
    // roster option, the old heuristic "if WS connected, use gateway" hijacked
    // every spawn regardless of user intent, which surfaced as 401/credential
    // errors from the gateway's stale OpenRouter key.
    // Per-lane dispatch (mirror of escalation routing above):
    //   - profile.type === "openclaw" → WS to gateway (drop with toast if
    //     WS down — bare agent can't run gateway profiles as local CLIs)
    //   - any other non-empty agent → HTTP queue for bare agent polling
    //   - empty (Off) → drop; the spawn poll skip in run.sh should already
    //     prevent us from getting here.
    const spawnAgent = this.deps.getSpawnAgent?.() || "";
    const spawnIsGateway = this.deps.isGatewayAgent?.(spawnAgent) ?? false;
    if (spawnIsGateway) {
      if (!this.wsClient.isConnected) {
        log(TAG, `spawn-task ${taskId}: dropped — gateway agent "${spawnAgent}" selected but WS disconnected`);
        this.deps.wsHandler.broadcast(
          `⚠ Gateway disconnected — spawn task dropped. Pick a local agent or check the ${spawnAgent} gateway.`,
          "high",
        );
        return;
      }
      // Fall through to gateway dispatch below.
    } else if (spawnAgent) {
      // Local bare-agent path: queue for polling.
      this.spawnHttpPending = { id: taskId, task, label: label || "background-task", ts: startedAt };
      const preview = task.length > 60 ? task.slice(0, 60) + "…" : task;
      this.deps.feedBuffer.push(`🔧 Task queued for agent: ${preview}`, "normal", "system", "stream");
      this.deps.wsHandler.broadcast(`🔧 Task queued for agent: ${preview}`, "normal");
      log(TAG, `spawn-task ${taskId}: queued for bare agent (lane=${spawnAgent})`);
      return;
    } else {
      log(TAG, `spawn-task ${taskId}: dropped — lane is Off (spawnAgent="")`);
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
        extraSystemPrompt: await this.buildChildSystemPrompt(task, label),
        deliver: false,
        idempotencyKey: idemKey,
        label: label || undefined,
      }, 10 * 60_000, { expectFinal: true });

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

  /** Build a focused system prompt for the child subagent, enriched with knowledge. */
  private async buildChildSystemPrompt(task: string, label?: string): Promise<string> {
    // Fetch relevant knowledge facts (same enrichment as escalations)
    let knowledgeSection = "";
    if (this.deps.queryKnowledgeFacts) {
      try {
        const entities: string[] = [];
        // Extract keywords from task text for entity matching
        const techKeywords = [
          "react-native", "react", "flutter", "swift", "kotlin", "python",
          "typescript", "node", "docker", "sinain", "openclaw", "overlay",
          "sense", "audio", "transcription", "escalation", "knowledge",
        ];
        const lower = task.toLowerCase();
        for (const kw of techKeywords) {
          if (lower.includes(kw)) entities.push(kw);
        }
        // Also extract capitalized proper nouns (file names, project names)
        const nouns = task.match(/\b[A-Z][a-z]{2,}\b/g);
        if (nouns) entities.push(...nouns.map(n => n.toLowerCase()).slice(0, 3));

        if (entities.length > 0) {
          const facts = await this.deps.queryKnowledgeFacts(entities.slice(0, 5), 5);
          if (facts && facts.trim().length > 20) {
            knowledgeSection = `\n## Relevant Knowledge\n${facts.trim()}`;
          }
        }
      } catch (err) {
        log(TAG, `spawn knowledge enrichment failed: ${String(err)}`);
      }
    }

    // Include latest digest for screen/audio context
    const latestDigest = this.deps.feedBuffer.latest()?.text;
    const contextSection = latestDigest
      ? `\n## Current User Context\n${latestDigest.slice(0, 500)}`
      : "";

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
      label ? `\nLabel: ${label}` : "",
      knowledgeSection,
      contextSection,
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

    const pollIntervalMs = 5000; // 5 seconds

    const poll = async (): Promise<void> => {

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

  /** Process the agent response arriving in Phase 2 (called by EscalationSlot callback). */
  private handleEscalationResponse(result: any, entry: SlotEntry, rpcLatencyMs: number): void {
    if (result?.ok && result.payload) {
      const p = result.payload;
      log(TAG, `WS RPC ok → runId=${p.runId}, status=${p.status}, latency=${rpcLatencyMs}ms`);

      this.stats.totalDirectResponses++;
      this.stats.consecutiveTimeouts = 0;
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
