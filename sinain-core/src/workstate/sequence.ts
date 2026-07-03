// Generative WorkState model (Layer 4, DESIGN-WSM-prediction.md §9) — STUB.
// The doc is explicit: a real behavioral-token sequence model is NOT the MVP
// (single-user data is sparse). This is the smallest stand-in that fills the
// interface: a co-occurrence model P(outcome_token | situation_token) over the
// return corpus, predicting the next likely OUTCOME tokens from tokens_before.
// REVISIT: replace with a trained sequence model (n-gram → RQ-VAE / small
// transformer over WS_SID streams) once enough returns exist.

import type { CorpusRow } from "./retrieval.js";

export interface SequencePrediction {
  next_tokens: { token: string; score: number }[]; // top predicted outcome tokens
  fitN: number;
  model: string;
}

const MODEL = "cooccurrence-v1";
const OUTCOME_RE = /^(OUTCOME_|SUPPORT_|CARD_|NEXT_ACTION_|FEEDBACK_)/;

/** Lazily-fit co-occurrence counts; refits on corpus change. */
export class SequenceModel {
  // situationToken → outcomeToken → count
  private co = new Map<string, Map<string, number>>();
  private outcomeTotals = new Map<string, number>();
  private fitMtime = -1;
  private fitN = 0;

  fit(rows: CorpusRow[], mtime: number): void {
    if (mtime === this.fitMtime && this.co.size) return;
    this.fitMtime = mtime;
    this.fitN = rows.length;
    this.co = new Map();
    this.outcomeTotals = new Map();
    for (const r of rows) {
      const outcomes = r.after.filter((t) => OUTCOME_RE.test(t));
      for (const o of outcomes) this.outcomeTotals.set(o, (this.outcomeTotals.get(o) ?? 0) + 1);
      for (const s of r.tokens) {
        let m = this.co.get(s);
        if (!m) { m = new Map(); this.co.set(s, m); }
        for (const o of outcomes) m.set(o, (m.get(o) ?? 0) + 1);
      }
    }
  }

  /** Predict next outcome tokens: score(o) = Σ_s P(o | s) over the situation's
   *  tokens, lifted by the outcome's own base rate. Top-k. */
  predict(tokens: string[], k = 4): SequencePrediction {
    if (!this.co.size) return { next_tokens: [], fitN: this.fitN, model: MODEL };
    const score = new Map<string, number>();
    for (const s of tokens) {
      const m = this.co.get(s);
      if (!m) continue;
      let sTotal = 0; for (const c of m.values()) sTotal += c;
      if (!sTotal) continue;
      for (const [o, c] of m) score.set(o, (score.get(o) ?? 0) + c / sTotal);
    }
    const next = [...score.entries()]
      .map(([token, raw]) => ({ token, score: Math.round((raw / Math.max(1, tokens.length)) * 1000) / 1000 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    return { next_tokens: next, fitN: this.fitN, model: MODEL };
  }
}
