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
  private readonly maxRegions: number;

  constructor(opts: RegionTrackerOpts = {}) {
    this.maxMissedTicks = opts.maxMissedTicks ?? 2;
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

    for (const r of raw ?? []) {
      const id = regionIdFor(r.issue);
      const existing = this.tracked.get(id);
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
        debug(TAG, `skip unanchored region: "${r.issue}"`);
        continue;
      }
      const bbox = src!.imageBbox as [number, number, number, number];
      const frameSize = src!.frameSize && src!.frameSize.length === 2
        ? src!.frameSize as [number, number]
        : undefined;

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

    const now = Date.now();
    for (const [id, t] of this.tracked) {
      if (this.tick - t.lastSeenTick > this.maxMissedTicks ||
          now - t.firstSeenTs > this.maxAgeMs) {
        this.tracked.delete(id);
        debug(TAG, `expired region ${id}`);
      }
    }

    if (this.stateKey() === before) return null;
    const current = this.current();
    log(TAG, `region set changed: ${current.length} active [${current.map(r => r.id).join(", ")}]`);
    return current;
  }

  /** Current region set (insertion order). */
  current(): RegionHighlight[] {
    return [...this.tracked.values()].map(t => t.region);
  }

  /** Look up a tracked region (spawn-time context assembly). */
  get(id: string): RegionHighlight | undefined {
    return this.tracked.get(id)?.region;
  }

  clear(): void {
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
  if (userNote?.trim()) {
    parts.push(`\nUser note: ${userNote.trim()}`);
  }
  parts.push(`\nAct on the specific issue above. Be concrete and concise.`);
  return parts.join("\n");
}
