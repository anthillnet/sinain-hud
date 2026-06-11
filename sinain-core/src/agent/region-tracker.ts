import { createHash } from "node:crypto";
import type { RawRegion, RegionHighlight, ContextWindow } from "../types.js";
import { log, debug } from "../log.js";

const TAG = "regions";

/** Stable region identity from normalized issue text — the same issue
 *  re-detected on a later tick maps to the same id (no eye flicker). */
export function regionIdFor(issue: string): string {
  const norm = issue.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return "r-" + createHash("sha256").update(norm).digest("hex").slice(0, 10);
}

interface TrackedRegion {
  region: RegionHighlight;
  lastSeenTick: number;
  firstSeenTs: number;
}

type ScreenEvent = ContextWindow["screen"][number];

/** True when the event carries a bbox that localizes a screen area (not the
 *  whole frame — full-frame anchors place the eye at a misleading corner). */
function hasPartialBbox(e: ScreenEvent): boolean {
  if (!e.imageBbox || e.imageBbox.length !== 4) return false;
  const [, , w, h] = e.imageBbox;
  if (!(w > 0 && h > 0)) return false;
  if (e.frameSize && e.frameSize.length === 2) {
    const coverage = (w * h) / (e.frameSize[0] * e.frameSize[1]);
    return coverage < 0.85;
  }
  // Frame size unknown — accept; the overlay clamps to screen bounds anyway
  return true;
}

/** Deterministic anchoring fallback: pick the newest partial-bbox event whose
 *  OCR shares the most significant words with the issue text. */
function anchorByText(issue: string, screen: ScreenEvent[]): ScreenEvent | undefined {
  const tokens = issue.toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length >= 4);
  if (tokens.length === 0) return undefined;
  let best: ScreenEvent | undefined;
  let bestScore = 0;
  // ctx.screen is newest-first; >= keeps the newest among equal scores
  for (const e of screen) {
    if (!hasPartialBbox(e) || !e.ocr) continue;
    const ocr = e.ocr.toLowerCase();
    const score = tokens.reduce((n, t) => n + (ocr.includes(t) ? 1 : 0), 0);
    if (score > bestScore) {
      best = e;
      bestScore = score;
    }
  }
  return bestScore >= 1 ? best : undefined;
}

/** Refine the anchor from the event's change-region bbox to the exact OCR
 *  LINE matching the issue text. The change-region can span half a screen —
 *  an eye at its corner sits nowhere near the problem. Line boxes come from
 *  Vision OCR (full-frame pixel coords, same space as imageBbox). */
function refineToLine(
  issue: string,
  src: ScreenEvent,
): [number, number, number, number] | undefined {
  const lines = src.ocrLines;
  if (!lines?.length) return undefined;
  const tokens = issue.toLowerCase().split(/[^a-z0-9_а-яё]+/i).filter(t => t.length >= 3);
  if (tokens.length === 0) return undefined;
  let best: { score: number; bbox: [number, number, number, number] } | undefined;
  for (const l of lines) {
    if (!Array.isArray(l.bbox) || l.bbox.length !== 4 || !l.text) continue;
    const lt = l.text.toLowerCase();
    const score = tokens.reduce((n, t) => n + (lt.includes(t) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score)) {
      best = { score, bbox: l.bbox };
    }
  }
  // Require a solid match: at least 2 tokens, or all of them for short issues.
  const need = Math.min(2, tokens.length);
  return best && best.score >= need ? best.bbox : undefined;
}

export interface RegionTrackerOpts {
  /** Drop a region after this many ticks without re-detection (default 2) */
  maxMissedTicks?: number;
  /** Wall-clock safety TTL (default 5 min) */
  maxAgeMs?: number;
  /** Max simultaneously tracked regions (default 3) */
  maxRegions?: number;
}

/**
 * Tracks actionable screen regions across analysis ticks (Grammarly mode).
 *
 * The analyzer LLM emits raw regions anchored to sense events (sourceId);
 * this tracker resolves bbox/frameSize from the referenced event, assigns
 * stable content-hash ids, and expires regions that stop being detected.
 * update() returns the full current set only when it changed — callers
 * broadcast that as a region_highlight message and the overlay diffs by id.
 */
export class RegionTracker {
  private tracked = new Map<string, TrackedRegion>();
  private tick = 0;
  private readonly maxMissedTicks: number;
  private readonly maxAgeMs: number;
  /** Context archive: every region that ever expired off-screen, kept for
   *  late context fetches (see get()). No TTL — capped FIFO only. */
  private readonly expired = new Map<string, { region: RegionHighlight; expiredAt: number }>();
  private static readonly ARCHIVE_MAX = 50;
  private readonly maxRegions: number;

