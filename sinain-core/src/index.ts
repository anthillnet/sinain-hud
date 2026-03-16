import { loadConfig } from "./config.js";
import { FeedBuffer } from "./buffers/feed-buffer.js";
import { SenseBuffer } from "./buffers/sense-buffer.js";
import { WsHandler } from "./overlay/ws-handler.js";
import { setupCommands } from "./overlay/commands.js";
import { AudioPipeline } from "./audio/pipeline.js";
import type { CaptureSpawner } from "./audio/capture-spawner.js";
import { TranscriptionService } from "./audio/transcription.js";
import { AgentLoop } from "./agent/loop.js";
import { TraitEngine, loadTraitRoster } from "./agent/traits.js";
import { shortAppName } from "./agent/context-window.js";
import { Escalator } from "./escalation/escalator.js";
import { Recorder } from "./recorder.js";
import { Tracer } from "./trace/tracer.js";
import { TraceStore } from "./trace/trace-store.js";
import { FeedbackStore } from "./learning/feedback-store.js";
import { SignalCollector } from "./learning/signal-collector.js";
import { createAppServer } from "./server.js";
import { Profiler } from "./profiler.js";
import type { SenseEvent, EscalationMode, FeedItem } from "./types.js";
import { isDuplicateTranscript, bigramSimilarity } from "./util/dedup.js";
import { log, warn, error } from "./log.js";
import { initPrivacy, levelFor, applyLevel } from "./privacy/index.js";

const TAG = "core";

