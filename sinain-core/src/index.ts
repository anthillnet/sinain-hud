import { loadConfig } from "./config.js";
import { FeedBuffer } from "./buffers/feed-buffer.js";
import { SenseBuffer } from "./buffers/sense-buffer.js";
import { WsHandler } from "./overlay/ws-handler.js";
import { setupCommands } from "./overlay/commands.js";
import { AudioPipeline } from "./audio/pipeline.js";
import { TranscriptionService } from "./audio/transcription.js";
import { AgentLoop } from "./agent/loop.js";
import { shortAppName } from "./agent/context-window.js";
import { Escalator } from "./escalation/escalator.js";
import { Tracer } from "./trace/tracer.js";
import { TraceStore } from "./trace/trace-store.js";
import { createAppServer } from "./server.js";
import type { SenseEvent, EscalationMode } from "./types.js";
import { log, warn, error } from "./log.js";

const TAG = "core";

async function main() {
  log(TAG, "sinain-core starting...");

  // ── Load config ──
  const config = loadConfig();
  log(TAG, `port: ${config.port}`);
  log(TAG, `audio: device=${config.audioConfig.device} cmd=${config.audioConfig.captureCommand} chunk=${config.audioConfig.chunkDurationMs}ms`);
  log(TAG, `transcription: backend=${config.transcriptionConfig.backend} model=${config.transcriptionConfig.geminiModel}`);
  log(TAG, `agent: model=${config.agentConfig.model} debounce=${config.agentConfig.debounceMs}ms max=${config.agentConfig.maxIntervalMs}ms`);
  log(TAG, `escalation: mode=${config.escalationConfig.mode} cooldown=${config.escalationConfig.cooldownMs}ms`);
  log(TAG, `openclaw: ws=${config.openclawConfig.gatewayWsUrl} http=${config.openclawConfig.hookUrl}`);
  log(TAG, `situation: ${config.situationMdPath}`);
  log(TAG, `tracing: enabled=${config.traceEnabled} dir=${config.traceDir}`);

  // ── Initialize core buffers (single source of truth) ──
  const feedBuffer = new FeedBuffer(100);
  const senseBuffer = new SenseBuffer(30);

  // ── Initialize overlay WS handler ──
  const wsHandler = new WsHandler();

  // ── Initialize tracing ──
  const tracer = config.traceEnabled ? new Tracer() : null;
  const traceStore = config.traceEnabled ? new TraceStore(config.traceDir) : null;

  // ── Initialize escalation ──
  const escalator = new Escalator({
    feedBuffer,
    wsHandler,
    escalationConfig: config.escalationConfig,
    openclawConfig: config.openclawConfig,
  });

  // ── Initialize agent loop (event-driven) ──
  const agentLoop = new AgentLoop({
    feedBuffer,
    senseBuffer,
    agentConfig: config.agentConfig,
    escalationMode: config.escalationConfig.mode,
    situationMdPath: config.situationMdPath,
    onAnalysis: (entry, contextWindow) => {
      escalator.onAgentAnalysis(entry, contextWindow);
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
  });

  // ── Initialize audio pipeline ──
  const audioPipeline = new AudioPipeline(config.audioConfig);
  const transcription = new TranscriptionService(config.transcriptionConfig);

  // Wire: audio chunks → transcription
  audioPipeline.on("chunk", (chunk) => {
    transcription.processChunk(chunk).catch((err) => {
      error(TAG, "transcription error:", err instanceof Error ? err.message : err);
    });
  });

  audioPipeline.on("error", (err) => {
    error(TAG, "audio pipeline error:", err instanceof Error ? err.message : err);
    wsHandler.broadcast("\u26a0 Audio capture error. Check device settings.", "high");
  });

  audioPipeline.on("started", () => {
    log(TAG, "audio pipeline started");
    wsHandler.updateState({ audio: "active" });
  });

  audioPipeline.on("stopped", () => {
    log(TAG, "audio pipeline stopped");
    wsHandler.updateState({ audio: "muted" });
  });

  // Wire: transcripts → feed buffer + overlay + agent trigger
  transcription.on("transcript", (result) => {
    feedBuffer.push(`[\ud83d\udcdd] ${result.text}`, "normal", "audio", "stream");
    wsHandler.broadcast(`[\ud83d\udcdd] ${result.text}`, "normal");
    agentLoop.onNewContext(); // Trigger debounced analysis
  });

  // ── Screen capture active flag ──
  let screenActive = false;

  // ── Create HTTP + WS server ──
  const server = createAppServer({
    config,
    feedBuffer,
    senseBuffer,
    wsHandler,

    onSenseEvent: (event: SenseEvent) => {
      screenActive = true;
      wsHandler.updateState({ screen: "active" });

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

    getHealthPayload: () => ({
      agent: agentLoop.getStats(),
      escalation: escalator.getStats(),
      situation: { path: config.situationMdPath },
      traces: tracer ? tracer.getMetricsSummary() : null,
    }),

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
      agentLoop.updateConfig(updates);
      return agentLoop.getConfig();
    },

    getTraces: (after, limit) => tracer ? tracer.getTraces(after, limit) : [],
  });

  // ── Wire overlay commands ──
  setupCommands({
    wsHandler,
    audioPipeline,
    config,
    onUserMessage: async (text) => {
      await escalator.sendDirect(text);
    },
    onToggleScreen: () => {
      screenActive = !screenActive;
      wsHandler.updateState({ screen: screenActive ? "active" : "off" });
      return screenActive;
    },
  });

  // ── Start services ──
  try {
    await server.start();
  } catch (err) {
    error(TAG, "failed to start server:", err);
    process.exit(1);
  }

  // Start escalation WS connection
  escalator.start();

  // Start agent loop
  agentLoop.start();

  // Auto-start audio if configured
  if (config.audioConfig.autoStart) {
    log(TAG, "auto-starting audio pipeline...");
    audioPipeline.start();
  } else {
    log(TAG, "audio pipeline ready (not auto-started \u2014 send toggle_audio or set AUDIO_AUTO_START=true)");
  }

  log(TAG, "\u2713 sinain-core running");
  log(TAG, `  http+ws: http://0.0.0.0:${config.port}`);
  log(TAG, `  audio:   ${config.audioConfig.autoStart ? "active" : "standby"}`);
  log(TAG, `  agent:   ${config.agentConfig.enabled ? "enabled" : "disabled"}`);
  log(TAG, `  escal:   ${config.escalationConfig.mode}`);

  // ── Graceful shutdown ──
  const shutdown = async (signal: string) => {
    log(TAG, `${signal} received, shutting down...`);
    agentLoop.stop();
    audioPipeline.stop();
    transcription.destroy();
    escalator.stop();
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
