import type { BridgeConfig, Priority } from "./types.js";
import { log, warn, error } from "./log.js";

const TAG = "openclaw";

export interface OpenClawResponse {
  text: string;
  priority: Priority;
}

type FeedCallback = (text: string, priority: Priority) => void;

/**
 * Client for the OpenClaw gateway REST API.
 * Sends messages to Sinain's session and polls for responses.
 */
export class OpenClawClient {
  private gatewayUrl: string;
  private token: string;
  private sessionKey: string;
  private onFeed: FeedCallback | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeenId: string | null = null;
  private connected: boolean = false;

  constructor(config: BridgeConfig) {
    this.gatewayUrl = config.openclawGatewayUrl.replace(/\/$/, "");
    this.token = config.openclawToken;
    this.sessionKey = config.openclawSessionKey;
  }

  /** Register callback for incoming feed items from Sinain */
  onFeedItem(cb: FeedCallback): void {
    this.onFeed = cb;
  }

  /** Send a message to Sinain's session via the gateway */
  async sendMessage(text: string): Promise<boolean> {
    const payload = `[HUD] ${text}`;
    const url = `${this.gatewayUrl}/api/sessions/${encodeURIComponent(this.sessionKey)}/messages`;

    log(TAG, `→ sending: ${payload.slice(0, 80)}${payload.length > 80 ? "..." : ""}`);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({ message: payload }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        warn(TAG, `send failed: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
        return false;
      }

      log(TAG, `← sent OK (${res.status})`);
      this.connected = true;
      return true;
    } catch (err) {
      error(TAG, `send error:`, err instanceof Error ? err.message : err);
      this.connected = false;
      return false;
    }
  }

  /** Start polling for new responses from Sinain */
  startPolling(intervalMs: number = 3000): void {
    if (this.pollTimer) return;
    log(TAG, `polling every ${intervalMs}ms`);
    this.pollTimer = setInterval(() => this.poll(), intervalMs);
    // Initial poll
    this.poll();
  }

  /** Stop polling */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      log(TAG, "polling stopped");
    }
  }

  /** Check connection health */
  get isConnected(): boolean {
    return this.connected;
  }

  /** Single poll cycle: fetch new messages from the session */
  private async poll(): Promise<void> {
    const url = new URL(
      `${this.gatewayUrl}/api/sessions/${encodeURIComponent(this.sessionKey)}/messages`
    );
    if (this.lastSeenId) {
      url.searchParams.set("after", this.lastSeenId);
    }
    url.searchParams.set("limit", "10");

    try {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        // 404 = session doesn't exist yet, that's fine
        if (res.status !== 404) {
          warn(TAG, `poll: ${res.status} ${res.statusText}`);
        }
        this.connected = res.status !== 401 && res.status !== 403;
        return;
      }

      this.connected = true;
      const data = await res.json() as any;
      const messages: any[] = Array.isArray(data) ? data : data?.messages ?? [];

      for (const msg of messages) {
        // Skip messages we sent (they start with [HUD])
        const text: string = msg.text ?? msg.message ?? msg.content ?? "";
        if (text.startsWith("[HUD]")) continue;

        // Track last seen
        if (msg.id) this.lastSeenId = msg.id;

        // Determine priority from message content
        const priority = this.detectPriority(text);

        log(TAG, `← response (${priority}): ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);

        if (this.onFeed) {
          this.onFeed(text, priority);
        }
      }
    } catch (err) {
      // Network errors during polling are expected when gateway is down
      if (this.connected) {
        warn(TAG, `poll error:`, err instanceof Error ? err.message : err);
        this.connected = false;
      }
    }
  }

  /** Heuristic priority detection from response text */
  private detectPriority(text: string): Priority {
    const lower = text.toLowerCase();
    if (
      lower.includes("urgent") ||
      lower.includes("immediately") ||
      lower.includes("critical") ||
      lower.includes("⚠️") ||
      lower.includes("🚨")
    ) {
      return "urgent";
    }
    if (
      lower.includes("important") ||
      lower.includes("note:") ||
      lower.includes("warning") ||
      lower.includes("heads up")
    ) {
      return "high";
    }
    return "normal";
  }

  /** Graceful shutdown */
  destroy(): void {
    this.stopPolling();
    this.connected = false;
  }
}
