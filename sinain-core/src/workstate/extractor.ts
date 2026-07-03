// Extractor — reads the sense/feed ring buffers and derives cheap, domain-blind
// RawFeatures (no LLM, no per-tick cost). Drives the WSM estimate each tick.

import type { SenseBuffer } from "../buffers/sense-buffer.js";
import type { FeedBuffer } from "../buffers/feed-buffer.js";
import type { RawFeatures } from "./types.js";

const WINDOW_MS = 60_000; // rolling window for cadence/switch-rate
const AUDIO_WINDOW_MS = 30_000; // window for transcript surface + VAD density
// A region-issue must persist this many consecutive ticks to read as "the same
// unresolved issue" (~7.5s at the 2.5s cadence) — recurrence of the SAME
// semantic issue, not any transient detection.
const ISSUE_PERSIST_TICKS = 3;

// Coarse, app-level activity (dossier §B: window/app is the ~70–90% workhorse;
// finer classes aren't recoverable from OS signals, so we stop at coarse).
function coarseActivity(app: string, title: string): string {
  const s = `${app} ${title}`.toLowerCase();
  if (/zoom|meet\.|teams|webex|huddle|facetime/.test(s)) return "meeting";
  if (/terminal|iterm|warp|code|zed|intellij|idea|pycharm|xcode|vim/.test(s)) return "coding";
  if (/docs|word|pages|notion|obsidian|bear|writer/.test(s)) return "writing";
  if (/mail|gmail|slack|message|telegram|discord/.test(s)) return "communication";
  if (/chrome|safari|firefox|arc|browser/.test(s)) return "reading";
  return "working";
}

// ── Structural project/thread identity ──────────────────────────────────────
// One project = one stable thread, keyed off the window context (the most
// reliable signal we have) — NOT fuzzy OCR-embedding matching. Editors → the
// repo; chat/agent apps → the conversation; browsers → the page; else the app.

const _APP_SUFFIX =
  /\s+[—–-]\s+(Visual Studio Code|Zed|IntelliJ IDEA|PyCharm|WebStorm|Xcode|Cursor|Sublime Text|Google Chrome|Google Docs|Google Sheets|Google Slides|YouTube|Safari|Mozilla Firefox|Firefox|Microsoft Edge|Claude|ChatGPT|Arc)\s*$/i;

function cleanTitle(t: string): string {
  return t.replace(/^\(\d+\)\s*/, "").replace(_APP_SUFFIX, "").trim();
}

// Browser titles append "<page> - <Browser> - <Profile>" — strip from the
// browser name onward, and drop the unread-count prefix that churns the key.
function browserPage(title: string): string | null {
  const t = title
    .replace(/\s+[—–-]\s+(Google Chrome|Chromium|Safari|Mozilla Firefox|Firefox|Microsoft Edge|Arc|Brave|Opera)\b.*$/i, "")
    .replace(/^\(\d[\d,]*\)\s*/, "")
    .trim();
  return t || null;
}

