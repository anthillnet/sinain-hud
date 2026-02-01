import type { TranscriptEntry } from "./types.js";
import { log } from "./log.js";

const TAG = "ctx-mgr";
const WINDOW_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Rolling window of recent context.
 * Keeps transcript entries from the last 2 minutes.
 */
export class ContextManager {
  private entries: TranscriptEntry[] = [];

  /** Add a transcript entry and prune stale ones */
  add(text: string, source: string = "overlay"): TranscriptEntry {
    this.prune();
    const entry: TranscriptEntry = { text, source, ts: Date.now() };
    this.entries.push(entry);
    log(TAG, `+entry src=${source} len=${text.length} total=${this.entries.length}`);
    return entry;
  }

  /** Get all entries within the rolling window */
  get(): TranscriptEntry[] {
    this.prune();
    return [...this.entries];
  }

  /** Get entries since a given timestamp */
  getSince(since: number): TranscriptEntry[] {
    this.prune();
    return this.entries.filter((e) => e.ts >= since);
  }

  /** Clear all entries */
  clear(): void {
    const count = this.entries.length;
    this.entries = [];
    log(TAG, `cleared ${count} entries`);
  }

  /** Number of entries in window */
  get size(): number {
    this.prune();
    return this.entries.length;
  }

  /**
   * Simple summary: concatenate recent entries.
   * Future: replace with LLM-based summarization.
   */
  summarize(maxEntries: number = 10): string {
    this.prune();
    const recent = this.entries.slice(-maxEntries);
    if (recent.length === 0) return "(no recent context)";

    return recent
      .map((e) => {
        const ago = Math.round((Date.now() - e.ts) / 1000);
        return `[${ago}s ago, ${e.source}] ${e.text}`;
      })
      .join("\n");
  }

  /** Remove entries older than the rolling window */
  private prune(): void {
    const cutoff = Date.now() - WINDOW_MS;
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.ts >= cutoff);
    const pruned = before - this.entries.length;
    if (pruned > 0) {
      log(TAG, `pruned ${pruned} stale entries`);
    }
  }
}
