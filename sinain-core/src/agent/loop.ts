import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { FeedBuffer } from "../buffers/feed-buffer.js";
import type { SenseBuffer } from "../buffers/sense-buffer.js";
import type { AnalysisConfig, AgentEntry, ContextWindow, EscalationMode, ContextRichness, RecorderStatus, SenseEvent, FeedbackRecord } from "../types.js";
import type { Profiler } from "../profiler.js";
import type { CostTracker } from "../cost/tracker.js";
import { buildContextWindow, RICHNESS_PRESETS } from "./context-window.js";
import { analyzeContext, AnalysisAuthError } from "./analyzer.js";
import { writeSituationMd } from "./situation-writer.js";
import { calculateEscalationScore } from "../escalation/scorer.js";
import { log, warn, error, debug } from "../log.js";

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
  /** Called every tick with the LLM's raw regions (undefined when none) so
   *  the region tracker can ingest new ones and expire stale ones. */
  onRegions?: (regions: import("../types.js").RawRegion[] | undefined, contextWindow: ContextWindow) => void;
  /** Optional: tracer to record spans. */
  onTraceStart?: (tickId: number) => TraceContext | null;
  /** Optional: get current recorder status for prompt injection. */
  getRecorderStatus?: () => RecorderStatus | null;
  /** Optional: profiler for metrics collection. */
  profiler?: Profiler;
  /** Called after each successful SITUATION.md write with the content string. */
  onSituationUpdate?: (content: string) => void;
  /** Predicate to skip SITUATION.md writes entirely when no consumer is
   *  listening. Today only the openclaw module reads SITUATION.md, so when
   *  no gateway-typed agent is selected this returns false and the disk
   *  write is skipped on every tick. Defaults to "always write" if absent
   *  (preserves prior behavior for callers that don't pass the predicate). */
  shouldWriteSituation?: () => boolean;
  /** Optional: path to sinain-knowledge.md for startup recap. */
  getKnowledgeDocPath?: () => string | null;
  /** Optional: feedback store for startup recap context. */
  feedbackStore?: { queryRecent(n: number): FeedbackRecord[] };
  /** Optional: cost tracker for LLM cost accumulation. */
  costTracker?: CostTracker;
  /** Optional: entity subscription cache for real-time knowledge injection. */
  entityCache?: import("../learning/entity-cache.js").EntityCache;
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
  /** True while analysis API calls are failing (network outage) — drives a
   *  single user-visible notice + a recovery notice, not one per tick. */
  private outage = false;
  private started = false;
  private firstTick = true;
  private urgentPending = false;

  private lastPushedHud = "";
  private agentNextId = 1;
  private agentBuffer: AgentEntry[] = [];
  private latestDigest: AgentEntry | null = null;
  private lastTickFeedVersion = 0;
  private lastTickSenseVersion = 0;
  private authErrorNotified = false;
  private missingProviderNotified = false;
  // Salience measurement (no behavior change): tracks how often a Tier-2 tick
  // runs on content identical to the last analyzed state — i.e. how many LLM
  // calls a deterministic salience gate would skip.
  private lastSalienceHash = "";
  private lastSalienceNorm = "";
  private salienceTotal = 0;
  private salienceDup = 0;
  private salienceDupNorm = 0;

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
        if (!this.missingProviderNotified) {
          warn("privacy", "analysis disabled: no provider configured");
          this.missingProviderNotified = true;
        }
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

    // Idle suppression: skip if no new events since last tick. URGENT ticks
    // (user commands) bypass ALL idle checks — a user message must always be
    // analyzed and dispatched even on a completely stale screen (field bug:
    // a chat message during a quiet period was silently idle-skipped and
    // never answered).
    const { feedBuffer, senseBuffer } = this.deps;
    const prevFeedVersion = this.lastTickFeedVersion;
    const prevSenseVersion = this.lastTickSenseVersion;
    if (!isUrgent) {
      if (feedBuffer.version === this.lastTickFeedVersion &&
          senseBuffer.version === this.lastTickSenseVersion) {
        this.stats.idleSkips++;
        return;
      }
    }
    this.lastTickFeedVersion = feedBuffer.version;
    this.lastTickSenseVersion = senseBuffer.version;

    // Quick idle check BEFORE building context (saves ~20% context builds during idle)
    const cutoff = Date.now() - this.deps.agentConfig.maxAgeMs;
    const feedAudioCount = feedBuffer.queryBySource("audio", cutoff).length;
    const screenCount = senseBuffer.queryByTime(cutoff).length;
    if (!isUrgent && feedAudioCount === 0 && screenCount === 0) {
      this.stats.idleSkips++;
      this.deps.profiler?.gauge("agent.idleSkips", this.stats.idleSkips);
      return;
    }

    const richness = modeToRichness(this.deps.escalationMode);
    const ctxStart = Date.now();
    const contextWindow = buildContextWindow(
      feedBuffer, senseBuffer, richness, this.deps.agentConfig.maxAgeMs,
    );

    // Entity subscription: inject cached knowledge facts into context
    if (this.deps.entityCache) {
      const recentText = contextWindow.audio.map(a => a.text).join(" ");
      const entities = this.deps.entityCache.detectEntities(recentText);
      const facts = this.deps.entityCache.getRelevantFacts(entities, 500);
      if (facts) contextWindow.knowledgeFacts = facts;
    }

    this.deps.profiler?.timerRecord("agent.contextBuild", Date.now() - ctxStart);

    // ── Salience probe (MEASUREMENT ONLY — does not skip anything) ──
    // Hash the meaningful inputs the LLM sees (app + screen OCR + audio text;
    // NOT the rendered "Xs ago" timestamps), compare to the last analyzed tick,
    // and log whether a salience gate would have skipped this LLM call.
    {
      const ocrJoined = contextWindow.screen.map(e => e.ocr || "").join("");
      const audioJoined = contextWindow.audio.map(a => a.text).join("");
      const key = `${contextWindow.currentApp}${ocrJoined}${audioJoined}`;
      let h = 2166136261 >>> 0; // FNV-1a
      for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
      const hash = h.toString(16);
      const normKey = `${contextWindow.currentApp}${(ocrJoined + audioJoined).toLowerCase().replace(/[^a-z]+/g, "")}`;
      let hn = 2166136261 >>> 0;
      for (let i = 0; i < normKey.length; i++) { hn ^= normKey.charCodeAt(i); hn = Math.imul(hn, 16777619) >>> 0; }
      const normHash = hn.toString(16);
      const dup = hash === this.lastSalienceHash;
      const dupNorm = normHash === this.lastSalienceNorm;
      this.salienceTotal++;
      if (dup) this.salienceDup++;
      if (dupNorm) this.salienceDupNorm++;
      this.lastSalienceHash = hash;
      this.lastSalienceNorm = normHash;
      log("salience", `app=${contextWindow.currentApp} dupExact=${dup} dupNorm=${dupNorm} ocrChars=${ocrJoined.length} audio=${contextWindow.audio.length} | would-skip exact ${this.salienceDup}/${this.salienceTotal} (${Math.round(100 * this.salienceDup / Math.max(1, this.salienceTotal))}%) norm ${this.salienceDupNorm}/${this.salienceTotal} (${Math.round(100 * this.salienceDupNorm / Math.max(1, this.salienceTotal))}%)`);
    }

    this.running = true;
    const traceCtx = this.deps.onTraceStart?.(this.agentNextId) ?? null;

    try {
      traceCtx?.startSpan("context-window");
      traceCtx?.endSpan({ richness, screenEvents: contextWindow.screenCount, audioEntries: contextWindow.audioCount });

      traceCtx?.startSpan("llm-call");
      const recorderStatus = this.deps.getRecorderStatus?.() ?? null;

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
      this.agentBuffer.push(entry);
      const historyLimit = this.deps.agentConfig.historyLimit || 50;
      if (this.agentBuffer.length > historyLimit) this.agentBuffer.shift();

      const imageCount = contextWindow.images?.length || 0;
      if (hud !== this.lastPushedHud) {
        log(TAG, `#${entry.id} (${latencyMs}ms, ${tokensIn}in+${tokensOut}out tok, model=${usedModel}, richness=${richness}, images=${imageCount}) hud="${hud}"`);
      } else {
        debug(TAG, `#${entry.id} (${latencyMs}ms) hud unchanged`);
      }

      // Always push HUD to feed buffer for data capture (curation pipeline reads this)
      if (this.deps.agentConfig.pushToFeed &&
          hud !== "\u2014" && hud !== "Idle" && hud !== this.lastPushedHud) {
        feedBuffer.push(`[\ud83e\udde0] ${hud}`, "normal", "agent", "stream");
        this.lastPushedHud = hud;
        entry.pushed = true;
      }

      // Broadcast to overlay only when NOT in focus/rich mode
      // (in those modes, the overlay gets updates via escalation instead)
      if (entry.pushed &&
          this.deps.escalationMode !== "focus" &&
          this.deps.escalationMode !== "rich") {
        this.deps.onHudUpdate(`[\ud83e\udde0] ${hud}`);
      }

      // Store digest
      this.latestDigest = entry;

      // Calculate escalation score for both SITUATION.md and escalation check
      const escalationScore = calculateEscalationScore(digest, contextWindow);

      // Write SITUATION.md only when something consumes it (today: an openclaw
      // gateway lane is selected). Without a consumer, skip the disk write to
      // avoid pinning ~/.openclaw/workspace/SITUATION.md on every tick of users
      // who chose claude/openclaude/etc as both lanes.
      if (this.deps.shouldWriteSituation?.() ?? true) {
        const situationContent = writeSituationMd(this.deps.situationMdPath, contextWindow, digest, entry, escalationScore, recorderStatus);
        this.deps.onSituationUpdate?.(situationContent);
      }

      // Region tracking (Grammarly mode) — every tick, so expiry advances
      if (this.deps.agentConfig.regionsEnabled) {
        if (result.regions?.length) {
          log("agent", `analyzer emitted ${result.regions.length} region(s): ${result.regions.map(r => `"${r.issue.slice(0, 40)}" src=${r.sourceId ?? "-"}`).join("; ")}`);
        }
        this.deps.onRegions?.(result.regions, contextWindow);
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

      if (this.outage) {
        this.outage = false;
        const note = this.deps.agentConfig.provider === "ollama"
          ? "✓ Local analysis is back online."
          : "✓ Connectivity restored — sinain analysis is back online.";
        this.deps.feedBuffer.push(note, "normal", "system", "stream");
        this.deps.onHudUpdate(note);
      }

    } catch (err: any) {
      if (err instanceof AnalysisAuthError) {
        this.handleAuthError(err);
      } else {
        error(TAG, "tick error:", err.message || err);
        // Self-healing: this tick consumed the buffer version cursors before
        // failing — restore them so the next max-interval tick retries even
        // if no new events arrive (a transient network error previously
        // parked the loop in idle-skip forever).
        this.lastTickFeedVersion = prevFeedVersion;
        this.lastTickSenseVersion = prevSenseVersion;
        if (!this.outage) {
          this.outage = true;
          // Provider-aware: in local mode there's no network/API — the failure
          // is the on-device model (usually a timeout under GPU load). Don't
          // claim a connectivity problem that doesn't exist.
          const aborted = err?.name === "AbortError" || /aborted|timed? ?out/i.test(err?.message || "");
          const note = this.deps.agentConfig.provider === "ollama"
            ? `⚠ Local analysis model ${aborted ? "timed out (busy GPU)" : "errored"} — sinain keeps retrying in the background. Nothing leaves your device.`
            : "⚠ Network issue: can't reach the analysis API — sinain keeps retrying in the background. Chat and escalations resume automatically when connectivity returns.";
          this.deps.feedBuffer.push(note, "high", "system", "stream");
          this.deps.onHudUpdate(note);
        }
      }
      traceCtx?.endSpan({ status: "error", error: err.message });
      traceCtx?.finish({ totalLatencyMs: Date.now() - Date.now(), llmLatencyMs: 0, llmInputTokens: 0, llmOutputTokens: 0, llmCost: 0, escalated: false, escalationScore: 0, contextScreenEvents: 0, contextAudioEntries: 0, contextRichness: richness, digestLength: 0, hudChanged: false });
    } finally {
      this.running = false;
      this.firstTick = false;
      this.lastRunTs = Date.now();
    }
  }

  private handleAuthError(err: AnalysisAuthError): void {
    const msg = "Sinain paused analysis: OpenRouter rejected the API key. Update OPENROUTER_API_KEY in ~/.sinain/.env, then restart Sinain.";
    warn(TAG, `${msg} (${err.message})`);
    this.deps.agentConfig.enabled = false;
    if (!this.authErrorNotified) {
      this.authErrorNotified = true;
      this.deps.feedBuffer.push(`⚠ ${msg}`, "urgent", "system", "stream");
      this.deps.onHudUpdate(`⚠ ${msg}`);
    }
    this.stop();
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
      if (err instanceof AnalysisAuthError) {
        this.handleAuthError(err);
      } else {
        debug(TAG, "recap tick error:", err.message || err);
      }
    } finally {
      this.running = false;
      // Do NOT update lastRunTs — normal cooldown should not be affected by recap
    }
  }
}
