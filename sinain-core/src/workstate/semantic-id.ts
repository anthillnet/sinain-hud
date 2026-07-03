// Semantic WorkState IDs (Layer 3, DESIGN-WSM-prediction.md §8) — P1 MVP.
// Quantizes a work-state into a discrete codebook entry so a sequence model (L4)
// can predict over compact symbols instead of raw token bags. This is the P1
// rung (k-means → WS_CLUSTER_<id>); REVISIT for P2 hierarchical, P3 product/
// residual quantization (WS_SID_18_241_7_93), P4 learned RQ-VAE.
//
// Embedding here is a multi-hot over the behavioral-token vocabulary — no model,
// no content embedding yet. REVISIT: swap in the all-MiniLM surface embedding (we
// already run it) for semantic, not just behavioral, clustering.

import type { CorpusRow } from "./retrieval.js";

export interface SemanticId {
  semantic_id: string[]; // e.g. ["WS_CLUSTER_3"] — P3 will be a multi-code vector
  codebook_version: string;
  embedding_model: string;
  fitN: number; // corpus size the codebook was fit on
}

const VERSION = "workstate_sid_v1";
const MODEL = "tokens-multihot-v1";

function multihot(tokens: Set<string>, vocab: Map<string, number>): Float64Array {
  const v = new Float64Array(vocab.size);
  for (const t of tokens) { const i = vocab.get(t); if (i !== undefined) v[i] = 1; }
  return v;
}
function dist2(a: Float64Array, b: Float64Array): number {
  let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return s;
}

/** Lazily-fit k-means codebook over the return corpus; refits on corpus change. */
export class SemanticIdModel {
  private vocab = new Map<string, number>();
  private centroids: Float64Array[] = [];
  private fitMtime = -1;
  private fitN = 0;

  /** Fit (or refit) from rows. k scales with data (√n, capped) — REVISIT: pick k
   *  by silhouette / BIC once the corpus is large enough to matter. */
  fit(rows: CorpusRow[], mtime: number): void {
    if (mtime === this.fitMtime && this.centroids.length) return;
    this.fitMtime = mtime;
    this.fitN = rows.length;
    this.vocab = new Map();
    for (const r of rows) for (const t of r.tokens) if (!this.vocab.has(t)) this.vocab.set(t, this.vocab.size);
    if (rows.length < 4 || this.vocab.size === 0) { this.centroids = []; return; }
    const X = rows.map((r) => multihot(r.tokens, this.vocab));
    const k = Math.max(2, Math.min(12, Math.floor(Math.sqrt(rows.length))));
    // Deterministic seeding: evenly spaced rows (no RNG — keeps fits reproducible).
    this.centroids = Array.from({ length: k }, (_, i) => X[Math.floor((i * rows.length) / k)].slice());
    for (let iter = 0; iter < 10; iter++) {
      const sums = this.centroids.map(() => new Float64Array(this.vocab.size));
      const counts = new Array(k).fill(0);
      for (const x of X) { const c = this.nearest(x); for (let j = 0; j < x.length; j++) sums[c][j] += x[j]; counts[c]++; }
      for (let c = 0; c < k; c++) if (counts[c]) for (let j = 0; j < this.vocab.size; j++) this.centroids[c][j] = sums[c][j] / counts[c];
    }
  }

  private nearest(x: Float64Array): number {
    let best = 0, bd = Infinity;
    for (let c = 0; c < this.centroids.length; c++) { const d = dist2(x, this.centroids[c]); if (d < bd) { bd = d; best = c; } }
    return best;
  }

  /** Assign a work-state (its tokens) to a codebook entry. */
  assign(tokens: string[]): SemanticId {
    if (!this.centroids.length) {
      return { semantic_id: [], codebook_version: VERSION, embedding_model: MODEL, fitN: this.fitN };
    }
    const cid = this.nearest(multihot(new Set(tokens), this.vocab));
    return { semantic_id: [`WS_CLUSTER_${cid}`], codebook_version: VERSION, embedding_model: MODEL, fitN: this.fitN };
  }
}