async function main() {
  log(TAG, "sinain-core starting...");

  // ── Load config ──
  const config = loadConfig();
  log(TAG, `port: ${config.port}`);
  log(TAG, `audio: device=${config.audioConfig.device} cmd=${config.audioConfig.captureCommand} chunk=${config.audioConfig.chunkDurationMs}ms`);
  log(TAG, `mic: enabled=${config.micEnabled} device=${config.micConfig.device} cmd=${config.micConfig.captureCommand}`);
  log(TAG, `transcription: model=${config.transcriptionConfig.geminiModel}`);
  log(TAG, `agent: model=${config.agentConfig.model} debounce=${config.agentConfig.debounceMs}ms max=${config.agentConfig.maxIntervalMs}ms`);
  log(TAG, `escalation: mode=${config.escalationConfig.mode} cooldown=${config.escalationConfig.cooldownMs}ms stale=${config.escalationConfig.staleMs}ms`);
  log(TAG, `openclaw: ws=${config.openclawConfig.gatewayWsUrl} http=${config.openclawConfig.hookUrl}`);
  log(TAG, `situation: ${config.situationMdPath}`);
  log(TAG, `tracing: enabled=${config.traceEnabled} dir=${config.traceDir}`);
  log(TAG, `learning: enabled=${config.learningConfig.enabled} dir=${config.learningConfig.feedbackDir}`);

  // ── Initialize privacy ──
  initPrivacy(config.privacyConfig);
  log(TAG, `privacy: mode=${config.privacyConfig.mode}`);

  // ── Initialize core buffers (single source of truth) ──
  const feedBuffer = new FeedBuffer(100);
  const senseBuffer = new SenseBuffer(30);

  // ── Initialize overlay WS handler ──
  const wsHandler = new WsHandler();

  // ── Initialize tracing ──
  const tracer = config.traceEnabled ? new Tracer() : null;
  const traceStore = config.traceEnabled ? new TraceStore(config.traceDir) : null;

  // ── Initialize recorder ──
  const recorder = new Recorder();

  // ── Initialize profiler ──
  const profiler = new Profiler();

  // ── Initialize learning subsystem ──
  const feedbackStore = config.learningConfig.enabled
    ? new FeedbackStore(config.learningConfig.feedbackDir, config.learningConfig.retentionDays)
    : null;

  // ── Initialize trait engine ──
  const traitRoster = loadTraitRoster(config.traitConfig.configPath);
  const traitEngine = new TraitEngine(traitRoster, config.traitConfig);

  // ── Initialize escalation ──
  const escalator = new Escalator({
    feedBuffer,
    wsHandler,
    escalationConfig: config.escalationConfig,
    openclawConfig: config.openclawConfig,
    profiler,
    feedbackStore: feedbackStore ?? undefined,
  });

  // ── Initialize agent loop (event-driven) ──
  const agentLoop = new AgentLoop({
    feedBuffer,
    senseBuffer,
    agentConfig: config.agentConfig,
    escalationMode: config.escalationConfig.mode,
    situationMdPath: config.situationMdPath,
    getRecorderStatus: () => recorder.getStatus(),
    profiler,
    onAnalysis: (entry, contextWindow) => {
      // Handle recorder commands
      const stopResult = recorder.handleCommand(entry.record);

      // Dispatch task via subagent spawn
      if (entry.task || stopResult) {
        let task: string;
        let label: string | undefined;

        if (stopResult && stopResult.segments > 0 && entry.task) {
          // Recording stopped with explicit task instruction
          task = `${entry.task}\n\n[Recording: "${stopResult.title}", ${stopResult.durationS}s]\n${stopResult.transcript}`;
          label = stopResult.title;
        } else if (stopResult && stopResult.segments > 0) {
          // Recording stopped without explicit task — default to cleanup/summarize
          task = `Clean up and summarize this recording transcript:\n\n[Recording: "${stopResult.title}", ${stopResult.durationS}s]\n${stopResult.transcript}`;
          label = stopResult.title;
        } else if (entry.task) {
          // Standalone task without recording
          task = entry.task;
        } else {
          task = "";
        }

        if (task) {
          escalator.dispatchSpawnTask(task, label).catch(err => {
            error(TAG, "spawn task dispatch error:", err);
          });
        }
      }

      // Escalation continues as normal
      escalator.onAgentAnalysis(entry, contextWindow);
    },
    onSituationUpdate: (content) => {
      escalator.pushSituationMd(content);
    },
    onHudUpdate: (text) => {
      wsHandler.broadcast(text, "normal", "stream");
    },
    onTraceStart: tracer ? (tickId) => {
      const ctx = tracer.startTrace(tickId);
      // Hook trace persistence
      const origFinish = ctx.finish.bind(ctx);
      ctx.finish = (metrics) => {
        origFinish(metrics);
        const traces = tracer.getTraces(tickId - 1, 1);
        if (traces.length > 0 && traceStore) {
          traceStore.append(traces[0]);
        }
      };
      return ctx;
    } : undefined,
    traitEngine,
    traitLogDir: config.traitConfig.logDir,
  });

  // ── Wire learning signal collector (needs agentLoop) ──
  const signalCollector = feedbackStore
    ? new SignalCollector(feedbackStore, agentLoop, senseBuffer)
    : null;
  if (signalCollector) {
    escalator.setSignalCollector(signalCollector);
  }

  // ── Platform-specific audio capture spawner ──
  let captureSpawner: CaptureSpawner;
  if (process.platform === "win32") {
    const { WindowsCaptureSpawner } = await import("./audio/capture-spawner-win.js");
    captureSpawner = new WindowsCaptureSpawner();
  } else {
    const { MacOSCaptureSpawner } = await import("./audio/capture-spawner-macos.js");
    captureSpawner = new MacOSCaptureSpawner();
  }

  // ── Initialize audio pipelines ──
  const systemAudioPipeline = new AudioPipeline(config.audioConfig, "system", captureSpawner);
  const micPipeline = config.micEnabled ? new AudioPipeline(config.micConfig, "mic", captureSpawner) : null;
  const transcription = new TranscriptionService(config.transcriptionConfig);
  systemAudioPipeline.setProfiler(profiler);
  if (micPipeline) micPipeline.setProfiler(profiler);
  transcription.setProfiler(profiler);

  // Wire: audio chunks → transcription (both pipelines share the same transcription service)
  systemAudioPipeline.on("chunk", (chunk) => {
    transcription.processChunk(chunk).catch((err) => {
      error(TAG, "transcription error:", err instanceof Error ? err.message : err);
    });
  });

  if (micPipeline) {
    micPipeline.on("chunk", (chunk) => {
      transcription.processChunk(chunk).catch((err) => {
        error(TAG, "mic transcription error:", err instanceof Error ? err.message : err);
      });
    });
  }

  // System audio pipeline lifecycle events
  systemAudioPipeline.on("error", (err) => {
    error(TAG, "system audio pipeline error:", err instanceof Error ? err.message : err);
    wsHandler.broadcast("\u26a0 System audio capture error. Check device settings.", "high");
  });

  systemAudioPipeline.on("started", () => {
    log(TAG, "system audio pipeline started");
    wsHandler.updateState({ audio: "active" });
  });

  systemAudioPipeline.on("stopped", () => {
    log(TAG, "system audio pipeline stopped");
    wsHandler.updateState({ audio: "muted" });
  });

  systemAudioPipeline.on("muted", () => {
    log(TAG, "system audio muted (capture process still running)");
    wsHandler.updateState({ audio: "muted" });
  });

  systemAudioPipeline.on("unmuted", () => {
    log(TAG, "system audio unmuted");
    wsHandler.updateState({ audio: "active" });
  });

  // Mic pipeline lifecycle events
  if (micPipeline) {
    micPipeline.on("error", (err) => {
      error(TAG, "mic pipeline error:", err instanceof Error ? err.message : err);
      wsHandler.broadcast("\u26a0 Mic capture error. Check device settings.", "high");
    });

    micPipeline.on("started", () => {
      log(TAG, "mic pipeline started");
      wsHandler.updateState({ mic: "active" });
    });

    micPipeline.on("stopped", () => {
      log(TAG, "mic pipeline stopped");
      wsHandler.updateState({ mic: "muted" });
    });
  }

  // Wire: transcripts → feed buffer + overlay + agent trigger + recorder
  // Per-source dedup: track last 3 transcripts per source
  const recentSystemTranscripts: string[] = [];
  const recentMicTranscripts: string[] = [];

  transcription.on("transcript", (result) => {
    const isSystem = result.audioSource === "system";
    const recentSame = isSystem ? recentSystemTranscripts : recentMicTranscripts;

    // Skip near-duplicate transcripts within same source
    if (isDuplicateTranscript(result.text, recentSame)) {
      log(TAG, `transcript deduped (${result.audioSource}): "${result.text.slice(0, 60)}..."`);
      return;
    }

    // Cross-stream dedup: drop mic transcript if >70% similar to recent system transcript
    if (!isSystem && recentSystemTranscripts.length > 0) {
      const trimmed = result.text.trim();
      for (const recent of recentSystemTranscripts) {
        if (bigramSimilarity(trimmed, recent) > 0.70) {
          log(TAG, `mic transcript cross-deduped (speakers pickup): "${trimmed.slice(0, 60)}..."`);
          return;
        }
      }
    }

    // Track recent transcripts (ring buffer of 3 per source)
    recentSame.push(result.text.trim());
    if (recentSame.length > 3) recentSame.shift();

    const emoji = isSystem ? "\ud83d\udd0a" : "\ud83c\udf99";
    const tag = `[${emoji}]`;
    const bufferLevel = levelFor("audio_transcript", "local_buffer");
    const bufferText = applyLevel(result.text, bufferLevel, "audio");
    const item = feedBuffer.push(`${tag} ${bufferText}`, "normal", "audio", "stream");
    if (!isSystem) item.audioSource = "mic";
    wsHandler.broadcast(`${tag} ${bufferText}`, "normal");
    recorder.onFeedItem(item); // Collect for recording if active
    agentLoop.onNewContext(); // Trigger debounced analysis
  });

  // ── Screen capture active flag ──
  let screenActive = true;

  // ── Create HTTP + WS server ──
  const server = createAppServer({
    config,
    feedBuffer,
    senseBuffer,
    wsHandler,
    profiler,
    feedbackStore: feedbackStore ?? undefined,
    isScreenActive: () => screenActive,

    onSenseEvent: (event: SenseEvent) => {
      // Respect toggle_screen — if user disabled screen, ignore sense events
      if (!screenActive) return;

      wsHandler.updateState({ screen: "active" });

      // Track app context for recorder
      recorder.onSenseEvent(event);

      // Broadcast app/window changes to overlay
      if (event.type === "text" && event.ocr && event.ocr.trim().length > 10) {
        const app = shortAppName(event.meta.app || "");
        const firstLine = event.ocr.split("\n").find((l: string) => l.trim().length > 5)?.trim() || event.ocr.split("\n")[0].trim();
        const text = firstLine.slice(0, 80);
        const prefix = app ? `${app}: ` : "";
        wsHandler.broadcast(`[\ud83d\udc41] ${prefix}${text}`, "normal");
      }

      // Trigger debounced agent analysis
      agentLoop.onNewContext();
    },

    onFeedPost: (text: string, priority: string) => {
      const item = feedBuffer.push(text, priority as any, "system", "stream");
      wsHandler.broadcast(text, priority as any);
      agentLoop.onNewContext();
      log(TAG, `[feed] #${item.id}: ${text.slice(0, 80)}`);
    },

    onSenseProfile: (snapshot) => profiler.reportSense(snapshot),

    getHealthPayload: () => {
      const escStats = escalator.getStats();
      const warnings: string[] = [];

      // Compute health warnings from escalation metrics
      const totalAttempts = (escStats.totalDirectResponses as number) + (escStats.totalTimeouts as number);
      const timeoutRate = totalAttempts > 0 ? (escStats.totalTimeouts as number) / totalAttempts : 0;

      if (totalAttempts >= 5 && timeoutRate > 0.3) {
        warnings.push(`high_timeout_rate: ${Math.round(timeoutRate * 100)}%`);
      }
      if ((escStats.consecutiveTimeouts as number) >= 3) {
        warnings.push(`consecutive_timeouts: ${escStats.consecutiveTimeouts}`);
      }
      const lastResp = escStats.lastResponseTs as number;
      if (lastResp > 0 && Date.now() - lastResp > 5 * 60 * 1000) {
        warnings.push(`stale_responses: ${Math.round((Date.now() - lastResp) / 60000)}min`);
      }
      if ((escStats.totalSpawnResponses as number) > 5 && (escStats.totalDirectResponses as number) === 0) {
        warnings.push("no_direct_responses");
      }
      if ((escStats.avgResponseMs as number) > 30000) {
        warnings.push(`slow_responses: ${Math.round(escStats.avgResponseMs as number)}ms avg`);
      }

      return {
        warnings,
        agent: agentLoop.getStats(),
        escalation: escStats,
        transcription: transcription.getProfilingStats(),
        situation: { path: config.situationMdPath },
        traces: tracer ? tracer.getMetricsSummary() : null,
        profiling: profiler.getSnapshot(),
      };
    },

    getAgentDigest: () => agentLoop.getDigest(),
    getAgentHistory: (limit) => agentLoop.getHistory(limit),
    getAgentContext: () => agentLoop.getContext(),
    getAgentConfig: () => agentLoop.getConfig(),

    updateAgentConfig: (updates) => {
      // Handle escalation mode updates
      if (updates.escalationMode !== undefined) {
        const mode = String(updates.escalationMode) as EscalationMode;
        if (["focus", "selective", "rich", "off"].includes(mode)) {
          escalator.setMode(mode);
          (agentLoop as any).deps.escalationMode = mode;
        }
      }
      if (updates.escalationCooldownMs !== undefined) {
        config.escalationConfig.cooldownMs = Math.max(5000, parseInt(String(updates.escalationCooldownMs)));
      }
      if (updates.escalationStaleMs !== undefined) {
        config.escalationConfig.staleMs = Math.max(0, parseInt(String(updates.escalationStaleMs)));
      }
      agentLoop.updateConfig(updates);
      return agentLoop.getConfig();
    },

    getTraces: (after, limit) => tracer ? tracer.getTraces(after, limit) : [],
    reconnectGateway: () => escalator.reconnectGateway(),
  });

  // ── Wire overlay profiling ──
  wsHandler.onProfiling((msg) => {
    profiler.reportOverlay({ rssMb: msg.rssMb, uptimeS: msg.uptimeS, ts: msg.ts });
  });

  // ── Wire overlay commands ──
  setupCommands({
    wsHandler,
    systemAudioPipeline,
    micPipeline,
    config,
    onUserMessage: async (text) => {
      await escalator.sendDirect(text);
    },
    onToggleScreen: () => {
      screenActive = !screenActive;
      if (!screenActive) {
        senseBuffer.clear();
      }
      wsHandler.updateState({ screen: screenActive ? "active" : "off" });
      return screenActive;
    },
    onToggleTraits: () => traitEngine.toggle(),
  });

  // Broadcast initial screen state so overlay gets correct status on connect
  wsHandler.updateState({ screen: "active" });

  // ── Start services ──
  try {
    await server.start();
  } catch (err) {
    error(TAG, "failed to start server:", err);
    process.exit(1);
  }

  // Start profiler
  profiler.start();
  // Periodically sample buffer gauges
  const bufferGaugeTimer = setInterval(() => {
    profiler.gauge("buffer.feed", feedBuffer.size);
    profiler.gauge("buffer.sense", senseBuffer.size);
    profiler.gauge("buffer.feed.hwm", feedBuffer.hwm);
    profiler.gauge("buffer.sense.hwm", senseBuffer.hwm);
    profiler.gauge("ws.clients", wsHandler.clientCount);
  }, 10_000);

  // Start escalation WS connection
  escalator.start();

  // Start periodic feedback summary (every 30 minutes, offset from startup)
  const feedbackSummaryTimer = config.learningConfig.enabled
    ? setInterval(() => {
        escalator.sendFeedbackSummary().catch(err => {
          warn(TAG, "feedback summary error:", err);
        });
      }, 30 * 60 * 1000)
    : null;

  // Start agent loop
  agentLoop.start();

  // Auto-start system audio if configured
  if (config.audioConfig.autoStart) {
    log(TAG, "auto-starting system audio pipeline...");
    systemAudioPipeline.start();
  } else {
    log(TAG, "system audio pipeline ready (not auto-started \u2014 send toggle_audio or set AUDIO_AUTO_START=true)");
  }

  // Auto-start mic if configured
  if (micPipeline && config.micConfig.autoStart) {
    log(TAG, "auto-starting mic pipeline...");
    micPipeline.start();
  } else if (micPipeline) {
    log(TAG, "mic pipeline ready (not auto-started \u2014 send toggle_mic or set MIC_AUTO_START=true)");
  }

  log(TAG, "\u2713 sinain-core running");
  log(TAG, `  http+ws: http://0.0.0.0:${config.port}`);
  log(TAG, `  audio:   ${config.audioConfig.autoStart ? "active" : "standby"} (${config.audioConfig.captureCommand})`);
  log(TAG, `  mic:     ${config.micEnabled ? (config.micConfig.autoStart ? "active" : "standby") : "disabled"}`);
  log(TAG, `  agent:   ${config.agentConfig.enabled ? "enabled" : "disabled"}`);
  log(TAG, `  escal:   ${config.escalationConfig.mode}`);
  log(TAG, `  traits:  ${config.traitConfig.enabled ? "enabled" : "disabled"} (${traitRoster.length} traits)`);

  // ── Graceful shutdown ──
  const shutdown = async (signal: string) => {
    log(TAG, `${signal} received, shutting down...`);
    clearInterval(bufferGaugeTimer);
    if (feedbackSummaryTimer) clearInterval(feedbackSummaryTimer);
    profiler.stop();
    recorder.forceStop(); // Stop any active recording
    agentLoop.stop();
    systemAudioPipeline.stop();
    if (micPipeline) micPipeline.stop();
    transcription.destroy();
    escalator.stop();
    signalCollector?.destroy();
    feedbackStore?.destroy();
    traceStore?.destroy();
    await server.destroy();
    log(TAG, "goodbye");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("uncaughtException", (err) => {
    error(TAG, "uncaught exception:", err);
  });
  process.on("unhandledRejection", (reason) => {
    error(TAG, "unhandled rejection:", reason);
  });
}

main().catch((err) => {
  error(TAG, "fatal:", err);
  process.exit(1);
});
