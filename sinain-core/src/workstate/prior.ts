// Loads + caches the KG-pretrained prior (workstate-prior.json) and matches a
// live screen-surface embedding against its topic centroids. The prior is the
// per-user idiographic substrate the dossier (§F) says is the precondition —
// fitted from the knowledge graph by prior_builder.py before any live label.

import { existsSync, readFileSync, statSync } from "node:fs";
import type { PriorModel, PriorTopic } from "./types.js";

export interface TopicMatch {
  topic: PriorTopic;
  similarity: number;
}

function cosine(a: Float32Array, b: number[]): number {
  // `b` (centroid) is already L2-normalized by prior_builder; normalize `a`.
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

  get info(): PriorModel | null {
    return this.model;
  }

  get globalReturnRate(): number {
    return this.model?.globalReturnRate ?? 0;
  }

  /** Load (or hot-reload if the file changed since last load). Returns ready. */
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

  /** Top-K topics above `min` similarity, best-first — the project umbrella plus
   *  its sub-focuses, so a thread can be named as a hierarchy. */
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
