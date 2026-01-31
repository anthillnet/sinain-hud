import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../config.js";

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant env vars
    delete process.env.OPENCLAW_GATEWAY_URL;
    delete process.env.OPENCLAW_TOKEN;
    delete process.env.OPENCLAW_SESSION_KEY;
    delete process.env.WS_PORT;
    delete process.env.RELAY_MIN_INTERVAL_MS;
  });

  afterEach(() => {
    // Restore
    Object.assign(process.env, originalEnv);
  });

  it("returns defaults when no env vars set", () => {
    const config = loadConfig();
    expect(config.wsPort).toBe(9500);
    expect(config.relayMinIntervalMs).toBe(30_000);
    expect(config.openclawGatewayUrl).toBe("http://localhost:3000");
  });

  it("reads from env vars", () => {
    process.env.OPENCLAW_GATEWAY_URL = "http://example.com";
    process.env.OPENCLAW_TOKEN = "test-token";
    process.env.WS_PORT = "8080";
    process.env.RELAY_MIN_INTERVAL_MS = "5000";

    const config = loadConfig();
    expect(config.openclawGatewayUrl).toBe("http://example.com");
    expect(config.openclawToken).toBe("test-token");
    expect(config.wsPort).toBe(8080);
    expect(config.relayMinIntervalMs).toBe(5000);
  });
});
