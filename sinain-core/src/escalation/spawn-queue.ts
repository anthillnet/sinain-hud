/**
 * SpawnQueue — bounded FIFO queue for spawn tasks.
 *
 * MVP: maxConcurrent=1 (sequential drain, same as old spawnInFlight flag).
 * Future: bump maxConcurrent for parallel ROI spawns when agent/gateway supports it.
 */

import { log, warn } from "../log.js";

const TAG = "spawn-queue";

export interface SpawnEntry {
  id: string;
  task: string;
  label: string;
  roi?: { bbox: [number, number, number, number]; ocr?: string };
  ts: number;
}

export class SpawnQueue {
  private queue: SpawnEntry[] = [];
  private active = 0;
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;

  constructor(opts: { maxConcurrent?: number; maxQueued?: number } = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? 1;
    this.maxQueued = opts.maxQueued ?? 5;
    log(TAG, `initialized: maxConcurrent=${this.maxConcurrent}, maxQueued=${this.maxQueued}`);
  }

  /** Enqueue a spawn task. Returns false if queue is full. */
  enqueue(entry: SpawnEntry): boolean {
    if (this.queue.length >= this.maxQueued) {
      warn(TAG, `queue full (${this.maxQueued}), dropping: ${entry.task.slice(0, 60)}`);
      return false;
    }
    this.queue.push(entry);
    log(TAG, `enqueued ${entry.id} (queue=${this.queue.length}, active=${this.active})`);
    return true;
  }

  /** Take the next task if a slot is available. Returns null if no work or at capacity. */
  take(): SpawnEntry | null {
    if (this.active >= this.maxConcurrent || this.queue.length === 0) return null;
    const entry = this.queue.shift()!;
    this.active++;
    log(TAG, `took ${entry.id} (queue=${this.queue.length}, active=${this.active})`);
    return entry;
  }

  /** Mark a task as complete (frees a slot). */
  complete(id: string): void {
    this.active = Math.max(0, this.active - 1);
    log(TAG, `completed ${id} (queue=${this.queue.length}, active=${this.active})`);
  }

  /** Number of tasks waiting + active. */
  get size(): number {
    return this.queue.length + this.active;
  }

  get pending(): number {
    return this.queue.length;
  }

  get running(): number {
    return this.active;
  }

  /** Check if there's capacity to take work. */
  get hasCapacity(): boolean {
    return this.active < this.maxConcurrent && this.queue.length > 0;
  }
}
