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
const MAX_WINDOW_CHARS = 90_000;
const ENRICH_WINDOW_MINUTES = 10;

export interface WindowSlice {
  text: string;
  lineCount: number;
  truncated: boolean;
  coverage: string;
  /** Feed items in range — the save pipeline distills these. */
  feedItems: FeedItem[];
}

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

  // Scoped gestures ("apps" present = the user deselected something): audio
  // follows the "mic" chip; NON-audio feed lines (agent narration, streams)
  // are dropped entirely — they can't be attributed to one app, and the
  // agent's own summaries would leak content of a deselected app.
  const feedItems = feedBuffer.queryByTime(since)
    .filter((item) => item.source === "audio" ? micIncluded(scope) : !scope?.apps);
  for (const item of feedItems) {
    const tag = item.source === "audio" ? "🔊" : item.source;
    lines.push({ ts: item.ts, line: `[${fmtClock(item.ts)}] [${tag}] ${item.text}` });
  }

  let lastOcr = "";
  for (const ev of senseBuffer.queryByTime(since)) {
    const app = ev.semantic?.context?.app || ev.meta.app || "";
    if (!appIncluded(scope, app)) continue;
    const title = ev.meta.windowTitle ? ` — ${ev.meta.windowTitle}` : "";
    const ocr = (ev.ocr || "").trim();
    if (!ocr) {
      if (app) lines.push({ ts: ev.ts, line: `[${fmtClock(ev.ts)}] [screen] ${app}${title}` });
      continue;
    }
    // Skip near-identical consecutive OCR (rolling window keeps the raw stream;
    // the burst call doesn't need every repaint).
    if (ocr === lastOcr) continue;
    lastOcr = ocr;
    lines.push({ ts: ev.ts, line: `[${fmtClock(ev.ts)}] [screen ${app}${title}] ${ocr}` });
  }

  lines.sort((a, b) => a.ts - b.ts);
  let text = lines.map((l) => l.line).join("\n");
  let truncated = false;
  if (text.length > MAX_WINDOW_CHARS) {
    text = text.slice(text.length - MAX_WINDOW_CHARS);
    truncated = true;
  }
  return {
    text,
    lineCount: lines.length,
    truncated,
    coverage: describeCoverage(feedBuffer, senseBuffer, minutes, scope),
    feedItems,
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

export async function summonBrief(
  config: BurstConfig,
  slice: WindowSlice,
  minutes: number,
): Promise<{ brief: SummonBrief; result: BurstCallResult }> {
  const result = await burstCall(config, {
    system: SUMMON_SYSTEM,
    user: `Last ${minutes} minutes of activity:\n${slice.text}\n\nProduce the situation brief.`,
    cacheKey: "sinain-summon-v1",
    jsonMode: true,
  });
  const raw = parseBurstJson<Partial<SummonBrief>>(result.content);
  const brief: SummonBrief = {
    timeline: Array.isArray(raw.timeline)
      ? raw.timeline.filter((t) => t && t.what).slice(0, 5).map((t) => ({ at: String(t.at ?? ""), what: String(t.what) }))
      : [],
    goal: String(raw.goal ?? "").trim(),
    problems: Array.isArray(raw.problems) ? raw.problems.map(String).slice(0, 3) : [],
    entities: Array.isArray(raw.entities) ? raw.entities.map(String).slice(0, 6) : [],
  };
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
): Promise<{ card: EnrichCard; result: BurstCallResult }> {
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
  };
}
