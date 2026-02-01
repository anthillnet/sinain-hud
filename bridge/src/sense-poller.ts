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
    windowTitle?: string;
    screen: number;
  };
}

/**
 * Polls /sense?meta_only=true for screen capture events.
 * Emits 'sense' for each new event, 'app_change' on app switches,
 * and 'window_change' on window title changes.
 */
export class SensePoller extends EventEmitter {
  private lastSeenId = 0;
  private lastEpoch = "";
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private currentApp = "";
  private currentWindow = "";

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

      const data = (await resp.json()) as { events: SenseEventMeta[]; epoch?: string };

      // Detect relay restart via epoch change
      if (data.epoch && this.lastEpoch && data.epoch !== this.lastEpoch) {
        log(TAG, `relay epoch changed (${this.lastEpoch} → ${data.epoch}) — resetting cursor from ${this.lastSeenId}`);
        this.lastSeenId = 0;
      }
      if (data.epoch) {
        this.lastEpoch = data.epoch;
      }

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

        // Detect window title change
        const winTitle = event.meta?.windowTitle || "";
        if (winTitle && winTitle !== this.currentWindow) {
          this.currentWindow = winTitle;
          this.emit("window_change", event.meta.app, winTitle);
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
