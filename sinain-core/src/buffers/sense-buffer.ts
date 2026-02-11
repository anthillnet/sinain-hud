import type { SenseEvent } from "../types.js";

/**
 * Delta change from semantic layer
 */
export interface TextDelta {
  type: "add" | "remove" | "modify" | "initial";
  location: string;
  delta: string;
  context?: string;
}

/**
 * Semantic context from new sense_client
 */
export interface SemanticContext {
  app: string;
  window: string;
  activity: string;
  duration_s: number;
}

/**
 * Extended sense event with semantic data
 */
export interface SemanticSenseEvent extends SenseEvent {
  // Semantic layer additions
  semantic?: {
    context: SemanticContext;
    changes: TextDelta[];
    visible?: {
      summary?: string;
      has_error?: boolean;
      has_unsaved?: boolean;
    };
  };
  // Priority from WebSocket sender
  priority?: "urgent" | "high" | "normal";
}

/**
 * Ring buffer for screen capture events from sense_client.
 * Stores OCR text, app context, SSIM scores, and recent images.
 * Single source of truth — replaces relay's senseBuffer + bridge's SensePoller.
 *
 * Image memory management: only the N most recent events retain imageData.
 * Older events have their imageData stripped to prevent unbounded memory growth.
 *
 * Smart deduplication: events with very high SSIM AND similar OCR are deduplicated
 * (configurable via SENSE_SSIM_DEDUP_THRESHOLD and SENSE_OCR_DEDUP_THRESHOLD).
 *
 * Delta support: accumulates text deltas for efficient context queries.
 */
export class SenseBuffer {
  private events: SemanticSenseEvent[] = [];
  private nextId = 1;
  private _version = 0;
  private maxSize: number;
  private maxImagesKept: number;
  private _hwm = 0;

  // Deduplication stats
  private _dedupCount = 0;

  // Configurable thresholds (conservative defaults)
  private ssimDedupThreshold: number;
  private ocrDedupThreshold: number;

  // Delta accumulation for efficient queries
  private _accumulatedDeltas: TextDelta[] = [];
  private _lastDeltaFlush = Date.now();

  // Activity tracking
  private _activityCounts: Map<string, number> = new Map();

  constructor(maxSize = 60, maxImagesKept = 5) {
    this.maxSize = maxSize;
    this.maxImagesKept = maxImagesKept;
    // Very conservative: only dedup when BOTH visual AND text are nearly identical
    this.ssimDedupThreshold = parseFloat(process.env.SENSE_SSIM_DEDUP_THRESHOLD || "0.97");
    this.ocrDedupThreshold = parseFloat(process.env.SENSE_OCR_DEDUP_THRESHOLD || "0.9");
  }

  /**
   * Push a new sense event (auto-assigns id and receivedAt).
   * Returns null if event was deduplicated (updates last event timestamp instead).
   */
  push(raw: Omit<SemanticSenseEvent, "id" | "receivedAt">): SemanticSenseEvent | null {
    // Smart deduplication: skip if BOTH visual AND text are nearly identical to last event
    if (this.events.length > 0) {
      const last = this.events[this.events.length - 1];
      const highSsim = raw.meta.ssim >= this.ssimDedupThreshold;
      const sameOcr = this.isOcrSimilar(raw.ocr, last.ocr);

      // Only dedup when BOTH conditions are met (conservative)
      if (highSsim && sameOcr) {
        // Update timestamp on existing event instead of creating new
        last.receivedAt = Date.now();
        this._dedupCount++;
        this._version++; // Still bump version so version-based checks work
        return null;
      }
    }

    const event: SemanticSenseEvent = {
      ...raw,
      id: this.nextId++,
      receivedAt: Date.now(),
    };

    // Track activity type
    if (event.semantic?.context?.activity) {
      const activity = event.semantic.context.activity;
      this._activityCounts.set(activity, (this._activityCounts.get(activity) || 0) + 1);
    }

    // Accumulate deltas
    if (event.semantic?.changes) {
      for (const delta of event.semantic.changes) {
        this._accumulatedDeltas.push(delta);
      }
      // Trim accumulated deltas (keep last 100)
      if (this._accumulatedDeltas.length > 100) {
        this._accumulatedDeltas = this._accumulatedDeltas.slice(-100);
      }
    }

    this.events.push(event);
    if (this.events.length > this._hwm) this._hwm = this.events.length;
    if (this.events.length > this.maxSize) {
      this.events.shift();
    }
    // Strip imageData from older events to manage memory
    this.trimImages();
    this._version++;
    return event;
  }

