// WSM calibration harness — the "close the loop NOW" tool (design §7 / P3).
//
// Scores every prediction head against outcomes the engine already logs, so
// calibration doesn't wait months for explicit labels: implicit outcomes
// (observed duration band, abandonment, resumed-within-cadence) are
// manufactured from workstate-returns.jsonl + workstate-history.jsonl, and the
// sparse explicit taps in workstate-labels.jsonl are joined on top.
//
// Heads scored:
//   1. duration band (heuristic head)  — accuracy / ±1-band vs majority baseline
//   2. duration band (retrieval head)  — multi-class Brier vs one-hot + uniform
//   3. continuation (retrieval head)   — Brier + reliability table
//   4. re-entry tier                   — observed minutes per tier (monotonic?)
//   5. stuckness (ASPIRATIONAL)        — AUC of stuckness-at-leave predicting
//                                        "did not return within cadence" — the
//                                        promotion gate evidence (§4 honesty rule)
//
// Run:  npm run wsm:calibrate        (or: npx tsx src/workstate/calibrate.ts)
// Deterministic, offline, no LLM. Reads SINAIN_MEMORY_DIR (default ~/.sinain/memory).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BANDS } from "./tokenizer.js";

const memoryDir = process.env.SINAIN_MEMORY_DIR || join(homedir(), ".sinain", "memory");

interface ReturnRow {
  schema: number;
  threadId: string;
  ts: number;
  predictedBand: string | null;
  reentry: string | null;
  reliability: string | null;
  bandDist: Record<string, number>;
  retrievalN: number;
  continuationRate: number | null;
  observedBand: string | null;
  abandoned: boolean;
  accepted: boolean;
  qualified: boolean;
  censored: boolean;
  activeMin: number | null;
  stuckness: number | null;
}

interface HistoryRow {
  ts: number; event: string; threadId: string;
  stuckness: number | null; difficulty: number | null; cadenceMs: number | null;
}

function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const out: unknown[] = [];
  for (const ln of readFileSync(path, "utf-8").split("\n")) {
    if (!ln.trim()) continue;
    try { out.push(JSON.parse(ln)); } catch { /* skip malformed */ }
  }
  return out;
}

function loadReturns(): ReturnRow[] {
  return (readJsonl(join(memoryDir, "workstate-returns.jsonl")) as Record<string, any>[]).map((r) => {
    const after: string[] = Array.isArray(r.tokens_after) ? r.tokens_after : [];
    const o = r.observed ?? {};
    return {
      schema: typeof r.schema === "number" ? r.schema : 1,
      threadId: r.thread_id ?? "",
      ts: Date.parse(r.timestamp ?? "") || 0,
      predictedBand: r.calibrated_prediction?.duration_band ?? null,
      reentry: r.calibrated_prediction?.reentry_cost ?? null,
      reliability: r.calibrated_prediction?.confidence_tier ?? null,
      bandDist: r.retrieval?.bandDist ?? {},
      retrievalN: r.retrieval?.qualifiedN ?? 0,
      continuationRate: r.retrieval && r.retrieval.n > 0 ? r.retrieval.continuationRate : null,
      observedBand: o.active_band ?? null,
      abandoned: after.includes("OUTCOME_ABANDONED") || after.includes("CARD_DISMISSED"),
      accepted: !!o.accepted,
      qualified: o.qualified !== false,
      censored: o.censored === true,
      activeMin: typeof o.active_minutes === "number" ? o.active_minutes : null,
      stuckness: typeof r.latents?.stuckness === "number" ? r.latents.stuckness : null,
    };
  });
}

function loadHistory(): HistoryRow[] {
  return (readJsonl(join(memoryDir, "workstate-history.jsonl")) as Record<string, any>[]).map((r) => ({
    ts: r.ts ?? 0, event: r.event ?? "", threadId: r.threadId ?? "",
    stuckness: typeof r.stuckness === "number" ? r.stuckness : null,
    difficulty: typeof r.difficulty === "number" ? r.difficulty : null,
    cadenceMs: typeof r.cadenceMs === "number" ? r.cadenceMs : null,
  }));
}

const bandIdx = (code: string | null): number => BANDS.findIndex((b) => b.code === code);
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const f2 = (x: number): string => x.toFixed(2);

