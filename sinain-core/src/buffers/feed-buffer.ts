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
  private _hwm = 0;
  private _onFullCb: ((items: FeedItem[]) => void) | null = null;
  private _onFullArmed = true;
  private _onFullVersion = 0; // version at last re-arm

  /**
   * @param maxSize hard item cap (backstop against runaway memory)
   * @param horizonMs optional time horizon — items older than this are evicted
   *   on push, turning the ring into a rolling window ("deliberate capture").
   *   When set, maxSize should be raised well above the count-based default.
   */
  constructor(maxSize = 100, private horizonMs = 0) {
    this.maxSize = maxSize;
  }

  /**
   * Register a callback that fires when the buffer reaches capacity AND
   * at least half the buffer has been replaced with new items since the
   * last distillation. This prevents rapid-fire triggers on the same content.
   */
  onFull(cb: (items: FeedItem[]) => void): void {
    this._onFullCb = cb;
    this._onFullArmed = true;
    this._onFullVersion = 0;
  }

  /** Re-arm the onFull callback (call after incremental distillation completes). */
  rearmOnFull(): void {
    this._onFullVersion = this._version;
    this._onFullArmed = true;
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
    if (this.items.length > this._hwm) this._hwm = this.items.length;

    // Fire when enough new items have arrived since last distillation.
    // 20 items ≈ 1.7 min of audio at ~12 items/min transcription rate.
    // Distillation takes ~7s, so 20-item threshold gives 100s gap — safe margin.
    // This means ~35 passes/hour, leaving <20 items undistilled at shutdown.
    const newSinceRearm = this._version - this._onFullVersion;
    if (this.items.length >= 20
        && this._onFullCb && this._onFullArmed
        && newSinceRearm >= 20) {
      this._onFullArmed = false;
      const snapshot = [...this.items];
      queueMicrotask(() => this._onFullCb!(snapshot));
    }

    if (this.horizonMs > 0) {
      const cutoff = Date.now() - this.horizonMs;
      // Single splice — a shift() loop is O(n²) when many items age out at once.
      let firstLive = 0;
      while (firstLive < this.items.length && this.items[firstLive].ts < cutoff) firstLive++;
      if (firstLive > 0) this.items.splice(0, firstLive);
    }
    if (this.items.length > this.maxSize) {
      this.items.shift();
    }
    this._version++;
    return item;
  }

  /** High-water mark: max number of items ever held simultaneously. */
  get hwm(): number {
    return this._hwm;
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
