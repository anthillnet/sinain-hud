import type { FeedBuffer } from "../buffers/feed-buffer.js";
import type { SenseBuffer } from "../buffers/sense-buffer.js";
import type { BriefTimelineEntry, BurstConfig, FeedItem } from "../types.js";
import { burstCall, parseBurstJson, type BurstCallResult } from "./burst-client.js";

/**
 * Deliberate-capture window operations: assemble a time-range slice of the
 * rolling window (feed + sense), describe its coverage for free (no LLM), and
 * run the burst-lane gestures (summon → situation brief, enrich → context card).
 */

// One burst call handles ≤ ~60 min at median density (benchmarked: 34K tok
// prefill = 1.38s on Cerebras). Beyond this we truncate oldest-first and flag
// the brief as partial — honest coverage beats a stalled gesture.
// Char budget for one burst prefill. Env-overridable (SINAIN_BURST_MAX_CHARS).
// Lowered 90K → 50K (measured 2026-07-09): a 60-min cap sweep showed the OLD
// 90K budget DROWNED the model — it returned empty briefs at 90K/120K (30–35K
// tokens) — while every cap ≤70K produced a rich brief, and 50–55K was the
// knee: richest brief at ~40% fewer tokens and lower latency. Less context is
// both cheaper AND better here (dilution law on the burst read side). Compact
// assembly packs ~2× info/char so 50K still covers ~half a dense 60-min range;
// summonBrief additionally retries-on-empty to rescue any residual drop. See
// docs/BASELINE-BURST-SPEND.md for the full cap/quality curve.
const DEFAULT_MAX_WINDOW_CHARS = 50_000;
function maxWindowChars(): number {
  const v = parseInt(process.env.SINAIN_BURST_MAX_CHARS || "", 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_WINDOW_CHARS;
}
const ENRICH_WINDOW_MINUTES = 10;

/**
 * Prefill composition + measured lever headroom for a window slice.
 * Instrumentation only (perf/burst-instrumentation) — computed for free during
 * the assembly pass, carried on WindowSlice, read by burst-metrics. Nothing
 * here changes the assembled `text`.
 */
export interface WindowStats {
  minutes: number;
  lineCount: number;
  /** length of the assembled text BEFORE the MAX_WINDOW_CHARS cap. */
  totalChars: number;
  /** chars the cap removed (0 when not truncated) — truncation headroom. */
  truncatedChars: number;
  // composition of the assembled lines
  ocrChars: number;
  transcriptChars: number;
  titleChars: number;
  ocrEvents: number;
  // measured lever headroom (deterministic)
  /** OCR frames skipped by the existing exact-consecutive filter (L2 floor). */
  exactDupDropped: number;
  /** surviving OCR frames >=0.9 shingle-similar to a recent one (L2 headroom). */
  nearDupOcrEvents: number;
  nearDupOcrChars: number;
  /** frames carrying a semantic summary/changes/activity (L1 applicability). */
  semanticEvents: number;
  /** what those frames would cost as dense semantic text instead of OCR (L1). */
  semanticAltChars: number;
}

export interface WindowSlice {
  text: string;
  lineCount: number;
  truncated: boolean;
  coverage: string;
  /** Feed items in range — the save pipeline distills these. */
  feedItems: FeedItem[];
  /** Instrumentation — prefill composition + lever headroom (see WindowStats). */
  stats: WindowStats;
}

/** Normalized trigram-shingle set for cheap near-duplicate OCR detection. */
function _shingles(s: string): Set<string> {
  const norm = s.toLowerCase().replace(/\s+/g, " ").trim();
  const out = new Set<string>();
  for (let i = 0; i + 3 <= norm.length; i += 1) out.add(norm.slice(i, i + 3));
  return out;
}

function _jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Dense semantic representation available for a sense event, if any (L1). */
function _semanticAlt(ev: { semantic?: { visible?: { summary?: string }; changes?: { delta: string }[]; context?: { activity?: string } } }): string {
  const sem = ev.semantic;
  if (!sem) return "";
  if (sem.visible?.summary) return sem.visible.summary;
  if (sem.changes && sem.changes.length > 0) return sem.changes.map((c) => c.delta).join("; ");
  if (sem.context?.activity) return sem.context.activity;
  return "";
}

/**
 * Compact assembly (perf/burst-instrumentation): OCR is ~98% of every burst
 * prefill and it is raw — the same UI chrome (menu bar, tab strip, file tree)
 * is re-shipped on every frame. Reconstruct real text LINES from the per-word
 * OCR boxes, then dedup lines ACROSS the whole window: each distinct line is
 * sent once, so chrome and re-read content collapse while every unique line
 * (the actual information a brief needs) is preserved in time order.
 * DEFAULT ON (measured 2026-07-09): enrich −30% tokens (identical card),
 * summon-30 −24% tokens AND the raw baseline returned an EMPTY brief (4 output
 * tokens — noise-drowned) where compact produced a full one; latency neutral;
 * ≤30-min truncation eliminated. Set SINAIN_BURST_COMPACT=0 for the legacy
 * raw-OCR path.
 */
const COMPACT_ASSEMBLY = () => process.env.SINAIN_BURST_COMPACT !== "0";

/** Group per-word OCR boxes into visual text lines (y-cluster, reading order). */
function _reconstructLines(
  ocrLines: { text: string; bbox: [number, number, number, number] }[] | undefined,
): string[] {
  if (!ocrLines || ocrLines.length === 0) return [];
  const items = ocrLines
    .map((l) => ({ t: (l.text || "").trim(), x: l.bbox?.[0] ?? 0, y: l.bbox?.[1] ?? 0, h: l.bbox?.[3] ?? 10 }))
    .filter((i) => i.t.length > 0);
  if (items.length === 0) return [];
  items.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const out: string[] = [];
  let cur: typeof items = [];
  let curY = items[0].y, curH = items[0].h;
  const flush = () => { if (cur.length) out.push(cur.sort((a, b) => a.x - b.x).map((i) => i.t).join(" ")); cur = []; };
  for (const it of items) {
    if (cur.length && Math.abs(it.y - curY) > Math.max(4, curH * 0.6)) flush();
    if (cur.length === 0) { curY = it.y; curH = it.h; }
    cur.push(it);
  }
  flush();
  return out;
}

const _normLine = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** User-selected scope for a range gesture: which sources are INCLUDED.
 *  `apps` holds app names plus the pseudo-source "mic"; undefined = all. */
export interface WindowScope {
  apps?: string[];
}

function appIncluded(scope: WindowScope | undefined, app: string): boolean {
  if (!scope?.apps) return true;
  // Consent-first: an unattributable event could be FROM the app the user
  // just deselected — under any scope, only explicitly allowed apps pass.
  if (!app || app === "unknown") return false;
  return scope.apps.includes(app);
}

function micIncluded(scope: WindowScope | undefined): boolean {
  return !scope?.apps || scope.apps.includes("mic");
}

/** Distinct sources in a range — drives the chooser's source checklist.
 *  `minutes` per source = distinct minute-buckets holding that source's
 *  events, so the row can say how much of the range it actually covers. */
export function listWindowSources(
  feedBuffer: FeedBuffer,
  senseBuffer: SenseBuffer,
  minutes: number,
): { name: string; kind: "app" | "mic"; minutes: number }[] {
  const since = Date.now() - minutes * 60_000;
  const appMinutes = new Map<string, Set<number>>();
  // Every event in range, not appHistory() — that records only focus
  // TRANSITIONS, undercounting an app that stays focused for 20 minutes as 1.
  for (const ev of senseBuffer.queryByTime(since)) {
    const app = ev.semantic?.context?.app || ev.meta.app || "";
    if (!app || app === "unknown") continue;
    let buckets = appMinutes.get(app);
    if (!buckets) appMinutes.set(app, (buckets = new Set()));
    buckets.add(Math.floor(ev.ts / 60_000));
  }
  const sources: { name: string; kind: "app" | "mic"; minutes: number }[] =
    [...appMinutes.entries()]
      .slice(0, 12)
      .map(([name, buckets]) => ({ name, kind: "app" as const, minutes: buckets.size }));
  const audioBuckets = new Set(
    feedBuffer.queryBySource("audio", since).map((i) => Math.floor(i.ts / 60_000)));
  if (audioBuckets.size > 0) {
    sources.push({ name: "mic", kind: "mic", minutes: audioBuckets.size });
  }
  return sources;
}

/** Free coverage string for a range: distinct apps + mic flag, newest first. */
export function describeCoverage(
  feedBuffer: FeedBuffer,
  senseBuffer: SenseBuffer,
  minutes: number,
  scope?: WindowScope,
): string {
  const since = Date.now() - minutes * 60_000;
  const apps: string[] = [];
  // Reverse iteration → newest app first, as the docstring promises.
  const history = senseBuffer.appHistory(since);
  for (let i = history.length - 1; i >= 0; i--) {
    const { app } = history[i];
    if (app && app !== "unknown" && !apps.includes(app) && appIncluded(scope, app)) apps.push(app);
  }
  const parts = apps.slice(0, 4);
  if (micIncluded(scope) && feedBuffer.queryBySource("audio", since).length > 0) parts.push("mic");
  return parts.length > 0 ? parts.join(", ") : "quiet range";
}

/** Chooser options with coverage + availability (how much history exists). */
export function chooserOptions(
  feedBuffer: FeedBuffer,
  senseBuffer: SenseBuffer,
): { minutes: number; covers: string; availableMinutes: number }[] {
  const now = Date.now();
  const oldestFeed = feedBuffer.queryByTime(0)[0]?.ts ?? now;
  const oldestSense = senseBuffer.queryByTime(0)[0]?.ts ?? now;
  const availableMinutes = Math.floor((now - Math.min(oldestFeed, oldestSense)) / 60_000);
  return [5, 15, 30, 60].map((minutes) => ({
    minutes,
    covers: describeCoverage(feedBuffer, senseBuffer, minutes),
    availableMinutes,
  }));
}

/** Assemble the chronological text slice of the window for the last N minutes. */
export function assembleWindow(
  feedBuffer: FeedBuffer,
  senseBuffer: SenseBuffer,
  minutes: number,
  scope?: WindowScope,
): WindowSlice {
  const since = Date.now() - minutes * 60_000;
  const lines: { ts: number; line: string }[] = [];

  // Instrumentation accumulators (perf/burst-instrumentation) — filled in the
  // same pass, no behavioural effect on `lines`/`text`.
  let ocrChars = 0, transcriptChars = 0, titleChars = 0, ocrEvents = 0;
  let exactDupDropped = 0, nearDupOcrEvents = 0, nearDupOcrChars = 0;
  let semanticEvents = 0, semanticAltChars = 0;
  const recentShingles: Set<string>[] = [];  // ring of last few kept OCR frames

  // Scoped gestures ("apps" present = the user deselected something): audio
  // follows the "mic" chip; NON-audio feed lines (agent narration, streams)
  // are dropped entirely — they can't be attributed to one app, and the
  // agent's own summaries would leak content of a deselected app.
  const feedItems = feedBuffer.queryByTime(since)
    .filter((item) => item.source === "audio" ? micIncluded(scope) : !scope?.apps);
  for (const item of feedItems) {
    const tag = item.source === "audio" ? "🔊" : item.source;
    const line = `[${fmtClock(item.ts)}] [${tag}] ${item.text}`;
    if (item.source === "audio") transcriptChars += line.length;
    lines.push({ ts: item.ts, line });
  }

  const compact = COMPACT_ASSEMBLY();
  const seenLines = new Set<string>();  // window-global line dedup (compact mode)
  let lastOcr = "";
  for (const ev of senseBuffer.queryByTime(since)) {
    const app = ev.semantic?.context?.app || ev.meta.app || "";
    if (!appIncluded(scope, app)) continue;
    const title = ev.meta.windowTitle ? ` — ${ev.meta.windowTitle}` : "";

    if (compact) {
      // Reconstruct real lines (fall back to flat OCR), then emit only lines
      // not already seen in this window — chrome and re-reads collapse.
      const recon = _reconstructLines(ev.ocrLines);
      const src = recon.length > 0 ? recon : ((ev.ocr || "").trim() ? [(ev.ocr || "").trim()] : []);
      if (src.length === 0) {
        if (app) {
          const line = `[${fmtClock(ev.ts)}] [screen] ${app}${title}`;
          titleChars += line.length;
          lines.push({ ts: ev.ts, line });
        }
        continue;
      }
      const novel: string[] = [];
      for (const l of src) {
        const n = _normLine(l);
        if (n.length < 3) continue;          // drop stray single glyphs
        if (seenLines.has(n)) continue;
        seenLines.add(n);
        novel.push(l);
      }
      if (novel.length === 0) { exactDupDropped += 1; continue; }  // fully redundant frame
      const line = `[${fmtClock(ev.ts)}] [screen ${app}${title}] ${novel.join(" · ")}`;
      lines.push({ ts: ev.ts, line });
      ocrEvents += 1;
      ocrChars += line.length;
      semanticAltChars += line.length;       // L1 measurement N/A once compacted
      continue;
    }

    // ── legacy raw path (byte-identical to pre-instrumentation) ──
    const ocr = (ev.ocr || "").trim();
    if (!ocr) {
      if (app) {
        const line = `[${fmtClock(ev.ts)}] [screen] ${app}${title}`;
        titleChars += line.length;
        lines.push({ ts: ev.ts, line });
      }
      continue;
    }
    // Skip near-identical consecutive OCR (rolling window keeps the raw stream;
    // the burst call doesn't need every repaint).
    if (ocr === lastOcr) { exactDupDropped += 1; continue; }
    lastOcr = ocr;
    const line = `[${fmtClock(ev.ts)}] [screen ${app}${title}] ${ocr}`;
    lines.push({ ts: ev.ts, line });

    // ── measure lever headroom (does NOT alter what we push) ──
    ocrEvents += 1;
    ocrChars += line.length;
    const alt = _semanticAlt(ev);
    if (alt) { semanticEvents += 1; semanticAltChars += alt.length; }
    else { semanticAltChars += line.length; }  // no semantic alt → L1 can't shrink it
    const sh = _shingles(ocr);
    let maxSim = 0;
    for (const prev of recentShingles) { const s = _jaccard(sh, prev); if (s > maxSim) maxSim = s; }
    if (maxSim >= 0.9) { nearDupOcrEvents += 1; nearDupOcrChars += line.length; }
    recentShingles.push(sh);
    if (recentShingles.length > 8) recentShingles.shift();
  }

  lines.sort((a, b) => a.ts - b.ts);
  const fullText = lines.map((l) => l.line).join("\n");
  const cap = maxWindowChars();
  let text = fullText;
  let truncated = false;
  if (fullText.length > cap) {
    // Drop whole OLDEST lines until under budget (keep the newest — most
    // relevant to "what am I doing now"). Whole-line boundaries beat the old
    // mid-string slice, which mangled the oldest surviving line.
    truncated = true;
    const rev: string[] = [];
    let total = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const add = lines[i].line.length + (rev.length ? 1 : 0);
      if (total + add > cap && rev.length) break;
      total += add;
      rev.push(lines[i].line);
    }
    text = rev.reverse().join("\n");
  }
  const stats: WindowStats = {
    minutes,
    lineCount: lines.length,
    totalChars: fullText.length,
    truncatedChars: fullText.length - text.length,
    ocrChars, transcriptChars, titleChars, ocrEvents,
    exactDupDropped, nearDupOcrEvents, nearDupOcrChars,
    semanticEvents, semanticAltChars,
  };
  return {
    text,
    lineCount: lines.length,
    truncated,
    coverage: describeCoverage(feedBuffer, senseBuffer, minutes, scope),
    feedItems,
    stats,
  };
}