function editorProject(title: string): string | null {
  const t = cleanTitle(title);
  if (!t) return null;
  // "file.ext — repo — branch" / "repo – file.ext:line" → the repo is the
  // segment that isn't a filename/path; prefer the longest (branches are short).
  const parts = t.split(/\s+[—–]\s+|\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  const nonFile = parts.filter((p) => !/\.[a-z0-9]{1,5}$/i.test(p) && !p.includes("/"));
  const pool = nonFile.length ? nonFile : parts;
  return pool.sort((a, b) => b.length - a.length)[0] ?? null;
}

export function deriveProject(app: string, title: string): { key: string; label: string } {
  const a = app.toLowerCase();
  if (/zed|vscode|vs code|code|cursor|sublime|intellij|idea|pycharm|webstorm|goland|rubymine|clion|rider|xcode|android studio|nova|vim|nvim|emacs/.test(a)) {
    const proj = editorProject(title);
    if (proj) return { key: `proj:${proj.toLowerCase()}`, label: proj };
  }
  if (/claude|chatgpt|gemini|copilot|perplexity/.test(a)) {
    const conv = cleanTitle(title) || app;
    return { key: `chat:${conv.toLowerCase()}`, label: conv };
  }
  if (/chrome|safari|firefox|arc|brave|edge|opera/.test(a)) {
    const page = browserPage(title);
    if (page) {
      // Web apps churn their page titles — key by a stable site/repo instead.
      if (/\bgmail\b/i.test(title)) return { key: "web:gmail", label: "Gmail" };
      const repo = page.match(/([\w.-]+\/[\w.-]+)(?:[@#]|\b)/); // owner/repo (GitHub…)
      if (repo) return { key: `web:${repo[1].toLowerCase()}`, label: repo[1] };
      const short = page.split(/\s+/).slice(0, 5).join(" ");
      return { key: `web:${short.toLowerCase()}`, label: page };
    }
  }
  return { key: `app:${a}`, label: app };
}

export interface ExtractorState {
  prevApp: string;
  appRunStart: number; // when the current contiguous app-run began
  /** region id → consecutive ticks it has stayed on the active surface. */
  regionTicks?: Map<string, number>;
}

export function buildRawFeatures(
  senseBuffer: SenseBuffer,
  feedBuffer: FeedBuffer,
  state: ExtractorState,
  now: number,
  /** Ids of the LLM-detected region-issues currently on the active surface —
   *  the semantic layer's "open issues" (language generalizes across domains;
   *  no keyword matching here, per design §2 domain-blind rule). */
  activeRegionIds: string[] = [],
): RawFeatures | null {
  const latest = senseBuffer.latest();
  if (!latest) return null;

  const app = latest.meta?.app || "unknown";
  const windowTitle = latest.meta?.windowTitle;

  // Recent sense events (buffer holds ≤30) sorted ascending by ts.
  const recent = senseBuffer
    .query(0)
    .filter((e) => now - e.ts <= WINDOW_MS)
    .sort((a, b) => a.ts - b.ts);

  // Switch-rate: app transitions per minute over the window.
  let transitions = 0;
  for (let i = 1; i < recent.length; i++) {
    if ((recent[i].meta?.app || "") !== (recent[i - 1].meta?.app || "")) transitions++;
  }
  const windowMin = Math.max(WINDOW_MS / 60_000, recent.length ? (now - recent[0].ts) / 60_000 : 1);
  const switchRate = windowMin > 0 ? transitions / windowMin : 0;

  // Dwell on the current app (scene-cut resets the run).
  const sceneCut = app !== state.prevApp;
  if (sceneCut) state.appRunStart = now;
  state.prevApp = app;
  const dwellMs = now - state.appRunStart;

  // repeated-same-issue (§B — the one signal with real specificity). Sourced
  // from SEMANTIC layers only — never OCR keywords (a token like "null" is code
  // on a dev screen and prose on a lawyer's; keyword matching is the hardcoded
  // app-culture semantics the design bans). Two channels:
  //   1. ≥2 recent sense events the semantic pass flagged has_error, or
  //   2. the SAME LLM-detected region-issue persisting across ticks — identity
  //      via region id (the tracker anchors regions by content).
  const semErrEvents = recent.filter((e) => e.semantic?.visible?.has_error);
  const ticks = state.regionTicks ?? (state.regionTicks = new Map());
  const live = new Set(activeRegionIds);
  for (const id of ticks.keys()) if (!live.has(id)) ticks.delete(id);
  for (const id of live) ticks.set(id, (ticks.get(id) ?? 0) + 1);
  const persistentIssue = [...ticks.values()].some((n) => n >= ISSUE_PERSIST_TICKS);
  const recurringIssue = semErrEvents.length >= 2 || persistentIssue;

  // Audio: recent transcript text + a presence proxy (audio feed items / window).
  const audioItems = feedBuffer.query(0).filter((f) => f.source === "audio" && now - f.ts <= AUDIO_WINDOW_MS);
  const transcript = audioItems.map((f) => f.text).join(" ").slice(-600);
  const vadDensity = Math.min(1, audioItems.length / 6); // ~6 segs/30s ≈ continuous speech

  const surfaceText = `${windowTitle || ""} ${latest.ocr || ""} ${transcript}`.trim().slice(0, 1200);
  const project = deriveProject(app, windowTitle || "");

  return {
    ts: now,
    app,
    windowTitle,
    surfaceText,
    switchRate,
    dwellMs,
    recurringIssue,
    vadDensity,
    activityHint: coarseActivity(app, windowTitle || ""),
    sceneCut,
    projectKey: project.key,
    projectLabel: project.label,
  };
}