/** Rank-based AUC: P(score(positive) > score(negative)) with tie credit. */
function auc(pos: number[], neg: number[]): number | null {
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 66 - title.length))}`);
}

function main(): void {
  const returns = loadReturns();
  const history = loadHistory();
  const labels = readJsonl(join(memoryDir, "workstate-labels.jsonl")) as Record<string, any>[];

  console.log(`WSM calibration report — ${new Date().toISOString()}`);
  console.log(`memory dir: ${memoryDir}`);

  section("Corpus");
  const qualified = returns.filter((r) => r.qualified && r.observedBand && !r.censored);
  const bySchema = new Map<number, number>();
  for (const r of returns) bySchema.set(r.schema, (bySchema.get(r.schema) ?? 0) + 1);
  const span = returns.length
    ? `${new Date(Math.min(...returns.map((r) => r.ts))).toISOString().slice(0, 10)} → ${new Date(Math.max(...returns.map((r) => r.ts))).toISOString().slice(0, 10)}`
    : "—";
  console.log(`returns: ${returns.length} (${qualified.length} qualified w/ observed band) · span ${span}`);
  console.log(`schema versions: ${[...bySchema.entries()].map(([s, n]) => `v${s}×${n}`).join(", ")}`);
  console.log(`history events: ${history.length} · explicit labels: ${labels.length}`);
  console.log(`NOTE: schema-1 rows carry keyword-inflated STATE_UNRESOLVED_ERROR tokens`);
  console.log(`      AND bounce-truncated durations (closed at first switch-away) —`);
  console.log(`      duration heads only become meaningful on schema-2 rows.`);

  // ── 1. Duration band — heuristic head ─────────────────────────────────────
  section("1 · Duration band (heuristic head)");
  if (qualified.length < 5) {
    console.log(`only ${qualified.length} qualified rows — need ~5+ for a read`);
  } else {
    let exact = 0, adjacent = 0;
    const confusion = new Map<string, number>();
    const observedCounts = new Map<string, number>();
    for (const r of qualified) {
      const p = bandIdx(r.predictedBand), o = bandIdx(r.observedBand);
      if (p < 0 || o < 0) continue;
      if (p === o) exact++;
      if (Math.abs(p - o) <= 1) adjacent++;
      confusion.set(`${r.predictedBand}→${r.observedBand}`, (confusion.get(`${r.predictedBand}→${r.observedBand}`) ?? 0) + 1);
      observedCounts.set(r.observedBand!, (observedCounts.get(r.observedBand!) ?? 0) + 1);
    }
    const majority = Math.max(...observedCounts.values()) / qualified.length;
    console.log(`exact: ${pct(exact / qualified.length)} · ±1 band: ${pct(adjacent / qualified.length)} · majority baseline: ${pct(majority)}`);
    const top = [...confusion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log(`top predicted→observed: ${top.map(([k, n]) => `${k} ×${n}`).join(" · ")}`);
    console.log(`observed mix: ${[...observedCounts.entries()].map(([b, n]) => `${b}:${n}`).join(" ")}`);
  }

  // ── 2. Duration band — retrieval head (probabilistic → Brier) ─────────────
  section("2 · Duration band (retrieval head, Brier)");
  const withDist = qualified.filter((r) => Object.keys(r.bandDist).length > 0);
  if (withDist.length < 5) {
    console.log(`only ${withDist.length} rows with retrieval support — retrieval was cold for most returns`);
  } else {
    let brierR = 0, brierH = 0;
    for (const r of withDist) {
      const total = Object.values(r.bandDist).reduce((a, b) => a + b, 0) || 1;
      for (const b of BANDS) {
        const p = (r.bandDist[b.code] ?? 0) / total;
        const y = r.observedBand === b.code ? 1 : 0;
        brierR += (p - y) ** 2;
        brierH += ((r.predictedBand === b.code ? 1 : 0) - y) ** 2;
      }
    }
    brierR /= withDist.length; brierH /= withDist.length;
    console.log(`n=${withDist.length} · retrieval Brier ${f2(brierR)} · heuristic(one-hot) ${f2(brierH)} · uniform baseline 0.80 (lower is better)`);
  }

  // ── 3. Continuation — retrieval head reliability ───────────────────────────
  section("3 · Continuation (retrieval head)");
  const withCont = returns.filter((r) => r.continuationRate !== null && r.qualified);
  if (withCont.length < 5) {
    console.log(`only ${withCont.length} rows with retrieval continuation — need more history`);
  } else {
    let brier = 0;
    const buckets: { lo: number; hi: number; n: number; cont: number; pSum: number }[] = [
      { lo: 0, hi: 1 / 3, n: 0, cont: 0, pSum: 0 },
      { lo: 1 / 3, hi: 2 / 3, n: 0, cont: 0, pSum: 0 },
      { lo: 2 / 3, hi: 1.01, n: 0, cont: 0, pSum: 0 },
    ];
    for (const r of withCont) {
      const y = r.abandoned ? 0 : 1;
      brier += (r.continuationRate! - y) ** 2;
      const b = buckets.find((x) => r.continuationRate! >= x.lo && r.continuationRate! < x.hi)!;
      b.n++; b.cont += y; b.pSum += r.continuationRate!;
    }
    console.log(`n=${withCont.length} · Brier ${f2(brier / withCont.length)} (predict-0.5 baseline 0.25)`);
    for (const b of buckets) {
      if (!b.n) continue;
      console.log(`  predicted ${f2(b.pSum / b.n)} avg → observed continued ${pct(b.cont / b.n)}  (n=${b.n})`);
    }
  }

  // ── 4. Re-entry tier sanity — observed minutes per tier ───────────────────
  section("4 · Re-entry tier vs observed duration");
  const byTier = new Map<string, number[]>();
  for (const r of qualified) {
    if (r.activeMin === null || !r.reentry) continue;
    if (!byTier.has(r.reentry)) byTier.set(r.reentry, []);
    byTier.get(r.reentry)!.push(r.activeMin);
  }
  for (const tier of ["low", "medium", "high"]) {
    const xs = (byTier.get(tier) ?? []).sort((a, b) => a - b);
    if (!xs.length) { console.log(`  ${tier.padEnd(6)} —`); continue; }
    const med = xs[Math.floor(xs.length / 2)];
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    console.log(`  ${tier.padEnd(6)} n=${String(xs.length).padStart(3)} · median ${f2(med)}m · mean ${f2(mean)}m`);
  }
  console.log(`  (healthy = monotonically increasing with tier)`);

  // ── 5. Stuckness (ASPIRATIONAL) — the promotion-gate evidence ─────────────
  section("5 · Stuckness → return behavior (promotion gate)");
  // From history: for each switched-away with stuckness, did the thread get
  // re-attended within its cadence? (resumed OR any later event for the thread.)
  const leaves = history.filter((h) => h.event === "switched-away" && h.stuckness !== null);
  const lastTs = history.length ? Math.max(...history.map((h) => h.ts)) : 0;
  const returnedS: number[] = [], notReturnedS: number[] = [];
  for (const l of leaves) {
    const cadence = l.cadenceMs ?? 24 * 3_600_000;
    const cameBack = history.some((h) =>
      h.threadId === l.threadId && h.ts > l.ts && h.ts <= l.ts + cadence &&
      (h.event === "resumed" || h.event === "switched-away"));
    // Right-censored: leave too close to log end to know — skip.
    if (!cameBack && lastTs - l.ts < cadence) continue;
    (cameBack ? returnedS : notReturnedS).push(l.stuckness!);
  }
  const a1 = auc(notReturnedS, returnedS); // does stuckness predict NOT coming back?
  console.log(`leaves w/ stuckness: ${leaves.length} · returned-within-cadence ${returnedS.length} · not ${notReturnedS.length} (censored skipped)`);
  if (a1 === null) {
    console.log(`  not enough resolved outcomes yet`);
  } else {
    const meanR = returnedS.reduce((a, b) => a + b, 0) / (returnedS.length || 1);
    const meanN = notReturnedS.reduce((a, b) => a + b, 0) / (notReturnedS.length || 1);
    console.log(`  AUC(stuckness → no-return) = ${f2(a1)}  (0.5 = no signal)`);
    console.log(`  mean stuckness: returned ${f2(meanR)} vs not-returned ${f2(meanN)}`);
    console.log(a1 >= 0.65
      ? `  ➜ signal detected — worth fitting a calibrated head + ESM confirms`
      : a1 <= 0.35
        ? `  ➜ INVERTED signal — stuck-looking threads get returned to MORE (grind ≠ stuck)`
        : `  ➜ no separation yet — keep stuckness display-only (honesty rule §4 holds)`);
  }
  // Explicit labels join: stuckness/difficulty at label time by action.
  const byAction = new Map<string, { n: number; stuck: number; diff: number }>();
  for (const l of labels) {
    const a = String(l.action ?? "");
    if (!byAction.has(a)) byAction.set(a, { n: 0, stuck: 0, diff: 0 });
    const e = byAction.get(a)!;
    e.n++; e.stuck += l.stuckness ?? 0; e.diff += l.difficulty ?? 0;
  }
  if (byAction.size) {
    console.log(`  explicit labels by action:`);
    for (const [a, e] of [...byAction.entries()].sort((x, y) => y[1].n - x[1].n)) {
      console.log(`    ${a.padEnd(12)} n=${String(e.n).padStart(3)} · stuckness ${f2(e.stuck / e.n)} · difficulty ${f2(e.diff / e.n)}`);
    }
  }

  section("Next data to collect");
  console.log(`· schema-2 rows carry latents — every future return sharpens head 5 automatically`);
  console.log(`· rotate the one-tap ESM ("blocked just now? yes/no") at breakpoints for gold stuck labels`);
  console.log();
}

main();