  /**
   * Push a delta-only update (no full event, just changes).
   * Used for efficient incremental updates.
   */
  pushDelta(data: {
    app: string;
    activity: string;
    changes: TextDelta[];
    priority?: "urgent" | "high" | "normal";
    ts: number;
  }): void {
    // Accumulate deltas
    for (const delta of data.changes) {
      this._accumulatedDeltas.push(delta);
    }

    // Update activity counts
    this._activityCounts.set(data.activity, (this._activityCounts.get(data.activity) || 0) + 1);

    // Trim accumulated deltas
    if (this._accumulatedDeltas.length > 100) {
      this._accumulatedDeltas = this._accumulatedDeltas.slice(-100);
    }

    this._version++;
  }

  /** Check if two OCR strings are similar enough to deduplicate. */
  private isOcrSimilar(ocr1: string | undefined, ocr2: string | undefined): boolean {
    // Both empty = similar
    if (!ocr1 && !ocr2) return true;
    // One empty, one not = different
    if (!ocr1 || !ocr2) return false;
    // Exact match = similar
    if (ocr1 === ocr2) return true;

    // Simple character-based similarity (faster than Levenshtein for long strings)
    const shorter = ocr1.length < ocr2.length ? ocr1 : ocr2;
    const longer = ocr1.length < ocr2.length ? ocr2 : ocr1;

    // If lengths differ significantly, they're different
    if (shorter.length / longer.length < this.ocrDedupThreshold) return false;

    // Check prefix similarity (fast heuristic - most OCR differences are at the end)
    const checkLen = Math.min(200, shorter.length);
    let matches = 0;
    for (let i = 0; i < checkLen; i++) {
      if (shorter[i] === longer[i]) matches++;
    }
    return matches / checkLen >= this.ocrDedupThreshold;
  }

  /** Get deduplication stats. */
  get dedupCount(): number {
    return this._dedupCount;
  }

  /** High-water mark: max number of events ever held simultaneously. */
  get hwm(): number {
    return this._hwm;
  }