// ── Summon: situation brief ──

const SUMMON_SYSTEM = `You are Sinain, an ambient assistant being summoned onto the user's recent activity.
You get a chronological slice of their screen OCR, window titles, and transcript.
Return JSON only:
{"timeline":[{"at":"<relative, e.g. -18m>","what":"<one short clause>"}],
 "goal":"<the user's current goal, one sentence>",
 "problems":["<open problem, short>"],
 "entities":["<key file/tool/person/term>"]}
Rules: 3-5 timeline rows, at most 3 problems, at most 6 entities.
Be specific to THIS activity — never generic filler.`;

export interface SummonBrief {
  timeline: BriefTimelineEntry[];
  goal: string;
  problems: string[];
  entities: string[];
}

function _parseBrief(content: string): SummonBrief {
  const raw = parseBurstJson<Partial<SummonBrief>>(content);
  return {
    timeline: Array.isArray(raw.timeline)
      ? raw.timeline.filter((t) => t && t.what).slice(0, 5).map((t) => ({ at: String(t.at ?? ""), what: String(t.what) }))
      : [],
    goal: String(raw.goal ?? "").trim(),
    problems: Array.isArray(raw.problems) ? raw.problems.map(String).slice(0, 3) : [],
    entities: Array.isArray(raw.entities) ? raw.entities.map(String).slice(0, 6) : [],
  };
}

