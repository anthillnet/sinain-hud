import type { FeedItem, Priority, FeedChannel } from "../types.js";

/**
 * Ring buffer for all feed items (audio transcripts, agent HUD, OpenClaw responses, system).
 * Single source of truth — replaces both relay's messages[] and bridge's OpenClawClient polling.
 */
export class FeedBuffer {
  private items: FeedItem[] = [];
  private nextId = 1;
  private _version = 0;
  private maxSize: number;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
  }

  /** Push a new feed item. Returns the created item. */
  push(text: string, priority: Priority, source: FeedItem["source"], channel: FeedChannel = "stream"): FeedItem {
    const item: FeedItem = {
      id: this.nextId++,
      text,
      priority,
      ts: Date.now(),
      source,
      channel,
    };
    this.items.push(item);
    if (this.items.length > this.maxSize) {
      this.items.shift();
    }
    this._version++;
    return item;
  }

  /** Query items with id > after. Excludes [PERIODIC] items from overlay responses. */
  query(after = 0): FeedItem[] {
    return this.items.filter(m => m.id > after && !m.text.startsWith("[PERIODIC]"));
  }

  /** Query items by source within a time window. */
  queryBySource(source: string, since = 0): FeedItem[] {
    return this.items.filter(m => m.source === source && m.ts >= since);
  }

  /** Query all items within a time window. */
  queryByTime(since: number): FeedItem[] {
    return this.items.filter(m => m.ts >= since);
  }

  /** Get the latest feed item, or null if empty. */
  latest(): FeedItem | null {
    return this.items.length > 0 ? this.items[this.items.length - 1] : null;
  }

  /** Current number of items. */
  get size(): number {
    return this.items.length;
  }

  /** Monotonically increasing version — bumps on every push. */
  get version(): number {
    return this._version;
  }
}
