import { EventEmitter } from "node:events";
import type { FeedBuffer } from "../buffers/feed-buffer.js";
import type { SenseBuffer } from "../buffers/sense-buffer.js";
import type { AgentConfig, AgentEntry, ContextWindow, EscalationMode, ContextRichness, RecorderStatus } from "../types.js";
import { buildContextWindow } from "./context-window.js";
import { analyzeContext } from "./analyzer.js";
import { writeSituationMd } from "./situation-writer.js";
import { log, warn, error } from "../log.js";

const TAG = "agent";

export interface AgentLoopDeps {
  feedBuffer: FeedBuffer;
  senseBuffer: SenseBuffer;
  agentConfig: AgentConfig;
  escalationMode: EscalationMode;
  situationMdPath: string;
  /** Called after analysis with digest + context for escalation check. */
  onAnalysis: (entry: AgentEntry, contextWindow: ContextWindow) => void;
  /** Called to broadcast HUD line to overlay. */
  onHudUpdate: (text: string) => void;
  /** Optional: tracer to record spans. */
  onTraceStart?: (tickId: number) => TraceContext | null;
  /** Optional: get current recorder status for prompt injection. */
  getRecorderStatus?: () => RecorderStatus | null;
}

export interface TraceContext {
  startSpan(name: string): void;
  endSpan(attrs?: Record<string, unknown>): void;
  finish(metrics: Record<string, unknown>): void;
}

/** Map escalation mode to context richness. */
function modeToRichness(mode: EscalationMode): ContextRichness {
  switch (mode) {
    case "selective": return "lean";
    case "focus": return "standard";
    case "rich": return "rich";
    default: return "standard";
  }
}

/**
 * Event-driven agent analysis loop.
 *
 * Replaces relay's setInterval(agentTick, 30000) + debounce with:
 *   - context:sense or context:audio event → debounce 3s → run analysis
 *   - Max interval 30s (forced tick if no events)
 *   - Cooldown 10s (don't re-analyze within 10s of last run)
 *
 * This cuts worst-case latency from ~60s to ~15s.
 */
export class AgentLoop extends EventEmitter {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxIntervalTimer: ReturnType<typeof setInterval> | null = null;
  private lastRunTs = 0;
  private running = false;
  private started = false;

  private lastPushedHud = "";
  private agentNextId = 1;
  private agentBuffer: AgentEntry[] = [];
  private latestDigest: AgentEntry | null = null;
  private lastTickFeedVersion = 0;
  private lastTickSenseVersion = 0;

  private stats = {
    totalCalls: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    lastAnalysisTs: 0,
    idleSkips: 0,
    parseSuccesses: 0,
    parseFailures: 0,
    consecutiveIdenticalHud: 0,
    hudChanges: 0,
  };

  constructor(private deps: AgentLoopDeps) {
    super();
  }

  /** Start the agent loop. */
  start(): void {
    if (this.started) return;
    if (!this.deps.agentConfig.enabled || !this.deps.agentConfig.openrouterApiKey) {
      if (this.deps.agentConfig.enabled) {
        warn(TAG, "AGENT_ENABLED=true but OPENROUTER_API_KEY not set \u2014 agent disabled");
      }
      return;
    }

    this.started = true;
    // Max interval: forced tick every maxIntervalMs even if no events
    this.maxIntervalTimer = setInterval(() => {
      if (!this.debounceTimer) {
        this.run().catch(err => error(TAG, "max-interval tick error:", err.message));
      }
    }, this.deps.agentConfig.maxIntervalMs);

    log(TAG, `loop started (debounce=${this.deps.agentConfig.debounceMs}ms, max=${this.deps.agentConfig.maxIntervalMs}ms, cooldown=${this.deps.agentConfig.cooldownMs}ms, model=${this.deps.agentConfig.model})`);
  }

