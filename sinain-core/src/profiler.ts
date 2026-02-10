/**
 * Central metrics collector for all HUD processes.
 * Subsystems report gauges and timers; external processes (sense, overlay)
 * push snapshots via HTTP/WS. `/health` returns everything in one call.
 */

import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import type { IntervalHistogram } from "node:perf_hooks";

export interface ProcessSnapshot {
  rssMb: number;
  heapUsedMb?: number;
  heapTotalMb?: number;
  cpuUserMs?: number;
  cpuSystemMs?: number;
  uptimeS: number;
  ts: number;
  extra?: Record<string, number>;
}

interface TimerStats {
  count: number;
  totalMs: number;
  lastMs: number;
  maxMs: number;
}

export interface ProfilingSnapshot {
  core: ProcessSnapshot & {
    gauges: Record<string, number>;
    timers: Record<string, TimerStats>;
  };
  sense: ProcessSnapshot | null;
  overlay: ProcessSnapshot | null;
  sampledAt: number;
}

export class Profiler {
  private gauges: Record<string, number> = {};
  private timers: Record<string, TimerStats> = {};
  private coreSnapshot: ProcessSnapshot | null = null;
  private senseSnapshot: ProcessSnapshot | null = null;
  private overlaySnapshot: ProcessSnapshot | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private startTs = Date.now();

  // Event loop lag tracking
  private elHistogram: IntervalHistogram | null = null;
  private elMaxLagMs = 0;

  // GC pause tracking
  private gcObserver: PerformanceObserver | null = null;
  private gcStats = { totalPauseMs: 0, count: 0, lastPauseMs: 0, maxPauseMs: 0 };

  /** Set a named gauge value. */
  gauge(name: string, value: number): void {
    this.gauges[name] = value;
  }

  /** Record a timing measurement. */
  timerRecord(name: string, durationMs: number): void {
    const existing = this.timers[name];
    if (existing) {
      existing.count++;
      existing.totalMs += durationMs;
      existing.lastMs = durationMs;
      if (durationMs > existing.maxMs) existing.maxMs = durationMs;
    } else {
      this.timers[name] = { count: 1, totalMs: durationMs, lastMs: durationMs, maxMs: durationMs };
    }
  }

  /** Wrap an async call with automatic timing. */
  async timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      this.timerRecord(name, Date.now() - start);
    }
  }

  /** Store the latest sense_client process snapshot. */
  reportSense(snapshot: ProcessSnapshot): void {
    this.senseSnapshot = snapshot;
  }

  /** Store the latest overlay process snapshot. */
  reportOverlay(snapshot: ProcessSnapshot): void {
    this.overlaySnapshot = snapshot;
  }

  /** Returns the full profiling payload for /health. */
  getSnapshot(): ProfilingSnapshot {
    return {
      core: {
        ...(this.coreSnapshot ?? this.sampleCore()),
        gauges: { ...this.gauges },
        timers: { ...this.timers },
      },
      sense: this.senseSnapshot,
      overlay: this.overlaySnapshot,
      sampledAt: Date.now(),
    };
  }

  /** Start periodic core process sampling (every 10s). */
  start(): void {
    this.startTs = Date.now();
    this.sampleCore();
    this.interval = setInterval(() => this.sampleCore(), 10_000);

    // Event loop lag histogram (20ms resolution)
    this.elHistogram = monitorEventLoopDelay({ resolution: 20 });
    this.elHistogram.enable();

    // GC pause observer
    try {
      this.gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const pauseMs = entry.duration;
          this.gcStats.count++;
          this.gcStats.totalPauseMs += pauseMs;
          this.gcStats.lastPauseMs = pauseMs;
          if (pauseMs > this.gcStats.maxPauseMs) this.gcStats.maxPauseMs = pauseMs;
        }
      });
      this.gcObserver.observe({ entryTypes: ["gc"] });
    } catch {
      // GC observation may not be available in all environments
    }
  }

  /** Stop periodic sampling. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.elHistogram) {
      this.elHistogram.disable();
      this.elHistogram = null;
    }
    if (this.gcObserver) {
      this.gcObserver.disconnect();
      this.gcObserver = null;
    }
  }

  private sampleCore(): ProcessSnapshot {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const snap: ProcessSnapshot = {
      rssMb: Math.round((mem.rss / 1048576) * 10) / 10,
      heapUsedMb: Math.round((mem.heapUsed / 1048576) * 10) / 10,
      heapTotalMb: Math.round((mem.heapTotal / 1048576) * 10) / 10,
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSystemMs: Math.round(cpu.system / 1000),
      uptimeS: Math.round((Date.now() - this.startTs) / 1000),
      ts: Date.now(),
    };
    this.coreSnapshot = snap;

    // Event loop lag gauges
    if (this.elHistogram) {
      const meanLagMs = this.elHistogram.mean / 1e6; // ns → ms
      if (meanLagMs > this.elMaxLagMs) this.elMaxLagMs = meanLagMs;
      this.gauges["eventLoop.lagMs"] = Math.round(meanLagMs * 100) / 100;
      this.gauges["eventLoop.maxLagMs"] = Math.round(this.elMaxLagMs * 100) / 100;
      this.elHistogram.reset();
    }

    // GC gauges
    this.gauges["gc.totalPauseMs"] = Math.round(this.gcStats.totalPauseMs * 100) / 100;
    this.gauges["gc.count"] = this.gcStats.count;
    this.gauges["gc.lastPauseMs"] = Math.round(this.gcStats.lastPauseMs * 100) / 100;
    this.gauges["gc.maxPauseMs"] = Math.round(this.gcStats.maxPauseMs * 100) / 100;

    return snap;
  }
}
