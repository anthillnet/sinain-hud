import { loadConfig } from "./config.js";
import { WsServer } from "./ws-server.js";
import { OpenClawClient } from "./openclaw-client.js";
import { ContextManager } from "./context-manager.js";
import { ContextRelay } from "./context-relay.js";
import { AudioPipeline } from "./audio-pipeline.js";
import { TranscriptionService } from "./transcription.js";
import { log, warn, error } from "./log.js";

const TAG = "bridge";

async function main() {
  log(TAG, "SinainHUD Bridge starting...");

  // ── Load config ──
  const config = loadConfig();
  log(TAG, `gateway: ${config.openclawGatewayUrl}`);
  log(TAG, `session: ${config.openclawSessionKey || "(not set)"}`);
  log(TAG, `ws port: ${config.wsPort}`);
  log(TAG, `relay interval: ${config.relayMinIntervalMs}ms`);
  log(TAG, `audio: device=${config.audioConfig.device} cmd=${config.audioConfig.captureCommand} chunk=${config.audioConfig.chunkDurationMs}ms`);
  log(TAG, `transcription: backend=${config.transcriptionConfig.backend} model=${config.transcriptionConfig.geminiModel}`);

  if (!config.openclawToken) {
    warn(TAG, "OPENCLAW_TOKEN not set — gateway auth will be skipped");
  }
  if (!config.openclawSessionKey) {
    warn(TAG, "OPENCLAW_SESSION_KEY not set — messages won't route");
  }

  // ── Initialize components ──
  const contextManager = new ContextManager();
  const openclawClient = new OpenClawClient(config);
  const contextRelay = new ContextRelay(contextManager, openclawClient, config);
  const wsServer = new WsServer(config);

  // ── Audio pipeline ──
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
    wsServer.broadcast("⚠ Audio capture error. Check device settings.", "high");
  });

  audioPipeline.on("started", () => {
    log(TAG, "audio pipeline started");
    wsServer.updateState({ audio: "active" });
  });

  audioPipeline.on("stopped", () => {
    log(TAG, "audio pipeline stopped");
    wsServer.updateState({ audio: "muted" });
  });

  // Wire: transcripts → context relay + overlay
  transcription.on("transcript", (result) => {
    contextRelay.ingest(result.text, result.source);
    // Show on overlay as subtle feed item
    wsServer.broadcast(`[📝] ${result.text}`, "normal");
  });

  // ── Wire: OpenClaw responses → overlay feed ──
  openclawClient.onFeedItem((text, priority) => {
    wsServer.broadcast(text, priority);
  });

  // ── Wire: overlay messages → OpenClaw ──
  wsServer.onIncoming(async (msg) => {
    switch (msg.type) {
      case "message": {
        // Direct user message → send immediately to Sinain
        log(TAG, `routing user message to OpenClaw`);
        const sent = await contextRelay.relayDirect(msg.text);
        if (!sent) {
          wsServer.broadcast(
            "⚠ Failed to reach Sinain. Check gateway connection.",
            "high"
          );
        }
        break;
      }
      case "command": {
        if (msg.action === "toggle_audio") {
          if (audioPipeline.isRunning()) {
            audioPipeline.stop();
            log(TAG, "audio toggled OFF via overlay command");
          } else {
            audioPipeline.start();
            log(TAG, "audio toggled ON via overlay command");
          }
        } else if (msg.action === "switch_device") {
          const current = audioPipeline.getDevice();
          const alt = config.audioAltDevice;
          const next = current === config.audioConfig.device
            ? alt
            : config.audioConfig.device;
          audioPipeline.switchDevice(next);
          wsServer.broadcast(`Audio device → ${next}`, "normal");
          log(TAG, `audio device switched: ${current} → ${next}`);
        }
        log(TAG, `command processed: ${msg.action}`);
        break;
      }
    }
  });

  // ── Start services ──
  try {
    await wsServer.start();
  } catch (err) {
    error(TAG, "failed to start WebSocket server:", err);
    process.exit(1);
  }

  // Start polling OpenClaw for responses
  openclawClient.startPolling(3000);

  // Auto-start audio if configured
  if (config.audioConfig.autoStart) {
    log(TAG, "auto-starting audio pipeline...");
    audioPipeline.start();
  } else {
    log(TAG, "audio pipeline ready (not auto-started — send toggle_audio command or set AUDIO_AUTO_START=true)");
  }

  log(TAG, "✓ Bridge running");
  log(TAG, `  overlay:  ws://127.0.0.1:${config.wsPort}`);
  log(TAG, `  gateway:  ${config.openclawGatewayUrl}`);
  log(TAG, `  audio:    ${config.audioConfig.autoStart ? "active" : "standby"}`);

  // ── Graceful shutdown ──
  const shutdown = async (signal: string) => {
    log(TAG, `${signal} received, shutting down...`);
    audioPipeline.stop();
    transcription.destroy();
    contextRelay.destroy();
    openclawClient.destroy();
    await wsServer.destroy();
    log(TAG, "goodbye");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep alive
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
