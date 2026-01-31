import { loadConfig } from "./config.js";
import { WsServer } from "./ws-server.js";
import { OpenClawClient } from "./openclaw-client.js";
import { ContextManager } from "./context-manager.js";
import { ContextRelay } from "./context-relay.js";
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
        // Commands are handled by WsServer internally (state updates).
        // Log for observability.
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

  log(TAG, "✓ Bridge running");
  log(TAG, `  overlay:  ws://127.0.0.1:${config.wsPort}`);
  log(TAG, `  gateway:  ${config.openclawGatewayUrl}`);

  // ── Graceful shutdown ──
  const shutdown = async (signal: string) => {
    log(TAG, `${signal} received, shutting down...`);
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