const _briefEmpty = (b: SummonBrief): boolean =>
  b.timeline.length === 0 && b.entities.length === 0 && !b.goal;

export async function summonBrief(
  config: BurstConfig,
  slice: WindowSlice,
  minutes: number,
  seed?: number,
): Promise<{ brief: SummonBrief; result: BurstCallResult }> {
  const call = (s: number | undefined) => burstCall(config, {
    system: SUMMON_SYSTEM,
    user: `Last ${minutes} minutes of activity:\n${slice.text}\n\nProduce the situation brief.`,
    cacheKey: "sinain-summon-v1",
    jsonMode: true,
    seed: s,
  });
  // Reliability: the model occasionally returns an empty JSON object on a
  // large/noisy prefill, and with a fixed seed that empty would be permanent.
  // One retry with a different seed rescues it (measured empty-rate motivates
  // this — see docs/BASELINE-BURST-SPEND.md). Second attempt only on empty.
  let result = await call(seed);
  let brief = _parseBrief(result.content);
  if (_briefEmpty(brief)) {
    const alt = await call((seed ?? 42) + 1_000);
    const altBrief = _parseBrief(alt.content);
    if (!_briefEmpty(altBrief)) { result = alt; brief = altBrief; }
  }
  return { brief, result };
}

/** Flatten a brief into the text form carried into agent/voice seeds —
 *  mirrors the overlay's _briefText so every destination gets identical
 *  context. */
