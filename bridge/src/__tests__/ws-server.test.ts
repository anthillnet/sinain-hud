import { describe, it, expect, afterEach } from "vitest";
import { WsServer } from "../ws-server.js";
import { WebSocket } from "ws";
import type { BridgeConfig } from "../types.js";

const testConfig: BridgeConfig = {
  openclawGatewayUrl: "http://localhost:18791",
  openclawToken: "test",
  openclawSessionKey: "test",
  wsPort: 0, // random port
  relayMinIntervalMs: 30000,
  audioConfig: {
    device: "default",
    sampleRate: 16000,
    channels: 1,
    chunkDurationMs: 10000,
    vadEnabled: true,
    vadThreshold: 0.01,
    captureCommand: "sox",
    autoStart: false,
    gainDb: 0,
  },
  audioAltDevice: "BlackHole 2ch",
  transcriptionConfig: {
    backend: "openrouter",
    awsRegion: "eu-west-1",
    awsAccessKeyId: "",
    awsSecretAccessKey: "",
    openrouterApiKey: "",
    geminiModel: "google/gemini-2.5-flash",
    refineIntervalMs: 30000,
    language: "en-US",
  },
  triggerConfig: {
    enabled: false,
    model: "google/gemini-2.5-flash",
    apiKey: "",
  },
  senseConfig: {
    enabled: false,
    pollIntervalMs: 5000,
  },
};

describe("WsServer", () => {
  let server: WsServer;

  afterEach(async () => {
    if (server) await server.destroy();
  });

  it("starts and accepts connections", async () => {
    // Use a random high port to avoid conflicts
    const port = 19000 + Math.floor(Math.random() * 1000);
    server = new WsServer({ ...testConfig, wsPort: port });
    await server.start();

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const connected = await new Promise<boolean>((resolve) => {
      ws.on("open", () => resolve(true));
      ws.on("error", () => resolve(false));
      setTimeout(() => resolve(false), 3000);
    });

    expect(connected).toBe(true);
    expect(server.clientCount).toBe(1);

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("sends status on connect", async () => {
    const port = 19000 + Math.floor(Math.random() * 1000);
    server = new WsServer({ ...testConfig, wsPort: port });
    await server.start();

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const msg = await new Promise<any>((resolve) => {
      ws.on("message", (data) => {
        resolve(JSON.parse(data.toString()));
      });
      setTimeout(() => resolve(null), 3000);
    });

    expect(msg).not.toBeNull();
    expect(msg.type).toBe("status");
    expect(msg).toHaveProperty("audio");
    expect(msg).toHaveProperty("connection");

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("broadcasts feed messages", async () => {
    const port = 19000 + Math.floor(Math.random() * 1000);
    server = new WsServer({ ...testConfig, wsPort: port });
    await server.start();

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);

    // Collect all messages
    const messages: any[] = [];
    ws.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    await new Promise<void>((resolve) => {
      ws.on("open", () => resolve());
    });

    // Wait for initial status message
    await new Promise((r) => setTimeout(r, 100));

    // Broadcast a feed message
    server.broadcast("test message", "high");
    await new Promise((r) => setTimeout(r, 200));

    const feed = messages.find((m) => m.type === "feed");
    expect(feed).toBeDefined();
    expect(feed.text).toBe("test message");
    expect(feed.priority).toBe("high");

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("handles incoming commands", async () => {
    const port = 19000 + Math.floor(Math.random() * 1000);
    server = new WsServer({ ...testConfig, wsPort: port });
    await server.start();

    let receivedMsg: any = null;
    server.onIncoming((msg) => {
      receivedMsg = msg;
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => {
      ws.on("open", () => resolve());
    });

    ws.send(JSON.stringify({ type: "command", action: "mute_audio" }));
    await new Promise((r) => setTimeout(r, 200));

    expect(receivedMsg).not.toBeNull();
    expect(receivedMsg.type).toBe("command");
    expect(receivedMsg.action).toBe("mute_audio");

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("tracks client count on disconnect", async () => {
    const port = 19000 + Math.floor(Math.random() * 1000);
    server = new WsServer({ ...testConfig, wsPort: port });
    await server.start();

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => {
      ws.on("open", () => resolve());
    });
    expect(server.clientCount).toBe(1);

    ws.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(server.clientCount).toBe(0);
  });
});
