import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { log, warn, error } from "../log.js";

const TAG = "outbound-queue";

const STORE_DIR = path.join(os.homedir(), ".sinain-core");
const STORE_PATH = path.join(STORE_DIR, "outbound-queue.json");

const MAX_RETRIES = 3;
const DEFAULT_TTL_MS = 5 * 60 * 1000;  // 5 minutes
const DEFAULT_MAX_SIZE = 10;

// Backoff schedule (index = attempts after failure, 0-based)
const BACKOFF_MS = [0, 5_000, 15_000];

export type QueueEntryStatus = "pending" | "accepted" | "delivered" | "failed";

export interface QueueFeedbackCtx {
  tickId: number;
  hud: string;
  currentApp: string;
  escalationScore: number;
  escalationReasons: string[];
  codingContext: boolean;
  digest: string;
}

export interface QueueEntry {
  /** sha256(sessionKey + message.slice(0,500)).hex.slice(0,16) — content-hash for dedup */
  id: string;
  message: string;
  sessionKey: string;
  enqueuedAt: number;
  attempts: number;
  lastAttemptAt: number | null;
  status: QueueEntryStatus;
  /** Absolute expiry timestamp (enqueuedAt + TTL) */
  expiresAt: number;
  feedbackCtx?: QueueFeedbackCtx;
}

/**
 * Persistent outbound queue for escalation messages.
 *
 * State transitions:
 *   pending → accepted (Phase 1 ok) → [entry removed on delivered]
 *   pending → pending (Phase 1 fail, attempts < max) or removed (max retries)
 *   accepted → pending (WS disconnect during Phase 2 — reset on reload)
 *
 * Invariants:
 *   - Max 1 accepted entry at a time (queue worker blocks on Phase 1)
 *   - Max maxSize entries total (oldest pending dropped on overflow)
 *   - Content-hash id → same message retried with same key (gateway deduplicates)
 */
export class OutboundQueue {
  private entries: QueueEntry[] = [];

  private constructor(
    private readonly ttlMs: number,
    private readonly maxSize: number,
  ) {}

  /**
   * Load queue from disk.
   * - Resets any "accepted" entries to "pending" (crash recovery)
   * - Drops expired entries
   */
  static load(ttlMs = DEFAULT_TTL_MS, maxSize = DEFAULT_MAX_SIZE): OutboundQueue {
    const q = new OutboundQueue(ttlMs, maxSize);
    try {
      if (fs.existsSync(STORE_PATH)) {
        const data = fs.readFileSync(STORE_PATH, "utf-8");
        const parsed: QueueEntry[] = JSON.parse(data);
        if (Array.isArray(parsed)) {
          const now = Date.now();
          q.entries = parsed
            .filter(e => e.expiresAt > now && e.status !== "failed" && e.status !== "delivered")
            .map(e => e.status === "accepted" ? { ...e, status: "pending" as const } : e);
          log(TAG, `loaded ${q.entries.length} entries from disk (reset accepted→pending)`);
        }
      }
    } catch (err: any) {
      error(TAG, `failed to load: ${err.message}`);
    }
    return q;
  }

  /** Number of entries in the queue. */
  get size(): number {
    return this.entries.length;
  }

  /** True if there is at least one non-expired pending entry. */
  get hasSendable(): boolean {
    const now = Date.now();
    return this.entries.some(e => e.status === "pending" && e.expiresAt > now);
  }

  /** Return the first non-expired pending entry without removing it. */
  peekSendable(): QueueEntry | null {
    const now = Date.now();
    return this.entries.find(e => e.status === "pending" && e.expiresAt > now) ?? null;
  }

  /**
   * Enqueue a message. Returns the entry (existing if deduped, new otherwise).
   * - Content-hash id: same message+session → same id → gateway-level dedup on retry
   * - Oldest pending dropped on overflow
   */
  enqueue(message: string, sessionKey: string, feedbackCtx?: QueueFeedbackCtx): QueueEntry {
    const id = createHash("sha256")
      .update(sessionKey + message.slice(0, 500))
      .digest("hex")
      .slice(0, 16);

    // Dedup: skip if same content already queued
    const existing = this.entries.find(
      e => e.id === id && (e.status === "pending" || e.status === "accepted"),
    );
    if (existing) {
      log(TAG, `enqueue: dedup id=${id} (status=${existing.status})`);
      return existing;
    }

    const now = Date.now();
    const entry: QueueEntry = {
      id,
      message,
      sessionKey,
      enqueuedAt: now,
      attempts: 0,
      lastAttemptAt: null,
      status: "pending",
      expiresAt: now + this.ttlMs,
      feedbackCtx,
    };

    // Overflow: drop oldest pending entry
    if (this.entries.length >= this.maxSize) {
      const oldestIdx = this.entries.findIndex(e => e.status === "pending");
      if (oldestIdx !== -1) {
        warn(TAG, `queue full (${this.maxSize}) — dropping oldest pending ${this.entries[oldestIdx].id}`);
        this.entries.splice(oldestIdx, 1);
      } else {
        warn(TAG, `queue full (${this.maxSize}), no pending to drop — skipping enqueue id=${id}`);
        return entry;
      }
    }

    this.entries.push(entry);
    this.persist();
    log(TAG, `enqueued id=${id} (size=${this.entries.length})`);
    return entry;
  }

  /** Mark entry as accepted (Phase 1 delivered). */
  markAccepted(id: string): void {
    const entry = this.entries.find(e => e.id === id);
    if (entry) {
      entry.status = "accepted";
      entry.lastAttemptAt = Date.now();
      this.persist();
    }
  }

  /** Remove entry after successful delivery (Phase 2 complete). */
  markDelivered(id: string): void {
    const idx = this.entries.findIndex(e => e.id === id);
    if (idx !== -1) {
      this.entries.splice(idx, 1);
      this.persist();
      log(TAG, `delivered id=${id} removed (size=${this.entries.length})`);
    }
  }

  /**
   * Record a failed Phase 1 attempt.
   * Increments attempts; drops entry if MAX_RETRIES exceeded.
   * Returns true if entry was retained (will retry), false if dropped.
   */
  markAttemptFailed(id: string): boolean {
    const entry = this.entries.find(e => e.id === id);
    if (!entry) return false;

    entry.attempts++;
    entry.lastAttemptAt = Date.now();

    if (entry.attempts >= MAX_RETRIES) {
      const idx = this.entries.indexOf(entry);
      this.entries.splice(idx, 1);
      warn(TAG, `id=${id} dropped after ${entry.attempts} failed attempts (size=${this.entries.length})`);
      this.persist();
      return false;
    }

    entry.status = "pending";
    log(TAG, `id=${id} attempt ${entry.attempts}/${MAX_RETRIES} failed — will retry`);
    this.persist();
    return true;
  }

  /** Atomic write: tmp file → rename. */
  private persist(): void {
    try {
      if (!fs.existsSync(STORE_DIR)) {
        fs.mkdirSync(STORE_DIR, { recursive: true });
      }
      const tmpPath = STORE_PATH + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(this.entries, null, 2), "utf-8");
      fs.renameSync(tmpPath, STORE_PATH);
    } catch (err: any) {
      error(TAG, `persist failed: ${err.message}`);
    }
  }
}

/**
 * Returns the backoff delay in ms for the given attempt count (after increment).
 * attempts=1 → 0ms (immediate retry)
 * attempts=2 → 5000ms
 * attempts=3 → 15000ms
 */
export function nextBackoff(attempts: number): number {
  return BACKOFF_MS[attempts - 1] ?? 0;
}
