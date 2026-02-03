import crypto from "node:crypto";
import type { Trace, Span, TraceMetrics, MetricsSummary } from "../types.js";
import type { TraceContext } from "../agent/loop.js";

/**
 * Structured trace recording for every agent tick.
 * Each tick produces a Trace with nested Spans and aggregated TraceMetrics.
 *
 * Traces are kept in a rolling buffer (max 500) and exposed via GET /traces.
 * Optionally persisted to JSONL via TraceStore.
 */
export class Tracer {
  private traces: Trace[] = [];
  private maxTraces = 500;

  /** Start a new trace for a tick. Returns a TraceContext for recording spans. */
  startTrace(tickId: number): TraceContext {
    const trace: Trace = {
      traceId: crypto.randomUUID(),
      tickId,
      ts: Date.now(),
      spans: [],
      metrics: {} as TraceMetrics,
    };

    let currentSpanStart = 0;
    let currentSpanName = "";

    const ctx: TraceContext = {
      startSpan(name: string): void {
        currentSpanName = name;
        currentSpanStart = Date.now();
      },

      endSpan(attrs?: Record<string, unknown>): void {
        if (!currentSpanName) return;
        const span: Span = {
          name: currentSpanName,
          startTs: currentSpanStart,
          endTs: Date.now(),
          attributes: attrs || {},
          status: attrs?.status === "error" ? "error" : "ok",
          error: attrs?.error as string | undefined,
        };
        trace.spans.push(span);
        currentSpanName = "";
      },

      finish(metrics: Record<string, unknown>): void {
        trace.metrics = metrics as unknown as TraceMetrics;
        this._commit();
      },

      _commit: () => {
        this.traces.push(trace);
        if (this.traces.length > this.maxTraces) {
          this.traces.shift();
        }
      },
    } as TraceContext & { _commit: () => void };

    return ctx;
  }

  /** Get traces after a given tickId, with limit. */
  getTraces(afterTickId = 0, limit = 50): Trace[] {
    return this.traces
      .filter(t => t.tickId > afterTickId)
      .slice(-limit);
  }

  /** Compute summary metrics over all stored traces. */
  getMetricsSummary(): MetricsSummary {
    if (this.traces.length === 0) {
      return { count: 0, latencyP50: 0, latencyP95: 0, avgCostPerTick: 0, totalCost: 0 };
    }

    const latencies = this.traces
      .map(t => t.metrics.totalLatencyMs)
      .filter(l => l > 0)
      .sort((a, b) => a - b);

    const costs = this.traces.map(t => t.metrics.llmCost);
    const totalCost = costs.reduce((a, b) => a + b, 0);

    return {
      count: this.traces.length,
      latencyP50: latencies[Math.floor(latencies.length / 2)] || 0,
      latencyP95: latencies[Math.floor(latencies.length * 0.95)] || 0,
      avgCostPerTick: totalCost / this.traces.length,
      totalCost,
    };
  }
}