  constructor(opts: RegionTrackerOpts = {}) {
    // 4 (was 2): even with fuzzy re-match the model legitimately skips a
    // region on some ticks (attention rotates among on-screen items) — two
    // skips at a 3-6s cadence killed eyes for issues still on screen.
    this.maxMissedTicks = opts.maxMissedTicks ?? 4;
    this.maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
    this.maxRegions = opts.maxRegions ?? 3;
  }

  /**
   * Ingest one tick's raw regions. Call every tick (with undefined when the
   * LLM emitted none) so expiry advances. Returns the new full set if it
   * differs from the previous tick's, else null.
   */
  update(raw: RawRegion[] | undefined, ctx: ContextWindow): RegionHighlight[] | null {
    this.tick++;
    const before = this.stateKey();

    // Expire FIRST, then admit. The other order had a starvation bug: the
    // capacity check saw the set still full of about-to-expire regions, so
    // every incoming replacement was rejected by the cap — then expiry
    // emptied the set ("emitted 3 → 0 active" oscillation).
    this.expireStale();

    // App-scoped eyes: a region anchored in another app's window is
    // meaningless floating over the current one — archive it the moment the
    // frontmost app changes (~1-2s after switch, via sense events) instead
    // of waiting out the miss window. Switching back re-creates it on the
    // next detection; its context survives in the archive either way.
    const curApp = (ctx.currentApp || "").toLowerCase().trim();
    if (curApp) {
      for (const [id, t] of this.tracked) {
        const regionApp = (t.region.app || "").toLowerCase().trim();
        if (regionApp && regionApp !== curApp) {
          this.tracked.delete(id);
          this.expired.set(id, { region: t.region, expiredAt: Date.now() });
          debug(TAG, `region ${id} hidden — app switch (${regionApp} → ${curApp})`);
        }
      }
    }

    for (const r of raw ?? []) {
      const id = regionIdFor(r.issue);
      // Exact id hit, else fuzzy re-match: identity is a hash of the issue
      // text, but LLMs rephrase between ticks ("Missing import for X" →
      // "X import missing") — without fuzzy matching the old region misses
      // its ticks and expires while the issue is still on screen. A token-
      // Jaccard ≥ 0.5 counts as the same issue; the ORIGINAL id is kept so
      // the eye, thread, and session stay stable across rewordings.
      const existing = this.tracked.get(id) ?? this.matchByTokens(r.issue);
      if (existing) {
        existing.lastSeenTick = this.tick;
        existing.region.tip = r.tip;
        if (r.action) existing.region.action = r.action;
        continue;
      }
      if (this.tracked.size >= this.maxRegions) continue;

      // Anchor resolution: sourceId echo from the LLM, falling back to a
      // deterministic OCR text match (small local models often drop the id).
      // Full-frame bboxes are demoted — an eye at the corner of the whole
      // frame is no better than the corner stack, and misleads.
      let src = r.sourceId !== undefined
        ? ctx.screen.find(e => e.id === r.sourceId)
        : undefined;
      if (!src || !hasPartialBbox(src)) {
        src = anchorByText(r.issue, ctx.screen) ?? src;
      }
      const anchored = src && hasPartialBbox(src);
      // Precise-or-nothing: an eye is only useful next to the thing it points
      // at. If we can't resolve a localized bbox (sourceId echo or OCR text
      // match), drop the region rather than corner-stack a misplaced eye that
      // misleads and distracts. Looser emission upstream keeps the supply up.
      if (!anchored) {
        log(TAG, `skip unanchored region: "${r.issue}" (sourceId=${r.sourceId ?? "-"})`);
        continue;
      }
      // Snap to the exact OCR line when its text matches the issue — the
      // change-region bbox is only the fallback granularity.
      const lineBbox = refineToLine(r.issue, src!);
      const bbox = lineBbox ?? (src!.imageBbox as [number, number, number, number]);
      const frameSize = src!.frameSize && src!.frameSize.length === 2
        ? src!.frameSize as [number, number]
        : undefined;

      this.expired.delete(id); // re-detected — drop any tombstone
      this.tracked.set(id, {
        region: {
          id,
          issue: r.issue,
          tip: r.tip,
          action: r.action,
          bbox,
          frameSize,
          sourceOcr: src?.ocr ? src.ocr.slice(0, 2000) : undefined,
          app: src?.meta.app ?? ctx.currentApp,
        },
        lastSeenTick: this.tick,
        firstSeenTs: Date.now(),
      });
      debug(TAG, `new region ${id}: "${r.issue}" (bbox=${bbox ? bbox.join(",") : "none"})`);
    }

    if (this.stateKey() === before) return null;
    const current = this.current();
    log(TAG, `region set changed: ${current.length} active [${current.map(r => r.id).join(", ")}]`);
    return current;
  }

