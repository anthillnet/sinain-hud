import type { SenseEvent } from "../types.js";

/**
 * Ring buffer for screen capture events from sense_client.
 * Stores OCR text, app context, SSIM scores.
 * Single source of truth — replaces relay's senseBuffer + bridge's SensePoller.
 */
export class SenseBuffer {
  private events: SenseEvent[] = [];
  private nextId = 1;
  private _version = 0;
  private maxSize: number;

  constructor(maxSize = 30) {
    this.maxSize = maxSize;
  }

  /** Push a new sense event (auto-assigns id and receivedAt). */
  push(raw: Omit<SenseEvent, "id" | "receivedAt">): SenseEvent {
    const event: SenseEvent = {
      ...raw,
      id: this.nextId++,
      receivedAt: Date.now(),
    };
    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events.shift();
    }
    this._version++;
    return event;
  }

  /** Query events with id > after. Optionally strip image data. */
  query(after = 0, metaOnly = false): SenseEvent[] {
    let results = this.events.filter(e => e.id > after);
    if (metaOnly) {
      results = results.map(e => {
        const stripped = { ...e } as any;
        if (stripped.roi) {
          stripped.roi = { ...stripped.roi };
          delete stripped.roi.data;
        }
        if (stripped.diff) {
          stripped.diff = { ...stripped.diff };
          delete stripped.diff.data;
        }
        return stripped;
      });
    }
    return results;
  }

  /** Query events within a time window (by receivedAt). */
  queryByTime(since: number): SenseEvent[] {
    return this.events.filter(e => e.receivedAt >= since);
  }

  /** Get the most recent app name, or 'unknown'. */
  latestApp(): string {
    if (this.events.length === 0) return "unknown";
    return this.events[this.events.length - 1].meta.app || "unknown";
  }

  /** Get distinct app transition timeline within a time window. */
  appHistory(since = 0): { app: string; ts: number }[] {
    const history: { app: string; ts: number }[] = [];
    let lastApp = "";
    for (const e of this.events) {
      if (since > 0 && e.receivedAt < since) continue;
      const app = e.meta.app || "unknown";
      if (app !== lastApp) {
        history.push({ app, ts: e.ts });
        lastApp = app;
      }
    }
    return history;
  }

  /** Get latest event. */
  latest(): SenseEvent | null {
    return this.events.length > 0 ? this.events[this.events.length - 1] : null;
  }

  /** Current number of events. */
  get size(): number {
    return this.events.length;
  }

  /** Monotonically increasing version — bumps on every push. */
  get version(): number {
    return this._version;
  }
}
