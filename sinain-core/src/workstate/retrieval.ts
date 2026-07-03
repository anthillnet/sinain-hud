// WorkState2Vec / retrieval (Layer 2, DESIGN-WSM-prediction.md §7) — MVP form.
// Each past thread-return is a *behavioral document* (its tokens_before). For a
// new return we find the K most similar past returns and aggregate what actually
// happened (observed band / continued vs abandoned / accepted). This yields
// CANDIDATES, not probabilities — the calibrated scorer still owns final claims
// ("embedding proximity is not probability", §7). Sparse symbolic matching only
// for now (token Jaccard); content/behavioral embeddings come later.

import { existsSync, readFileSync, statSync } from "node:fs";

export interface CorpusRow {
  tokens: Set<string>; // tokens_before
  after: string[]; // tokens_after (outcome tokens) — for the sequence model (L4)
  band: string; // observed.active_band
  abandoned: boolean; // OUTCOME_ABANDONED in tokens_after
  accepted: boolean; // observed.accepted
  qualified: boolean; // observed.qualified (a real return, not a bounce)
}

/** Aggregated outcomes of the nearest past returns — the retrieval candidate. */
export interface RetrievalCandidate {
  n: number; // neighbors counted
  topBand: string | null; // most-supported observed band (weighted)
  bandDist: Record<string, number>; // observed band → weighted support
  continuationRate: number; // fraction that did NOT abandon
  acceptRate: number;
  qualifiedN: number; // of n, how many were qualified returns
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Loads + caches the return corpus (workstate-returns.jsonl), hot-reloading on
 *  file change. Skips the row currently being written (retrieval is over PAST
 *  returns only — no leakage of the in-flight event). */
export class ReturnCorpus {
  private rows: CorpusRow[] = [];
  private loadedMtimeMs = 0;

  constructor(private readonly path: string) {}

  reload(): void {
    try {
      if (!existsSync(this.path)) { this.rows = []; return; }
      const mtime = statSync(this.path).mtimeMs;
      if (mtime === this.loadedMtimeMs && this.rows.length) return;
      const rows: CorpusRow[] = [];
      for (const ln of readFileSync(this.path, "utf-8").split("\n")) {
        if (!ln.trim()) continue;
        try {
          const r = JSON.parse(ln);
          const tokens: string[] = Array.isArray(r.tokens_before) ? r.tokens_before : [];
          const after: string[] = Array.isArray(r.tokens_after) ? r.tokens_after : [];
          const o = r.observed ?? {};
          rows.push({
            tokens: new Set(tokens),
            after,
            band: o.active_band ?? "",
            abandoned: after.includes("OUTCOME_ABANDONED"),
            accepted: !!o.accepted,
            // Rows that must not TEACH outcomes: censored (closed at shutdown,
            // true duration unknown) and schema-1 (durations were truncated at
            // the first switch-away — they measure bounces, not work blocks).
            qualified: o.qualified !== false && o.censored !== true && (r.schema ?? 1) >= 2,
          });
        } catch { /* skip malformed line */ }
      }
      this.rows = rows;
      this.loadedMtimeMs = mtime;
    } catch { /* keep prior cache */ }
  }

  get size(): number { return this.rows.length; }

  /** Raw rows (after reload) — consumed by the L3 codebook + L4 sequence model. */
  getRows(): CorpusRow[] { this.reload(); return this.rows; }
  mtime(): number { return this.loadedMtimeMs; }

  /** Top-K nearest past returns by token Jaccard → weighted outcome aggregate. */
  retrieve(tokens: string[], k = 20, minSim = 0.2): RetrievalCandidate {
    this.reload();
    const q = new Set(tokens);
    const scored = this.rows
      .map((r) => ({ r, s: jaccard(q, r.tokens) }))
      .filter((x) => x.s >= minSim)
      .sort((a, b) => b.s - a.s)
      .slice(0, k);

    const bandDist: Record<string, number> = {};
    let wContinued = 0, wAccepted = 0, wTotal = 0, qualifiedN = 0;
    for (const { r, s } of scored) {
      wTotal += s;
      if (r.band) bandDist[r.band] = (bandDist[r.band] ?? 0) + s;
      if (!r.abandoned) wContinued += s;
      if (r.accepted) wAccepted += s;
      if (r.qualified) qualifiedN++;
    }
    const topBand = Object.entries(bandDist).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return {
      n: scored.length,
      topBand,
      bandDist: Object.fromEntries(Object.entries(bandDist).map(([k2, v]) => [k2, Math.round(v * 1000) / 1000])),
      continuationRate: wTotal > 0 ? Math.round((wContinued / wTotal) * 100) / 100 : 0,
      acceptRate: wTotal > 0 ? Math.round((wAccepted / wTotal) * 100) / 100 : 0,
      qualifiedN,
    };
  }
}
