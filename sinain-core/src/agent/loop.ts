import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { FeedBuffer } from "../buffers/feed-buffer.js";
import type { SenseBuffer } from "../buffers/sense-buffer.js";
import type { AnalysisConfig, AgentEntry, ContextWindow, EscalationMode, ContextRichness, RecorderStatus, SenseEvent, FeedbackRecord } from "../types.js";
import type { Profiler } from "../profiler.js";
import type { CostTracker } from "../cost/tracker.js";
import { buildContextWindow, RICHNESS_PRESETS } from "./context-window.js";
import { analyzeContext } from "./analyzer.js";
import { writeSituationMd } from "./situation-writer.js";
import { calculateEscalationScore } from "../escalation/scorer.js";
import { log, warn, error, debug } from "../log.js";
import type { TraitEngine, TraitSelection } from "./traits.js";
import { writeTraitLog } from "./traits.js";

const TAG = "agent";

export interface AgentLoopDeps {
  feedBuffer: FeedBuffer;
  senseBuffer: SenseBuffer;
  agentConfig: AnalysisConfig;
  escalationMode: EscalationMode;
  situationMdPath: string;
  /** Called after analysis with digest + context for escalation check. */
  onAnalysis: (entry: AgentEntry, contextWindow: ContextWindow) => void;
  /** Called to broadcast HUD line to overlay. */
  onHudUpdate: (text: string) => void;
  /** Called when agent identifies actionable screen regions (Grammarly mode). */
  onRegionHighlight?: (regions: Array<{ issue: string; tip: string; action?: string }>) => void;
  /** Optional: tracer to record spans. */
  onTraceStart?: (tickId: number) => TraceContext | null;
  /** Optional: get current recorder status for prompt injection. */
  getRecorderStatus?: () => RecorderStatus | null;
  /** Optional: profiler for metrics collection. */
  profiler?: Profiler;
  /** Called after each successful SITUATION.md write with the content string. */
  onSituationUpdate?: (content: string) => void;
  /** Optional trait engine for personality voice selection. */
  traitEngine?: TraitEngine;
  /** Directory to write per-day trait log JSONL files. */
  traitLogDir?: string;
  /** Optional: path to sinain-knowledge.md for startup recap. */
  getKnowledgeDocPath?: () => string | null;
  /** Optional: feedback store for startup recap context. */
  feedbackStore?: { queryRecent(n: number): FeedbackRecord[] };
  /** Optional: cost tracker for LLM cost accumulation. */
  costTracker?: CostTracker;
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
  private firstTick = true;
  private urgentPending = false;

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
    const ac = this.deps.agentConfig;
    if (!ac.enabled || (ac.provider !== "ollama" && !ac.apiKey)) {
      if (ac.enabled) {
        warn(TAG, "AGENT_ENABLED=true but no API key and provider is not ollama \u2014 analysis disabled");
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

    // Fire recap tick: immediate HUD from persistent knowledge (no sense data needed)
    this.fireRecapTick().catch(e => debug(TAG, "recap skipped:", String(e)));
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
  onNewContext(urgent = false): void {
    if (!this.started) return;

    // Urgent: user command — minimal debounce, bypass cooldown
    const delay = urgent ? 200 : this.firstTick ? 500 : this.deps.agentConfig.debounceMs;
    if (urgent) this.urgentPending = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.run().catch(err => error(TAG, "debounce tick error:", err.message));
    }, delay);
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
    const { apiKey, ...safe } = this.deps.agentConfig;
    return { ...safe, hasApiKey: !!apiKey, escalationMode: this.deps.escalationMode };
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
    if (updates.apiKey !== undefined) c.apiKey = String(updates.apiKey);

    // Restart loop if needed
    if (c.enabled && (c.provider === "ollama" || c.apiKey)) {
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
    if (this.deps.agentConfig.provider !== "ollama" && !this.deps.agentConfig.apiKey) return;

    // Cooldown: don't re-analyze within cooldownMs of last run (unless urgent)
    const isUrgent = this.urgentPending;
    this.urgentPending = false;
    if (!isUrgent && Date.now() - this.lastRunTs < this.deps.agentConfig.cooldownMs) return;

    // Idle suppression: skip if no new events since last tick
    const { feedBuffer, senseBuffer } = this.deps;
    if (feedBuffer.version === this.lastTickFeedVersion &&
        senseBuffer.version === this.lastTickSenseVersion) {
      this.stats.idleSkips++;
      return;
    }
    this.lastTickFeedVersion = feedBuffer.version;
    this.lastTickSenseVersion = senseBuffer.version;

    // Quick idle check BEFORE building context (saves ~20% context builds during idle)
    const cutoff = Date.now() - this.deps.agentConfig.maxAgeMs;
    const feedAudioCount = feedBuffer.queryBySource("audio", cutoff).length;
    const screenCount = senseBuffer.queryByTime(cutoff).length;
    if (feedAudioCount === 0 && screenCount === 0) {
      this.stats.idleSkips++;
      this.deps.profiler?.gauge("agent.idleSkips", this.stats.idleSkips);
      return;
    }

    const richness = modeToRichness(this.deps.escalationMode);
    const ctxStart = Date.now();
    const contextWindow = buildContextWindow(
      feedBuffer, senseBuffer, richness, this.deps.agentConfig.maxAgeMs,
    );
    this.deps.profiler?.timerRecord("agent.contextBuild", Date.now() - ctxStart);

    this.running = true;
    const traceCtx = this.deps.onTraceStart?.(this.agentNextId) ?? null;

    try {
      traceCtx?.startSpan("context-window");
      traceCtx?.endSpan({ richness, screenEvents: contextWindow.screenCount, audioEntries: contextWindow.audioCount });

      traceCtx?.startSpan("llm-call");
      const recorderStatus = this.deps.getRecorderStatus?.() ?? null;

      // Trait selection: pick the best personality voice for this tick
      let traitSelection: TraitSelection | null = null;
      if (this.deps.traitEngine?.enabled) {
        const ocrText = contextWindow.screen.map(e => e.ocr ?? "").join(" ");
        const audioText = contextWindow.audio.map(e => e.text).join(" ");
        traitSelection = this.deps.traitEngine.selectTrait(ocrText, audioText);
      }

      const result = await analyzeContext(contextWindow, this.deps.agentConfig, recorderStatus);
      this.deps.profiler?.timerRecord("agent.llmCall", result.latencyMs);
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
      this.deps.profiler?.gauge("agent.totalCalls", this.stats.totalCalls);
      if (parsedOk) this.stats.parseSuccesses++;
      else this.stats.parseFailures++;
      this.deps.profiler?.gauge("agent.parseSuccesses", this.stats.parseSuccesses);
      this.deps.profiler?.gauge("agent.parseFailures", this.stats.parseFailures);

      if (typeof result.cost === "number" && result.cost > 0) {
        this.deps.costTracker?.record({
          source: "analyzer",
          model: usedModel,
          cost: result.cost,
          tokensIn,
          tokensOut,
          ts: Date.now(),
        });
      }

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
      if (traitSelection) {
        entry.voice = traitSelection.trait.name;
        entry.voice_stat = traitSelection.stat;
        entry.voice_confidence = traitSelection.confidence;
      }
      this.agentBuffer.push(entry);
      const historyLimit = this.deps.agentConfig.historyLimit || 50;
      if (this.agentBuffer.length > historyLimit) this.agentBuffer.shift();

      const imageCount = contextWindow.images?.length || 0;
      if (hud !== this.lastPushedHud) {
        log(TAG, `#${entry.id} (${latencyMs}ms, ${tokensIn}in+${tokensOut}out tok, model=${usedModel}, richness=${richness}, images=${imageCount}) hud="${hud}"`);
      } else {
        debug(TAG, `#${entry.id} (${latencyMs}ms) hud unchanged`);
      }

      // Push HUD line to feed (suppress "—", "Idle", and all in focus mode)
      if (this.deps.agentConfig.pushToFeed &&
          this.deps.escalationMode !== "focus" &&
          this.deps.escalationMode !== "rich" &&
          hud !== "\u2014" && hud !== "Idle" && hud !== this.lastPushedHud) {
        feedBuffer.push(`[\ud83e\udde0] ${hud}`, "normal", "agent", "stream");
        this.deps.onHudUpdate(`[\ud83e\udde0] ${hud}`);
        this.lastPushedHud = hud;
        entry.pushed = true;
      }

      // Store digest
      this.latestDigest = entry;

      // Calculate escalation score for both SITUATION.md and escalation check
      const escalationScore = calculateEscalationScore(digest, contextWindow);

      // Write SITUATION.md (enhanced with escalation context and recorder status)
      const situationContent = writeSituationMd(this.deps.situationMdPath, contextWindow, digest, entry, escalationScore, recorderStatus, traitSelection);
      this.deps.onSituationUpdate?.(situationContent);

      // Broadcast region highlights if detected (Grammarly mode)
      if (result.regions?.length && this.deps.onRegionHighlight) {
        this.deps.onRegionHighlight(result.regions);
      }

      // Notify for escalation check
      traceCtx?.startSpan("escalation-check");
      this.deps.onAnalysis(entry, contextWindow);
      traceCtx?.endSpan();

      // Finish trace
      const costPerToken = { in: 0.075 / 1_000_000, out: 0.3 / 1_000_000 };
      const estimatedCost = tokensIn * costPerToken.in + tokensOut * costPerToken.out;
      traceCtx?.finish({
        totalLatencyMs: Date.now() - entry.ts + latencyMs,
        llmLatencyMs: latencyMs,
        llmInputTokens: tokensIn,
        llmOutputTokens: tokensOut,
        llmCost: result.cost ?? estimatedCost,
        escalated: false, // Updated by escalator
        escalationScore: 0,
        contextScreenEvents: contextWindow.screenCount,
        contextAudioEntries: contextWindow.audioCount,
        contextRichness: richness,
        digestLength: digest.length,
        hudChanged: entry.pushed,
      });

      // Fire-and-forget trait log
      if (this.deps.traitEngine?.enabled && this.deps.traitLogDir) {
        writeTraitLog(this.deps.traitLogDir, {
          ts: new Date().toISOString(),
          tickId: entry.id,
          enabled: true,
          voice: traitSelection?.trait.name ?? "none",
          voice_stat: traitSelection?.stat ?? 0,
          voice_confidence: traitSelection?.confidence ?? 0,
          activation_scores: traitSelection?.allScores ?? {},
          context_app: contextWindow.currentApp,
          hud_length: entry.hud.length,
          synthesis: false,
        }).catch(() => {});
      }

    } catch (err: any) {
      error(TAG, "tick error:", err.message || err);
      traceCtx?.endSpan({ status: "error", error: err.message });
      traceCtx?.finish({ totalLatencyMs: Date.now() - Date.now(), llmLatencyMs: 0, llmInputTokens: 0, llmOutputTokens: 0, llmCost: 0, escalated: false, escalationScore: 0, contextScreenEvents: 0, contextAudioEntries: 0, contextRichness: richness, digestLength: 0, hudChanged: false });
    } finally {
      this.running = false;
      this.firstTick = false;
      this.lastRunTs = Date.now();
    }
  }

  // ── Private: startup recap tick from persistent knowledge ──

  private async fireRecapTick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const sections: string[] = [];
      const startTs = Date.now();

      // 1. sinain-knowledge.md (established patterns, user preferences)
      const knowledgePath = this.deps.getKnowledgeDocPath?.();
      if (knowledgePath) {
        const content = await fs.promises.readFile(knowledgePath, "utf-8").catch(() => "");
        if (content.length > 50) sections.push(content.slice(0, 2000));
      }

      // 2. SITUATION.md digest (if fresh — less than 5 minutes old)
      try {
        const stat = await fs.promises.stat(this.deps.situationMdPath);
        if (Date.now() - stat.mtimeMs < 5 * 60_000) {
          const sit = await fs.promises.readFile(this.deps.situationMdPath, "utf-8");
          const digestMatch = sit.match(/## Digest\n([\s\S]*?)(?=\n##|$)/);
          if (digestMatch?.[1]?.trim()) {
            sections.push(`Last session digest:\n${digestMatch[1].trim()}`);
          }
        }
      } catch { /* SITUATION.md missing — fine */ }

      // 3. Recent feedback records (last 5 escalation summaries)
      const records = this.deps.feedbackStore?.queryRecent(5) ?? [];
      if (records.length > 0) {
        const recaps = records.slice(0, 5).map(r => `- ${r.currentApp}: ${r.hud}`).join("\n");
        sections.push(`Recent activity:\n${recaps}`);
      }

      if (sections.length === 0) { return; }

      const recapContext = sections.join("\n\n");

      // Build synthetic ContextWindow with knowledge as screen entry
      const recapWindow: ContextWindow = {
        audio: [],
        screen: [{
          ts: Date.now(),
          ocr: recapContext,
          meta: { app: "sinain-recap", windowTitle: "startup" },
          type: "context",
        } as unknown as SenseEvent],
        images: [],
        currentApp: "sinain-recap",
        appHistory: [],
        audioCount: 0,
        screenCount: 1,
        windowMs: 0,
        newestEventTs: Date.now(),
        preset: RICHNESS_PRESETS.lean,
      };

      const result = await analyzeContext(recapWindow, this.deps.agentConfig, null);
      if (typeof result.cost === "number" && result.cost > 0) {
        this.deps.costTracker?.record({
          source: "analyzer",
          model: result.model,
          cost: result.cost,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          ts: Date.now(),
        });
      }
      if (result?.hud && result.hud !== "—" && result.hud !== "Idle") {
        this.deps.onHudUpdate(result.hud);
        log(TAG, `recap tick (${Date.now() - startTs}ms, ${result.tokensIn}in+${result.tokensOut}out tok) hud="${result.hud}"`);
      }
    } catch (err: any) {
      debug(TAG, "recap tick error:", err.message || err);
    } finally {
      this.running = false;
      // Do NOT update lastRunTs — normal cooldown should not be affected by recap
    }
  }
}
