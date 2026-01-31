import type { BridgeConfig, Priority } from "./types.js";
import { log, warn, error } from "./log.js";

const TAG = "openclaw";

type FeedCallback = (text: string, priority: Priority) => void;

/**
 * Client for the SinainHUD relay server.
 * Polls for new feed messages pushed by Sinain.
 */
export class OpenClawClient {
  private gatewayUrl: string;
  private token: string;
  private sessionKey: string;
  private onFeed: FeedCallback | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeenId: number = 0;
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

  /** Send a message to Sinain via the relay's POST /feed endpoint */
  async sendMessage(text: string, priority: Priority = "normal"): Promise<boolean> {
    const url = `${this.gatewayUrl}/feed`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, priority }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        warn(TAG, `✘ POST /feed failed: ${res.status} ${res.statusText}`);
        return false;
      }
      const body = (await res.json()) as { ok?: boolean; id?: number };
      log(TAG, `→ feed posted #${body.id ?? "?"} (${priority}): ${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`);
      return true;
    } catch (err) {
      warn(TAG, `POST /feed error:`, err instanceof Error ? err.message : err);
      return false;
    }
  }

  /** Start polling the relay for new feed messages */
  startPolling(intervalMs: number = 3000): void {
    if (this.pollTimer) return;
    log(TAG, `polling relay at ${this.gatewayUrl}/feed every ${intervalMs}ms`);
    this.pollTimer = setInterval(() => this.poll(), intervalMs);
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

  get isConnected(): boolean {
    return this.connected;
  }

  /** Poll the relay for new messages */
  private async poll(): Promise<void> {
    const url = `${this.gatewayUrl}/feed?after=${this.lastSeenId}`;

    try {
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        if (this.connected) {
          warn(TAG, `poll: ${res.status} ${res.statusText}`);
        }
        this.connected = false;
        return;
      }

      if (!this.connected) {
        log(TAG, "relay connected");
      }
      this.connected = true;

      const data = (await res.json()) as {
        messages: Array<{ id: number; text: string; priority: Priority; ts: number }>;
      };
      const messages = data.messages ?? [];

      for (const msg of messages) {
        if (msg.id > this.lastSeenId) {
          this.lastSeenId = msg.id;
        }

        log(
          TAG,
          `← feed #${msg.id} (${msg.priority}): ${msg.text.slice(0, 100)}${msg.text.length > 100 ? "..." : ""}`
        );

        if (this.onFeed) {
          this.onFeed(msg.text, msg.priority);
        }
      }
    } catch (err) {
      if (this.connected) {
        warn(TAG, `poll error:`, err instanceof Error ? err.message : err);
        this.connected = false;
      }
    }
  }

  /** Graceful shutdown */
  destroy(): void {
    this.stopPolling();
    this.connected = false;
  }
}