export function flattenBrief(brief: SummonBrief, minutes: number, coverage: string): string {
  const lines: string[] = [`Situation brief of my last ${minutes} minutes (${coverage}):`];
  for (const e of brief.timeline) lines.push(`${e.at}: ${e.what}`);
  lines.push(`Goal: ${brief.goal}`);
  if (brief.problems.length > 0) lines.push(`Open problems: ${brief.problems.join("; ")}`);
  return lines.join("\n");
}

// ── Enrich: context only ──
// One CONTEXT field, not what/connects: a forced split makes the model pad the
// second sentence with situation restatement. One field demands the linkage.
// No "next step": a prescriptive step baked into the card pre-empts the user's
// actual intention and can misdirect any agent the context is handed off to.

const ENRICH_SYSTEM = `You are Sinain, an ambient assistant. You get the user's recent activity window
(screen OCR, window titles, transcript) plus a focus item they copied.
Enrich the focus item with context. Return JSON only:
{"context":"<1-2 sentences: name what the copied item is AND tie it to the user's current activity, e.g. 'This is X — you hit it while doing Y; it matters because Z.' Never restate the situation without linking it to the item. If the item genuinely doesn't relate to recent activity, say that plainly instead of forcing a connection. Do NOT suggest actions or next steps.>"}`;

