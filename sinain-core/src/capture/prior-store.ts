// Personal topic priors — ported from the WSM branch's workstate/prior.ts
// (feat/wsm-attention-cockpit) for Session Sense's "personal" tier: loads +
// hot-reloads the KG-pretrained prior (workstate-prior.json, emitted by
// sinain-memory/prior_builder.py) and matches a live screen-surface embedding
// against its topic centroids. "Back on: <label>" — the KG already knows this
// thread by name, with recurrence and friction behind it.

import { existsSync, readFileSync, statSync } from "node:fs";

export interface PriorTopic {
  id: string;
  label: string;
  centroid: number[]; // 384-dim, L2-normalized by prior_builder
  recurrence: number;
  distinctDays: number;
  frictionPrior: number;
  lastSeen: string | null;
  ageDays: number | null;
  sampleFacts: string[];
}

export interface PriorModel {
  version: number;
  builtAt: string;
  factCount: number;
  spanDays: number;
  globalReturnRate: number;
  activityBaseRates: Record<string, number>;
  topics: PriorTopic[];
}

export interface TopicMatch {
  topic: PriorTopic;
  similarity: number;
}

function cosine(a: Float32Array, b: number[]): number {
  // `b` (centroid) is already L2-normalized; normalize `a`.
  let dot = 0;
  let na = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
  }
  const denom = Math.sqrt(na) || 1;
  return dot / denom;
}

export class PriorStore {
  private model: PriorModel | null = null;
  private loadedMtimeMs = 0;

  constructor(private readonly path: string) {}

  get ready(): boolean {
    return this.model !== null;
  }

  /** Load (or hot-reload if the file changed since last load). Returns ready.
   *  Absence is normal — the prior exists only after prior_builder has run. */
  reload(): boolean {
    try {
      if (!existsSync(this.path)) return false;
      const mtime = statSync(this.path).mtimeMs;
      if (this.model && mtime === this.loadedMtimeMs) return true;
      this.model = JSON.parse(readFileSync(this.path, "utf-8")) as PriorModel;
      this.loadedMtimeMs = mtime;
      return true;
    } catch {
      return false;
    }
  }

  /** Best-matching topic for a surface embedding, or null. */
  bestMatch(surface: Float32Array): TopicMatch | null {
    if (!this.model || this.model.topics.length === 0) return null;
    let best: TopicMatch | null = null;
    for (const topic of this.model.topics) {
      if (topic.centroid.length === 0) continue;
      const similarity = cosine(surface, topic.centroid);
      if (!best || similarity > best.similarity) best = { topic, similarity };
    }
    return best;
  }

  /** Top-K topics above `min` similarity, best-first. */
  topMatches(surface: Float32Array, k = 4, min = 0.45): TopicMatch[] {
    if (!this.model) return [];
    return this.model.topics
      .filter((t) => t.centroid.length > 0)
      .map((topic) => ({ topic, similarity: cosine(surface, topic.centroid) }))
      .filter((m) => m.similarity >= min)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
  }
}