  /** Expire regions not re-detected within the miss window (or past TTL).
   *  Runs at the START of update() so freed capacity is available to the
   *  same tick's incoming regions. */
  private expireStale(): void {
    const now = Date.now();
    for (const [id, t] of this.tracked) {
      if (this.tick - t.lastSeenTick > this.maxMissedTicks ||
          now - t.firstSeenTs > this.maxAgeMs) {
        this.tracked.delete(id);
        // Archive, never invalidate: the contract is "anything the user
        // could see or click resolves its context". Expiry only removes the
        // eye from the SCREEN; the captured context (issue/tip/OCR/app)
        // stays addressable for the life of the process so a thread or
        // terminal opened from it always seeds. Capped FIFO for memory.
        this.expired.set(id, { region: t.region, expiredAt: now });
        debug(TAG, `expired region ${id} (context archived)`);
      }
    }
    while (this.expired.size > RegionTracker.ARCHIVE_MAX) {
      const oldest = this.expired.keys().next().value;
      if (oldest === undefined) break;
      this.expired.delete(oldest);
    }
  }

  /** Fuzzy lookup: tracked region whose issue shares ≥0.5 token-Jaccard
   *  with [issue] — treats an LLM rewording as a re-detection. */
  private matchByTokens(issue: string): TrackedRegion | undefined {
    const tok = (s: string) =>
      new Set(s.toLowerCase().split(/[^a-z0-9а-яё]+/i).filter(t => t.length >= 3));
    const a = tok(issue);
    if (a.size === 0) return undefined;
    let best: { t: TrackedRegion; j: number } | undefined;
    for (const t of this.tracked.values()) {
      const b = tok(t.region.issue);
      if (b.size === 0) continue;
      let inter = 0;
      for (const x of a) if (b.has(x)) inter++;
      const j = inter / (a.size + b.size - inter);
      if (!best || j > best.j) best = { t, j };
    }
    return best && best.j >= 0.5 ? best.t : undefined;
  }

  /** Current region set (insertion order). */
  current(): RegionHighlight[] {
    return [...this.tracked.values()].map(t => t.region);
  }

  /** Look up a region for spawn-time context assembly. Live regions first,
   *  then the context archive — anything the user could see or click stays
   *  resolvable; eyes leaving the screen never invalidates their context. */
  get(id: string): RegionHighlight | undefined {
    return this.tracked.get(id)?.region ?? this.expired.get(id)?.region;
  }

  clear(): void {
    // Clears the SCREEN (live eyes) only. The context archive survives —
    // toggling auto-detect off must not break threads already opened.
    for (const [id, t] of this.tracked) {
      this.expired.set(id, { region: t.region, expiredAt: Date.now() });
    }
    this.tracked.clear();
  }

  /** Cheap change-detection key: ids + tips (tips refresh in place). */
  private stateKey(): string {
    return [...this.tracked.entries()].map(([id, t]) => `${id}:${t.region.tip}`).join("|");
  }
}

/**
 * Build the spawn task text for a tapped region — structured context
 * assembled at spawn time (region metadata + source OCR + fresh digest),
 * not stale text embedded at detection time.
 */
export function buildRegionTaskText(
  region: RegionHighlight,
  latestDigest?: string,
  userNote?: string,
  knowledge?: string,
): string {
  const parts = [
    `[Region — ${region.action ?? "help"}] ${region.issue}`,
    `Suggested approach: ${region.tip}`,
  ];
  if (region.sourceOcr) {
    parts.push(`\nScreen text where the issue was observed (${region.app ?? "unknown app"}):\n${region.sourceOcr}`);
  }
  if (latestDigest) {
    parts.push(`\nCurrent situation:\n${latestDigest}`);
  }
  if (knowledge?.trim()) {
    parts.push(`\nRelevant long-term knowledge about the user/topic:\n${knowledge.trim()}`);
  }
  if (userNote?.trim()) {
    parts.push(`\nUser note: ${userNote.trim()}`);
  }
  parts.push(
    `\nYou have sinain MCP tools for deeper context: sinain_knowledge_query ` +
    `(long-term facts about entities/topics), sinain_get_context (current ` +
    `screen/audio), sinain_get_digest (situation summary). Query them when ` +
    `the seed above isn't enough.`,
  );
  parts.push(`\nAct on the specific issue above. Be concrete and concise.`);
  return parts.join("\n");
}
