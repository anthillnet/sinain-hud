import type { CostEntry, CostSnapshot } from "../types.js";
import { log } from "../log.js";

const TAG = "cost";

export class CostTracker {
  private totalCost = 0;
  private costBySource = new Map<string, number>();
  private costByModel = new Map<string, number>();
  private callCount = 0;
  private startedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private onCostUpdate: (snapshot: CostSnapshot) => void;

  constructor(onCostUpdate: (snapshot: CostSnapshot) => void) {
    this.onCostUpdate = onCostUpdate;
  }

  record(entry: CostEntry): void {
    if (entry.cost <= 0) return;
    this.totalCost += entry.cost;
    this.callCount++;
    this.costBySource.set(
      entry.source,
      (this.costBySource.get(entry.source) || 0) + entry.cost,
    );
    this.costByModel.set(
      entry.model,
      (this.costByModel.get(entry.model) || 0) + entry.cost,
    );
    this.onCostUpdate(this.getSnapshot());
  }

  getSnapshot(): CostSnapshot {
    return {
      totalCost: this.totalCost,
      costBySource: Object.fromEntries(this.costBySource),
      costByModel: Object.fromEntries(this.costByModel),
      callCount: this.callCount,
      startedAt: this.startedAt,
    };
  }

  startPeriodicLog(intervalMs: number): void {
    this.timer = setInterval(() => {
      if (this.callCount === 0) return;
      const elapsed = ((Date.now() - this.startedAt) / 60_000).toFixed(1);
      const sources = [...this.costBySource.entries()]
        .map(([k, v]) => `${k}=$${v.toFixed(6)}`)
        .join(" ");
      const models = [...this.costByModel.entries()]
        .map(([k, v]) => `${k}=$${v.toFixed(6)}`)
        .join(" ");
      log(TAG, `$${this.totalCost.toFixed(6)} total (${this.callCount} calls, ${elapsed} min) | ${sources} | ${models}`);
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