export interface EnrichCard {
  context: string;
}

/** Divider the overlay writes before Sinain-generated clipboard context. */
const SINAIN_CONTEXT_MARKER = "——— Context from Sinain ———";

export async function enrichFocus(
  config: BurstConfig,
  feedBuffer: FeedBuffer,
  senseBuffer: SenseBuffer,
  focus: string,
): Promise<{ card: EnrichCard; result: BurstCallResult; stats: WindowStats }> {
  // Defense in depth (the overlay strips too): never enrich our own output —
  // a clipboard that went through Copy/seed-enrich carries the marker block.
  const markerAt = focus.indexOf(SINAIN_CONTEXT_MARKER);
  if (markerAt >= 0) focus = focus.slice(0, markerAt).trim();
  const slice = assembleWindow(feedBuffer, senseBuffer, ENRICH_WINDOW_MINUTES);
  const result = await burstCall(config, {
    system: ENRICH_SYSTEM,
    // Window first (stable prefix → Cerebras prefix cache), focus last.
    user: `Recent activity window:\n${slice.text}\n\nFocus item (clipboard):\n${focus}\n\nEnrich it.`,
    maxTokens: 250,
    cacheKey: "sinain-enrich-v3",
    jsonMode: true,
  });
  const raw = parseBurstJson<Partial<EnrichCard>>(result.content);
  return {
    card: {
      context: String(raw.context ?? "").trim(),
    },
    result,
    stats: slice.stats,
  };
}
