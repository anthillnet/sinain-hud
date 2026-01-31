import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { ContextRelay } from "../context-relay.js";
import { ContextManager } from "../context-manager.js";
import type { BridgeConfig } from "../types.js";

// Mock OpenClawClient
function mockClient() {
  return {
    sendMessage: vi.fn().mockResolvedValue(true),
    onFeedItem: vi.fn(),
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
    destroy: vi.fn(),
    isConnected: true,
  };
}

const testConfig: BridgeConfig = {
  openclawGatewayUrl: "http://localhost:18791",
  openclawToken: "test",
  openclawSessionKey: "test",
  wsPort: 9500,
  relayMinIntervalMs: 100, // short for testing
};

describe("ContextRelay", () => {
  let cm: ContextManager;
  let client: ReturnType<typeof mockClient>;
  let relay: ContextRelay;

  beforeEach(() => {
    cm = new ContextManager();
    client = mockClient();
    relay = new ContextRelay(cm, client as any, testConfig);
  });

  afterEach(() => {
    relay.destroy();
  });

  it("ingests text and stores in context manager", () => {
    relay.ingest("hello", "mic");
    expect(cm.size).toBe(1);
  });

  it("deduplicates identical text", () => {
    relay.ingest("hello", "mic");
    const accepted = relay.ingest("hello", "mic");
    expect(accepted).toBe(false);
    expect(cm.size).toBe(1);
  });

  it("accepts different text", () => {
    relay.ingest("hello", "mic");
    relay.ingest("world", "mic");
    expect(cm.size).toBe(2);
  });

  it("rejects empty text", () => {
    const accepted = relay.ingest("", "mic");
    expect(accepted).toBe(false);
    expect(cm.size).toBe(0);
  });

  it("rejects whitespace-only text", () => {
    const accepted = relay.ingest("   \n  ", "mic");
    expect(accepted).toBe(false);
  });

  it("relayDirect sends immediately", async () => {
    const ok = await relay.relayDirect("urgent message");
    expect(ok).toBe(true);
    expect(client.sendMessage).toHaveBeenCalledWith("urgent message");
  });

  it("escalates after min interval", async () => {
    relay.ingest("something important", "transcript");
    // Wait for escalation timer
    await new Promise((r) => setTimeout(r, 200));
    expect(client.sendMessage).toHaveBeenCalled();
  });
});
