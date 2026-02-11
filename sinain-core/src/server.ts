import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { CoreConfig, SenseEvent } from "./types.js";
import type { Profiler } from "./profiler.js";
import { FeedBuffer } from "./buffers/feed-buffer.js";
import { SenseBuffer, type SemanticSenseEvent, type TextDelta } from "./buffers/sense-buffer.js";
import { WsHandler } from "./overlay/ws-handler.js";
import { log, error } from "./log.js";

const TAG = "server";
const MAX_SENSE_BODY = 2 * 1024 * 1024;

/** Server epoch — lets clients detect restarts. */
const serverEpoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export interface ServerDeps {
  config: CoreConfig;
  feedBuffer: FeedBuffer;
  senseBuffer: SenseBuffer;
  wsHandler: WsHandler;
  profiler?: Profiler;
  onSenseEvent: (event: SenseEvent) => void;
  onSenseDelta: (data: { app: string; activity: string; changes: TextDelta[]; priority?: string; ts: number }) => void;
  onFeedPost: (text: string, priority: string) => void;
  onSenseProfile: (snapshot: any) => void;
  getHealthPayload: () => Record<string, unknown>;
  getAgentDigest: () => unknown;
  getAgentHistory: (limit: number) => unknown[];
  getAgentContext: () => unknown;
  getAgentConfig: () => unknown;
  updateAgentConfig: (updates: Record<string, unknown>) => unknown;
  getTraces: (after: number, limit: number) => unknown[];
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export function createAppServer(deps: ServerDeps) {
  const { config, feedBuffer, senseBuffer, wsHandler } = deps;
  let senseInBytes = 0;

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://localhost:${config.port}`);

    try {
      // ── /sense ──
      if (req.method === "POST" && url.pathname === "/sense") {
        const body = await readBody(req, MAX_SENSE_BODY);
        senseInBytes += Buffer.byteLength(body);
        deps.profiler?.gauge("network.senseInBytes", senseInBytes);
        const data = JSON.parse(body);
        if (!data.type || data.ts === undefined) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: "missing type or ts" }));
          return;
        }
        // Extract image data from ROI if present
        const imageData = data.roi?.data || undefined;
        const imageBbox = data.roi?.bbox || undefined;

        const event = senseBuffer.push({
          type: data.type,
          ts: data.ts,
          ocr: data.ocr || "",
          imageData,
          imageBbox,
          meta: {
            ssim: data.meta?.ssim ?? 0,
            app: data.meta?.app || "unknown",
            windowTitle: data.meta?.windowTitle,
            screen: data.meta?.screen ?? 0,
          },
        });
        if (event) {
          log(TAG, `[sense] #${event.id} (${event.type}): app=${event.meta.app} ssim=${event.meta.ssim?.toFixed(3)}`);
          deps.onSenseEvent(event);
          res.end(JSON.stringify({ ok: true, id: event.id }));
        } else {
          // Event was deduplicated
          res.end(JSON.stringify({ ok: true, deduplicated: true }));
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/sense") {
        const after = parseInt(url.searchParams.get("after") || "0");
        const metaOnly = url.searchParams.get("meta_only") === "true";
        const events = senseBuffer.query(after, metaOnly);
        res.end(JSON.stringify({ events, epoch: serverEpoch }));
        return;
      }

      // ── /sense/context (structured semantic context) ──
      if (req.method === "GET" && url.pathname === "/sense/context") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "10"), 50);
        const includeDeltas = url.searchParams.get("include_deltas") === "true";
        const includeSummary = url.searchParams.get("include_summary") !== "false";
        const context = senseBuffer.getStructuredContext({
          limit,
          includeDeltas,
          includeSummary,
        });
        res.end(JSON.stringify({ ok: true, context, epoch: serverEpoch }));
        return;
      }

      // ── /sense/activity (activity breakdown) ──
      if (req.method === "GET" && url.pathname === "/sense/activity") {
        const since = parseInt(url.searchParams.get("since") || "0");
        const breakdown = senseBuffer.getActivityBreakdown(since);
        res.end(JSON.stringify({
          ok: true,
          activity: senseBuffer.latestActivity(),
          breakdown,
          epoch: serverEpoch,
        }));
        return;
      }

      // ── /sense/deltas (accumulated deltas) ──
      if (req.method === "GET" && url.pathname === "/sense/deltas") {
        const flush = url.searchParams.get("flush") === "true";
        const deltas = senseBuffer.getAccumulatedDeltas(flush);
        res.end(JSON.stringify({ ok: true, deltas, count: deltas.length }));
        return;
      }

      // ── /feed ──
      if (req.method === "GET" && url.pathname === "/feed") {
        const after = parseInt(url.searchParams.get("after") || "0");
        const items = feedBuffer.query(after);
        res.end(JSON.stringify({ messages: items, epoch: serverEpoch }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/feed") {
        const body = await readBody(req, 65536);
        const { text, priority } = JSON.parse(body);
        deps.onFeedPost(text, priority || "normal");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── /agent ──
      if (req.method === "GET" && url.pathname === "/agent/digest") {
        res.end(JSON.stringify({ ok: true, digest: deps.getAgentDigest() }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/agent/history") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "10"), 50);
        res.end(JSON.stringify({ ok: true, results: deps.getAgentHistory(limit) }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/agent/context") {
        res.end(JSON.stringify({ ok: true, context: deps.getAgentContext() }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/agent/config") {
        res.end(JSON.stringify({ ok: true, config: deps.getAgentConfig() }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/agent/config") {
        const body = await readBody(req, 4096);
        const updates = JSON.parse(body);
        const result = deps.updateAgentConfig(updates);
        res.end(JSON.stringify({ ok: true, config: result }));
        return;
      }

      // ── /traces ──
      if (req.method === "GET" && url.pathname === "/traces") {
        const after = parseInt(url.searchParams.get("after") || "0");
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 500);
        res.end(JSON.stringify({ traces: deps.getTraces(after, limit) }));
        return;
      }

      // ── /profiling/sense ──
      if (req.method === "POST" && url.pathname === "/profiling/sense") {
        const body = await readBody(req, 4096);
        deps.onSenseProfile(JSON.parse(body));
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── /health ──
      if (req.method === "GET" && url.pathname === "/health") {
        res.end(JSON.stringify({
          ok: true,
          epoch: serverEpoch,
          messages: feedBuffer.size,
          senseEvents: senseBuffer.size,
          overlayClients: wsHandler.clientCount,
          ...deps.getHealthPayload(),
        }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
    } catch (err: any) {
      const status = err.message === "body too large" ? 413 : 400;
      res.writeHead(status);
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });

  // Attach WS server on the same HTTP server
  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws, req) => {
    const pathname = new URL(req.url || "/", `http://localhost:${config.port}`).pathname;

    // Sense WebSocket endpoint for low-latency event streaming
    if (pathname === "/sense/ws") {
      log(TAG, "[sense/ws] client connected");

      // Backpressure tracking
      let pendingAcks = 0;
      const MAX_PENDING = 5;

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());

          // Handle different message types
          if (msg.type === "delta") {
            // Delta-only update (new semantic format)
            senseBuffer.pushDelta({
              app: msg.app || "unknown",
              activity: msg.activity || "unknown",
              changes: msg.changes || [],
              priority: msg.priority,
              ts: msg.ts || Date.now(),
            });

            // Trigger immediate context update for urgent priority
            if (msg.priority === "urgent") {
              deps.onSenseDelta(msg);
            }

            // Send ack with backpressure signal
            pendingAcks++;
            const backpressure = pendingAcks > MAX_PENDING ? 100 : 0;
            ws.send(JSON.stringify({ type: "ack", backpressure }));
            pendingAcks = Math.max(0, pendingAcks - 1);

          } else {
            // Full event (backwards compatible)
            const imageData = msg.roi?.data || undefined;
            const imageBbox = msg.roi?.bbox || undefined;

            const event = senseBuffer.push({
              type: msg.type,
              ts: msg.ts,
              ocr: msg.ocr || "",
              imageData,
              imageBbox,
              meta: {
                ssim: msg.meta?.ssim ?? 0,
                app: msg.meta?.app || "unknown",
                windowTitle: msg.meta?.windowTitle,
                screen: msg.meta?.screen ?? 0,
              },
              semantic: msg.semantic,
              priority: msg.priority,
            });

            if (event) {
              deps.onSenseEvent(event);

              // Send ack with event ID
              pendingAcks++;
              const backpressure = pendingAcks > MAX_PENDING ? 100 : 0;
              ws.send(JSON.stringify({ type: "ack", id: event.id, backpressure }));
              pendingAcks = Math.max(0, pendingAcks - 1);
            } else {
              // Deduplicated
              ws.send(JSON.stringify({ type: "ack", deduplicated: true }));
            }
          }
        } catch (err: any) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
      });

      ws.on("close", () => {
        log(TAG, "[sense/ws] client disconnected");
      });

      ws.on("error", (err) => {
        error(TAG, `[sense/ws] error: ${err.message}`);
      });

      return;
    }

    // Default: overlay WebSocket handler
    wsHandler.handleConnection(ws, req);
  });

  return {
    httpServer,
    wss,
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        httpServer.on("error", reject);
        httpServer.listen(config.port, "0.0.0.0", () => {
          log(TAG, `listening on http://0.0.0.0:${config.port} (HTTP + WS, epoch=${serverEpoch})`);
          resolve();
        });
      });
    },
    async destroy(): Promise<void> {
      wsHandler.destroy();
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      log(TAG, "server closed");
    },
  };
}
