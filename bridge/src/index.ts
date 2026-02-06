import { writeFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { WsServer } from "./ws-server.js";
import { OpenClawClient } from "./openclaw-client.js";
import { ContextManager } from "./context-manager.js";
import { ContextRelay } from "./context-relay.js";
import { AudioPipeline } from "./audio-pipeline.js";
import { IpcAudioCapture } from "./ipc-audio-capture.js";
import { TranscriptionService } from "./transcription.js";
import { SensePoller } from "./sense-poller.js";
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
  log(TAG, `sense: enabled=${config.senseConfig.enabled} poll=${config.senseConfig.pollIntervalMs}ms`);

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

  // ── Sense (screen capture) poller ──
  const sensePoller = new SensePoller(config.openclawGatewayUrl);
  let screenActive = false;
  const SENSE_CONTROL_FILE = "/tmp/sinain-sense-control.json";

  // ── Sense event formatting helpers ──
  const APP_SHORT_NAMES: Record<string, string> = {
    "IntelliJ IDEA": "IDEA",
    "IntelliJ IDEA Ultimate": "IDEA",
    "idea": "IDEA",
    "Google Chrome": "Chrome",
    "Microsoft Edge": "Edge",
    "Visual Studio Code": "Code",
    "Code - Insiders": "Code",
    "Sublime Text": "Sublime",
    "iTerm2": "iTerm",
    "Terminal": "Term",
    "Firefox": "Firefox",
    "Safari": "Safari",
    "Slack": "Slack",
    "Telegram": "TG",
    "WebStorm": "WS",
    "PyCharm": "PyCharm",
    "DataGrip": "DG",
    "Finder": "Finder",
  };
  function shortAppName(app: string): string {
    // Try exact match first, then case-insensitive
    if (APP_SHORT_NAMES[app]) return APP_SHORT_NAMES[app];
    const lower = app.toLowerCase();
    for (const [key, value] of Object.entries(APP_SHORT_NAMES)) {
      if (key.toLowerCase() === lower) return value;
    }
    return app;
  }

  sensePoller.on("sense", (event) => {
    wsServer.updateState({ screen: "active" });
    if (event.type === "text" && event.ocr && event.ocr.trim().length > 10) {
      const app = shortAppName(event.meta?.app || "");
      // Take first meaningful line only, skip multiline OCR noise
      const firstLine = event.ocr.split("\n").find((l: string) => l.trim().length > 5)?.trim() || event.ocr.split("\n")[0].trim();
      const text = firstLine.slice(0, 80);
      const prefix = app ? `${app}: ` : "";
      wsServer.broadcast(`[👁] ${prefix}${text}`, "normal");
    }
    // Don't broadcast visual events — reserved for future VLM agent
  });

  sensePoller.on("app_change", (app: string) => {
    contextRelay.setScreenContext(`Active app: ${app}`);
    wsServer.broadcast(`[👁] → ${shortAppName(app)}`, "normal");
  });

  sensePoller.on("window_change", (app: string, windowTitle: string) => {
    const short = shortAppName(app);
    wsServer.broadcast(`[👁] ${short} — ${windowTitle.slice(0, 60)}`, "normal");
  });

  // ── Audio pipeline ──
  const audioPipeline = (process.env.AUDIO_CAPTURE_MODE === "sox")
    ? new AudioPipeline(config.audioConfig)
    : new IpcAudioCapture();
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

  // ── Wire: OpenClaw responses → overlay feed (agent channel) ──
  openclawClient.onFeedItem((text, priority) => {
    wsServer.broadcast(text, priority, "agent");
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
            wsServer.broadcast("Audio capture stopped", "normal");
            log(TAG, "audio toggled OFF via overlay command");
          } else {
            audioPipeline.start();
            wsServer.broadcast("Audio capture started", "normal");
            log(TAG, "audio toggled ON via overlay command");
          }
        } else if (msg.action === "toggle_screen") {
          if (screenActive) {
            sensePoller.stopPolling();
            try { writeFileSync(SENSE_CONTROL_FILE, JSON.stringify({ enabled: false })); } catch {}
            wsServer.updateState({ screen: "off" });
            wsServer.broadcast("Screen capture stopped", "normal");
            screenActive = false;
            log(TAG, "screen capture toggled OFF");
          } else {
            sensePoller.startPolling(config.senseConfig.pollIntervalMs);
            try { writeFileSync(SENSE_CONTROL_FILE, JSON.stringify({ enabled: true })); } catch {}
            wsServer.updateState({ screen: "active" });
            wsServer.broadcast("Screen capture started", "normal");
            screenActive = true;
            log(TAG, "screen capture toggled ON");
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
  log(TAG, `  sense:    ${config.senseConfig.enabled ? "enabled" : "standby"}`);

  // Auto-start sense polling if configured
  if (config.senseConfig.enabled) {
    log(TAG, "auto-starting sense poller...");
    sensePoller.startPolling(config.senseConfig.pollIntervalMs);
    screenActive = true;
    try { writeFileSync(SENSE_CONTROL_FILE, JSON.stringify({ enabled: true })); } catch {}
  }

  // ── Graceful shutdown ──
  const shutdown = async (signal: string) => {
    log(TAG, `${signal} received, shutting down...`);
    audioPipeline.stop();
    sensePoller.destroy();
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
