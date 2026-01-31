import { EventEmitter } from "node:events";
import { log, warn } from "./log.js";

const TAG = "sense";

export interface SenseEventMeta {
  id: number;
  type: "text" | "visual" | "context";
  ts: number;
  ocr: string;
  meta: {
    ssim: number;
    app: string;
    screen: number;
  };
}

/**
 * Polls /sense?meta_only=true for screen capture events.
 * Emits 'sense' for each new event and 'app_change' on app switches.
 */
export class SensePoller extends EventEmitter {
  private lastSeenId = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private currentApp = "";

  constructor(private relayUrl: string) {
    super();
  }

  startPolling(intervalMs = 5000): void {
    if (this.pollTimer) return;
    log(TAG, `polling started (${intervalMs}ms interval)`);
    this.pollTimer = setInterval(() => this.poll(), intervalMs);
    this.poll(); // initial poll
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      log(TAG, "polling stopped");
    }
  }

  isPolling(): boolean {
    return this.pollTimer !== null;
  }

  private async poll(): Promise<void> {
    try {
      const url = `${this.relayUrl}/sense?after=${this.lastSeenId}&meta_only=true`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return;

      const data = (await resp.json()) as { events: SenseEventMeta[] };
      if (!data.events?.length) return;

      for (const event of data.events) {
        this.lastSeenId = event.id;

        // Detect app change
        if (event.meta?.app && event.meta.app !== this.currentApp) {
          const prev = this.currentApp;
          this.currentApp = event.meta.app;
          if (prev) {
            this.emit("app_change", event.meta.app);
          }
        }

        this.emit("sense", event);
      }
    } catch (e) {
      // Silently ignore poll failures — relay might be down
    }
  }

  destroy(): void {
    this.stopPolling();
    this.removeAllListeners();
  }
}