  /** Query events with id > after. Optionally strip image data. */
  query(after = 0, metaOnly = false): SemanticSenseEvent[] {
    let results = this.events.filter(e => e.id > after);
    if (metaOnly) {
      results = results.map(e => {
        const stripped = { ...e } as any;
        delete stripped.imageData;
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
  queryByTime(since: number): SemanticSenseEvent[] {
    return this.events.filter(e => e.receivedAt >= since);
  }

  /**
   * Query with semantic filters.
   */
  querySemantic(options: {
    since?: number;
    activity?: string;
    hasError?: boolean;
    limit?: number;
  }): SemanticSenseEvent[] {
    let results = this.events;

    if (options.since) {
      results = results.filter(e => e.receivedAt >= options.since!);
    }

    if (options.activity) {
      results = results.filter(e =>
        e.semantic?.context?.activity === options.activity
      );
    }

    if (options.hasError !== undefined) {
      results = results.filter(e =>
        e.semantic?.visible?.has_error === options.hasError
      );
    }

    if (options.limit) {
      results = results.slice(-options.limit);
    }

    return results;
  }

  /**
   * Get accumulated deltas since last flush.
   */
  getAccumulatedDeltas(flush = false): TextDelta[] {
    const deltas = [...this._accumulatedDeltas];
    if (flush) {
      this._accumulatedDeltas = [];
      this._lastDeltaFlush = Date.now();
    }
    return deltas;
  }

  /**
   * Get activity breakdown for a time window.
   */
  getActivityBreakdown(since = 0): Record<string, number> {
    if (since === 0) {
      return Object.fromEntries(this._activityCounts);
    }

    const counts: Record<string, number> = {};
    for (const e of this.events) {
      if (e.receivedAt >= since && e.semantic?.context?.activity) {
        const activity = e.semantic.context.activity;
        counts[activity] = (counts[activity] || 0) + 1;
      }
    }
    return counts;
  }

  /** Get recent events that have imageData, newest first. */
  recentImages(count: number): SemanticSenseEvent[] {
    const withImages: SemanticSenseEvent[] = [];
    for (let i = this.events.length - 1; i >= 0 && withImages.length < count; i--) {
      if (this.events[i].imageData) {
        withImages.push(this.events[i]);
      }
    }
    return withImages;
  }

  /** Get the most recent app name, or 'unknown'. */
  latestApp(): string {
    if (this.events.length === 0) return "unknown";
    const last = this.events[this.events.length - 1];
    return last.semantic?.context?.app || last.meta.app || "unknown";
  }

  /** Get current activity type. */
  latestActivity(): string {
    if (this.events.length === 0) return "unknown";
    return this.events[this.events.length - 1].semantic?.context?.activity || "unknown";
  }

  /** Get distinct app transition timeline within a time window. */
  appHistory(since = 0): { app: string; ts: number }[] {
    const history: { app: string; ts: number }[] = [];
    let lastApp = "";
    for (const e of this.events) {
      if (since > 0 && e.receivedAt < since) continue;
      const app = e.semantic?.context?.app || e.meta.app || "unknown";
      if (app !== lastApp) {
        history.push({ app, ts: e.ts });
        lastApp = app;
      }
    }
    return history;
  }

  /** Get latest event. */
  latest(): SemanticSenseEvent | null {
    return this.events.length > 0 ? this.events[this.events.length - 1] : null;
  }

  /**
   * Get structured context for agent consumption.
   * This is the new semantic-aware endpoint.
   */
  getStructuredContext(options: {
    limit?: number;
    includeDeltas?: boolean;
    includeSummary?: boolean;
  } = {}): object {
    const limit = options.limit || 10;
    const recent = this.events.slice(-limit);
    const now = Date.now();

    if (recent.length === 0) {
      return {
        context: { app: "unknown", activity: "unknown" },
        events: [],
        deltas: options.includeDeltas ? [] : undefined,
      };
    }

    const latest = recent[recent.length - 1];

    return {
      context: {
        app: latest.semantic?.context?.app || latest.meta.app || "unknown",
        window: latest.semantic?.context?.window || latest.meta.windowTitle || "",
        activity: latest.semantic?.context?.activity || "unknown",
        duration_s: latest.semantic?.context?.duration_s || 0,
      },
      events: recent.map(e => ({
        id: e.id,
        ago_s: Math.round((now - e.receivedAt) / 1000),
        activity: e.semantic?.context?.activity || e.type,
        has_error: e.semantic?.visible?.has_error,
      })),
      visible: options.includeSummary ? {
        summary: latest.semantic?.visible?.summary,
        has_error: latest.semantic?.visible?.has_error,
        has_unsaved: latest.semantic?.visible?.has_unsaved,
      } : undefined,
      deltas: options.includeDeltas ? this._accumulatedDeltas.slice(-20) : undefined,
      meta: {
        ts: now,
        event_count: recent.length,
      },
    };
  }

  /** Current number of events. */
  get size(): number {
    return this.events.length;
  }

  /** Monotonically increasing version — bumps on every push. */
  get version(): number {
    return this._version;
  }

  /** Strip imageData from events beyond the most recent maxImagesKept. */
  private trimImages(): void {
    let imagesFound = 0;
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].imageData) {
        imagesFound++;
        if (imagesFound > this.maxImagesKept) {
          delete this.events[i].imageData;
          delete this.events[i].imageBbox;
        }
      }
    }
  }
}
