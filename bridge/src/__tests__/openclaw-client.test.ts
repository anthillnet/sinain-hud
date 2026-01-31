import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { OpenClawClient } from "../openclaw-client.js";
import type { BridgeConfig } from "../types.js";

describe("OpenClawClient", () => {
  let server: http.Server;
  let port: number;
  let feedMessages: Array<{ id: number; text: string; priority: string; ts: number }>;
  let nextId: number;

  beforeEach(async () => {
    feedMessages = [];
    nextId = 1;

    // Start a mock relay server
    server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");

      if (req.method === "GET" && req.url?.startsWith("/feed")) {
        const url = new URL(req.url, `http://localhost:${port}`);
        const after = parseInt(url.searchParams.get("after") || "0");
        const items = feedMessages.filter((m) => m.id > after);
        res.end(JSON.stringify({ messages: items }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        port = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("polls and receives feed messages", async () => {
    const config = {
      openclawGatewayUrl: `http://127.0.0.1:${port}`,
      openclawToken: "",
      openclawSessionKey: "",
      wsPort: 9500,
      relayMinIntervalMs: 30000,
    } as BridgeConfig;

    const client = new OpenClawClient(config);
    const received: string[] = [];
    client.onFeedItem((text) => {
      received.push(text);
    });

    // Add a message before polling
    feedMessages.push({ id: 1, text: "hello from relay", priority: "normal", ts: Date.now() });

    client.startPolling(100);
    await new Promise((r) => setTimeout(r, 300));

    expect(received).toContain("hello from relay");
    expect(client.isConnected).toBe(true);

    client.destroy();
  });

  it("tracks lastSeenId and doesn't re-deliver", async () => {
    const config = {
      openclawGatewayUrl: `http://127.0.0.1:${port}`,
      openclawToken: "",
      openclawSessionKey: "",
      wsPort: 9500,
      relayMinIntervalMs: 30000,
    } as BridgeConfig;

    const client = new OpenClawClient(config);
    const received: string[] = [];
    client.onFeedItem((text) => {
      received.push(text);
    });

    feedMessages.push({ id: 1, text: "first", priority: "normal", ts: Date.now() });

    client.startPolling(100);
    await new Promise((r) => setTimeout(r, 400));

    // Should only have "first" once despite multiple polls
    const firstCount = received.filter((t) => t === "first").length;
    expect(firstCount).toBe(1);

    // Add another message
    feedMessages.push({ id: 2, text: "second", priority: "high", ts: Date.now() });
    await new Promise((r) => setTimeout(r, 300));

    expect(received).toContain("second");

    client.destroy();
  });

  it("handles connection failure gracefully", async () => {
    const config = {
      openclawGatewayUrl: "http://127.0.0.1:1", // unreachable
      openclawToken: "",
      openclawSessionKey: "",
      wsPort: 9500,
      relayMinIntervalMs: 30000,
    } as BridgeConfig;

    const client = new OpenClawClient(config);
    client.startPolling(100);

    await new Promise((r) => setTimeout(r, 300));
    expect(client.isConnected).toBe(false);

    client.destroy();
  });
});