  /** Stop the agent loop. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.maxIntervalTimer) { clearInterval(this.maxIntervalTimer); this.maxIntervalTimer = null; }
    log(TAG, "loop stopped");
  }

  /**
   * Signal that new context is available.
   * Called by sense POST handler and transcription callback.
   * Triggers debounced analysis.
   */
  onNewContext(): void {
    if (!this.started) return;

    // Debounce: wait N ms after last event before running
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.run().catch(err => error(TAG, "debounce tick error:", err.message));
    }, this.deps.agentConfig.debounceMs);
  }

  /** Get agent results history (newest first). */
  getHistory(limit = 10): AgentEntry[] {
    return this.agentBuffer.slice(-limit).reverse();
  }

  /** Get latest digest. */
  getDigest(): AgentEntry | null {
    return this.latestDigest;
  }

  /** Get context window for debugging. */
  getContext(): ContextWindow {
    const richness = modeToRichness(this.deps.escalationMode);
    return buildContextWindow(
      this.deps.feedBuffer,
      this.deps.senseBuffer,
      richness,
      this.deps.agentConfig.maxAgeMs,
    );
  }

  /** Get config (safe — no API key). */
  getConfig(): Record<string, unknown> {
    const { openrouterApiKey, ...safe } = this.deps.agentConfig;
    return { ...safe, hasApiKey: !!openrouterApiKey, escalationMode: this.deps.escalationMode };
  }

  /** Get stats for /health. */
  getStats(): Record<string, unknown> {
    const costPerToken = { in: 0.075 / 1_000_000, out: 0.3 / 1_000_000 };
    const estimatedCost =
      this.stats.totalTokensIn * costPerToken.in +
      this.stats.totalTokensOut * costPerToken.out;

    return {
      enabled: this.deps.agentConfig.enabled,
      lastAnalysis: this.stats.lastAnalysisTs || null,
      lastDigest: this.latestDigest?.digest?.slice(0, 200) || null,
      totalCalls: this.stats.totalCalls,
      totalTokens: { in: this.stats.totalTokensIn, out: this.stats.totalTokensOut },
      estimatedCost: Math.round(estimatedCost * 1000000) / 1000000,
      model: this.deps.agentConfig.model,
      idleSkips: this.stats.idleSkips,
      parseSuccessRate: this.stats.parseSuccesses + this.stats.parseFailures > 0
        ? Math.round((this.stats.parseSuccesses / (this.stats.parseSuccesses + this.stats.parseFailures)) * 100)
        : null,
      hudChangeRate: this.stats.hudChanges,
      consecutiveIdenticalHud: this.stats.consecutiveIdenticalHud,
      debounceMs: this.deps.agentConfig.debounceMs,
      fallbackModels: this.deps.agentConfig.fallbackModels,
    };
  }

  /** Update config at runtime. */
  updateConfig(updates: Record<string, unknown>): void {
    const c = this.deps.agentConfig;
    if (updates.enabled !== undefined) c.enabled = !!updates.enabled;
    if (updates.model !== undefined) c.model = String(updates.model);
    if (updates.maxTokens !== undefined) c.maxTokens = Math.max(100, parseInt(String(updates.maxTokens)));
    if (updates.temperature !== undefined) c.temperature = parseFloat(String(updates.temperature));
    if (updates.pushToFeed !== undefined) c.pushToFeed = !!updates.pushToFeed;
    if (updates.debounceMs !== undefined) c.debounceMs = Math.max(1000, parseInt(String(updates.debounceMs)));
    if (updates.maxIntervalMs !== undefined) c.maxIntervalMs = Math.max(5000, parseInt(String(updates.maxIntervalMs)));
    if (updates.cooldownMs !== undefined) c.cooldownMs = Math.max(3000, parseInt(String(updates.cooldownMs)));
    if (updates.fallbackModels !== undefined) c.fallbackModels = Array.isArray(updates.fallbackModels) ? updates.fallbackModels : [];
    if (updates.openrouterApiKey !== undefined) c.openrouterApiKey = String(updates.openrouterApiKey);

    // Restart loop if needed
    if (c.enabled && c.openrouterApiKey) {
      if (!this.started) this.start();
      else {
        // Reset max interval timer with new config
        this.stop();
        this.start();
      }
    } else {
      this.stop();
    }
  }

  // ── Private: run a single analysis tick ──

  private async run(): Promise<void> {
    if (this.running) return;
    if (!this.deps.agentConfig.openrouterApiKey) return;

    // Cooldown: don't re-analyze within cooldownMs of last run
    if (Date.now() - this.lastRunTs < this.deps.agentConfig.cooldownMs) return;

    // Idle suppression: skip if no new events since last tick
    const { feedBuffer, senseBuffer } = this.deps;
    if (feedBuffer.version === this.lastTickFeedVersion &&
        senseBuffer.version === this.lastTickSenseVersion) {
      this.stats.idleSkips++;
      return;
    }
    this.lastTickFeedVersion = feedBuffer.version;
    this.lastTickSenseVersion = senseBuffer.version;

    const richness = modeToRichness(this.deps.escalationMode);
    const contextWindow = buildContextWindow(
      feedBuffer, senseBuffer, richness, this.deps.agentConfig.maxAgeMs,
    );

    // Skip if both buffers empty in window
    if (contextWindow.audioCount === 0 && contextWindow.screenCount === 0) {
      this.stats.idleSkips++;
      return;
    }

    this.running = true;
    const traceCtx = this.deps.onTraceStart?.(this.agentNextId) ?? null;

    try {
      traceCtx?.startSpan("context-window");
      traceCtx?.endSpan({ richness, screenEvents: contextWindow.screenCount, audioEntries: contextWindow.audioCount });

      traceCtx?.startSpan("llm-call");
      const recorderStatus = this.deps.getRecorderStatus?.() ?? null;
      const result = await analyzeContext(contextWindow, this.deps.agentConfig, recorderStatus);
      traceCtx?.endSpan({ model: result.model, tokensIn: result.tokensIn, tokensOut: result.tokensOut, latencyMs: result.latencyMs });

      const { hud, digest, latencyMs, tokensIn, tokensOut, model: usedModel, parsedOk } = result;

      // Track context freshness
      const contextFreshness = contextWindow.newestEventTs
        ? Date.now() - contextWindow.newestEventTs
        : null;

      // Track HUD staleness
      if (hud === this.lastPushedHud) {
        this.stats.consecutiveIdenticalHud++;
      } else {
        this.stats.consecutiveIdenticalHud = 0;
        this.stats.hudChanges++;
      }

      // Update stats
      this.stats.totalCalls++;
      this.stats.totalTokensIn += tokensIn;
      this.stats.totalTokensOut += tokensOut;
      this.stats.lastAnalysisTs = Date.now();
      if (parsedOk) this.stats.parseSuccesses++;
      else this.stats.parseFailures++;

      // Build entry
      const entry: AgentEntry = {
        ...result,
        id: this.agentNextId++,
        ts: Date.now(),
        pushed: false,
        contextFreshnessMs: contextFreshness,
        context: {
          currentApp: contextWindow.currentApp,
          appHistory: contextWindow.appHistory.map(a => a.app),
          audioCount: contextWindow.audioCount,
          screenCount: contextWindow.screenCount,
        },
      };
      this.agentBuffer.push(entry);
      if (this.agentBuffer.length > 50) this.agentBuffer.shift();

      log(TAG, `#${entry.id} (${latencyMs}ms, ${tokensIn}+${tokensOut}tok, model=${usedModel}) hud="${hud}"`);

      // Push HUD line to feed (suppress "—", "Idle", and all in focus mode)
      if (this.deps.agentConfig.pushToFeed &&
          this.deps.escalationMode !== "focus" &&
          hud !== "\u2014" && hud !== "Idle" && hud !== this.lastPushedHud) {
        feedBuffer.push(`[\ud83e\udde0] ${hud}`, "normal", "agent", "stream");
        this.deps.onHudUpdate(`[\ud83e\udde0] ${hud}`);
        this.lastPushedHud = hud;
        entry.pushed = true;
      }

      // Store digest
      this.latestDigest = entry;

      // Write SITUATION.md
      writeSituationMd(this.deps.situationMdPath, contextWindow, digest, entry);

      // Notify for escalation check
      traceCtx?.startSpan("escalation-check");
      this.deps.onAnalysis(entry, contextWindow);
      traceCtx?.endSpan();

      // Finish trace
      const costPerToken = { in: 0.075 / 1_000_000, out: 0.3 / 1_000_000 };
      traceCtx?.finish({
        totalLatencyMs: Date.now() - entry.ts + latencyMs,
        llmLatencyMs: latencyMs,
        llmInputTokens: tokensIn,
        llmOutputTokens: tokensOut,
        llmCost: tokensIn * costPerToken.in + tokensOut * costPerToken.out,
        escalated: false, // Updated by escalator
        escalationScore: 0,
        contextScreenEvents: contextWindow.screenCount,
        contextAudioEntries: contextWindow.audioCount,
        contextRichness: richness,
        digestLength: digest.length,
        hudChanged: entry.pushed,
      });

    } catch (err: any) {
      error(TAG, "tick error:", err.message || err);
      traceCtx?.endSpan({ status: "error", error: err.message });
      traceCtx?.finish({ totalLatencyMs: Date.now() - Date.now(), llmLatencyMs: 0, llmInputTokens: 0, llmOutputTokens: 0, llmCost: 0, escalated: false, escalationScore: 0, contextScreenEvents: 0, contextAudioEntries: 0, contextRichness: richness, digestLength: 0, hudChanged: false });
    } finally {
      this.running = false;
      this.lastRunTs = Date.now();
    }
  }
}
