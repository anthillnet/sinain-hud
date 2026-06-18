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
  /** Tick at which this region was optimistically restored (app re-entry).
   *  A pending region not confirmed by the analyzer within
   *  PENDING_CONFIRM_TICKS is archived again to avoid a stale eye lingering. */
  restoredAtTick?: number;
  /** Consecutive local re-anchor frames on which this region's content was NOT
   *  found (reanchorLive). After LOCAL_MISS_LIMIT, the eye dims — its anchored
   *  text has scrolled off, without waiting for an analyzer tick to miss it. */
  localMisses?: number;
}

/** Largest single-axis shift between two bboxes, in full-frame pixels. */
function bboxShift(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  return Math.max(
    Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]),
    Math.abs(a[2] - b[2]), Math.abs(a[3] - b[3]),
  );
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
): { bbox: [number, number, number, number]; text: string } | undefined {
  const lines = src.ocrLines;
  if (!lines?.length) return undefined;
  const tokens = issue.toLowerCase().split(/[^a-z0-9_а-яё]+/i).filter(t => t.length >= 3);
  if (tokens.length === 0) return undefined;
  let best: { score: number; bbox: [number, number, number, number]; text: string } | undefined;
  for (const l of lines) {
    if (!Array.isArray(l.bbox) || l.bbox.length !== 4 || !l.text) continue;
    const lt = l.text.toLowerCase();
    const score = tokens.reduce((n, t) => n + (lt.includes(t) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score)) {
      best = { score, bbox: l.bbox, text: l.text };
    }
  }
  // Require a solid match: at least 2 tokens, or all of them for short issues.
  const need = Math.min(2, tokens.length);
  return best && best.score >= need ? { bbox: best.bbox, text: best.text } : undefined;
}

/** Find a previously-anchored OCR line verbatim on a fresh frame, returning its
 *  new bbox. Normalized exact-or-containment match — robust to the line being a
 *  substring of a longer re-OCR'd line (and vice versa) and to whitespace/case
 *  drift. This is how an eye follows its content across frames regardless of how
 *  the LLM phrased the issue. */
function findLineByText(
  anchorText: string,
  frame: ScreenEvent,
): [number, number, number, number] | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const target = norm(anchorText);
  if (target.length < 4) return undefined; // too short to match safely
  for (const l of frame.ocrLines ?? []) {
    if (!Array.isArray(l.bbox) || l.bbox.length !== 4 || !l.text) continue;
    const lt = norm(l.text);
    if (lt === target || lt.includes(target) || target.includes(lt)) return l.bbox;
  }
  return undefined;
}

export interface RegionTrackerOpts {
  /** Drop a region after this many ticks without re-detection (default 2) */
  maxMissedTicks?: number;
  /** Wall-clock safety TTL (default 5 min) */
  maxAgeMs?: number;
  /** Max simultaneously tracked regions (default 3) */
  maxRegions?: number;
  /** Max time an archived eye may sit off-screen and still be eligible for
   *  optimistic restore on app re-entry (default 45s). Beyond this the eye's
   *  anchored content is assumed stale — it's left in the archive for context
   *  fetches but no longer flashed back; the analyzer re-detects it fresh if
   *  it's genuinely still on screen. */
  restoreMaxAgeMs?: number;
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
  /** Optimistically restored (pending) regions must be re-confirmed by the
   *  analyzer within this many ticks or they're archived again. Short, because
   *  Tier 2 fires an urgent analysis right after the app switch — one real
   *  tick is enough to confirm a still-present issue. */
  private static readonly PENDING_CONFIRM_TICKS = 2;
  /** Local re-anchor frames a region's content may be absent before its eye
   *  dims. >1 so a single noisy OCR frame can't flicker a still-present eye. */
  private static readonly LOCAL_MISS_LIMIT = 2;
  /** Min single-axis bbox shift (px) before a local re-anchor re-broadcasts —
   *  suppresses sub-pixel OCR jitter while still following real scroll/typing. */
  private static readonly BBOX_MOVE_EPSILON = 4;
  private readonly maxRegions: number;
  private readonly restoreMaxAgeMs: number;

  constructor(opts: RegionTrackerOpts = {}) {
    // 4 (was 2): even with fuzzy re-match the model legitimately skips a
    // region on some ticks (attention rotates among on-screen items) — two
    // skips at a 3-6s cadence killed eyes for issues still on screen.
    this.maxMissedTicks = opts.maxMissedTicks ?? 4;
    this.maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
    this.maxRegions = opts.maxRegions ?? 3;
    this.restoreMaxAgeMs = opts.restoreMaxAgeMs ?? 45_000;
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
    this.archiveForeign(ctx.currentApp);

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
        // Tier 3 — confirm: the analyzer re-detected an optimistically
        // restored region, so it's genuinely still on screen. Promote it
        // from pending (dimmed) to a solid eye and drop the short leash.
        if (existing.region.pending) {
          existing.region.pending = false;
          existing.restoredAtTick = undefined;
          // Re-anchor: it was restored at its stale archived bbox; snap it to
          // the fresh detection so the eye sits at the issue's current spot
          // (the user may have scrolled since it was last on screen).
          const anchor = this.resolveAnchor(r, ctx);
          if (anchor) {
            existing.region.bbox = anchor.bbox;
            existing.region.frameSize = anchor.frameSize;
            existing.region.anchorText = anchor.anchorText;
            if (anchor.src.ocr) existing.region.sourceOcr = anchor.src.ocr.slice(0, 2000);
          }
          debug(TAG, `region ${existing.region.id} confirmed (was pending)`);
        }
        continue;
      }
      if (this.tracked.size >= this.maxRegions) continue;

      // Anchor resolution (sourceId echo → OCR text match → OCR line refine).
      // Precise-or-nothing: an eye is only useful next to the thing it points
      // at. If we can't resolve a localized bbox, drop the region rather than
      // corner-stack a misplaced eye that misleads. Looser emission upstream
      // keeps the supply up. Full-frame bboxes are demoted inside resolveAnchor.
      const anchor = this.resolveAnchor(r, ctx);
      if (!anchor) {
        log(TAG, `skip unanchored region: "${r.issue}" (sourceId=${r.sourceId ?? "-"})`);
        continue;
      }
      const { src, bbox, frameSize, anchorText } = anchor;

      // App-scoped admission: never anchor a NEW eye to a window that isn't
      // frontmost. The sense buffer keeps the previous app's OCR for up to
      // ~2 min after a switch (context-window maxAgeMs), and the analyzer
      // happily re-detects issues in it — which would otherwise spawn eyes for
      // the old app over the current screen every tick. This is the birth-side
      // mirror of archiveForeign (which only removes already-live foreign eyes).
      const srcApp = (src.meta.app || "").toLowerCase().trim();
      const curApp = (ctx.currentApp || "").toLowerCase().trim();
      if (srcApp && curApp && curApp !== "unknown" && srcApp !== curApp) {
        debug(TAG, `skip foreign-app region: "${r.issue}" (src=${srcApp} ≠ current=${curApp})`);
        continue;
      }

      this.expired.delete(id); // re-detected — drop any tombstone
      this.tracked.set(id, {
        region: {
          id,
          issue: r.issue,
          tip: r.tip,
          action: r.action,
          bbox,
          frameSize,
          anchorText,
          sourceOcr: src.ocr ? src.ocr.slice(0, 2000) : undefined,
          // || not ?? — an empty-string app (app-detector timed out that
          // frame) must fall back to currentApp, else region.app="" and
          // archiveForeign skips it (falsy), leaving a foreign eye that never
          // clears on app switch. currentApp is "unknown" at worst, never "".
          app: src.meta.app || ctx.currentApp,
          // Display the region was detected on (multi-display) — overlay places
          // the eye on the matching screen.
          display: src.meta.screen,
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

  /** Resolve a localized screen anchor for a raw region: sourceId echo from
   *  the LLM, else a deterministic OCR text match. Anchors to the precise OCR
   *  LINE when the issue text matches one — which works even when the change
   *  region is the whole frame (switching INTO an editor repaints everything,
   *  so its change-bbox is full-frame, but its per-line OCR boxes are still
   *  localized). Only falls back to the raw change-region bbox when it's
   *  partial; returns null when nothing localized can be found (a full-frame
   *  corner eye points nowhere useful). */
  private resolveAnchor(
    r: RawRegion,
    ctx: ContextWindow,
  ): { src: ScreenEvent; bbox: [number, number, number, number]; frameSize?: [number, number]; anchorText?: string } | null {
    // Keep the sourceId event as a candidate even if its change-region is
    // full-frame — we may still anchor to a precise OCR line within it.
    let src = r.sourceId !== undefined
      ? ctx.screen.find(e => e.id === r.sourceId)
      : undefined;
    if (!src || !hasPartialBbox(src)) {
      src = anchorByText(r.issue, ctx.screen) ?? src;
    }
    if (!src) return null;
    const frameSize = src.frameSize && src.frameSize.length === 2
      ? src.frameSize as [number, number]
      : undefined;
    // Precise OCR-line box first — localized regardless of change-region size.
    // Capture the matched line verbatim so re-anchoring can track it directly.
    const line = refineToLine(r.issue, src);
    if (line) return { src, bbox: line.bbox, frameSize, anchorText: line.text };
    // No line match — only anchor to the change-region if it's localized.
    if (!hasPartialBbox(src)) return null;
    return { src, bbox: src.imageBbox as [number, number, number, number], frameSize };
  }

  /** Expire regions not re-detected within the miss window (or past TTL).
   *  Runs at the START of update() so freed capacity is available to the
   *  same tick's incoming regions. */
  private expireStale(): void {
    const now = Date.now();
    for (const [id, t] of this.tracked) {
      // Tier 3 — pending leash: an optimistically restored region the
      // analyzer hasn't re-confirmed within PENDING_CONFIRM_TICKS is archived
      // again. Keeps a stale eye from lingering when the user returned to a
      // screen whose content has since changed (scrolled, different file).
      if (t.region.pending && t.restoredAtTick !== undefined &&
          this.tick - t.restoredAtTick >= RegionTracker.PENDING_CONFIRM_TICKS) {
        this.tracked.delete(id);
        t.region.pending = false;
        t.restoredAtTick = undefined;
        this.expired.set(id, { region: t.region, expiredAt: now });
        debug(TAG, `pending region ${id} unconfirmed — re-archived`);
        continue;
      }
      // Manual (user-selected) regions are pinned: the analyzer never
      // re-emits them, so miss-window expiry would kill every one after a
      // few ticks. They leave only via the app-scope rule or archive cap.
      if (t.region.manual) continue;
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

  /** Archive eyes anchored in another app — a region floating over a window
   *  it doesn't belong to is meaningless. Runs both on every analyzer tick
   *  (via update) and on app focus change (via onAppFocus). */
  private archiveForeign(curAppRaw: string | null | undefined): void {
    const curApp = (curAppRaw || "").toLowerCase().trim();
    if (!curApp) return;
    for (const [id, t] of this.tracked) {
      const regionApp = (t.region.app || "").toLowerCase().trim();
      if (regionApp && regionApp !== curApp) {
        this.tracked.delete(id);
        this.expired.set(id, { region: t.region, expiredAt: Date.now() });
        debug(TAG, `region ${id} hidden — app switch (${regionApp} → ${curApp})`);
      }
    }
  }

  /** Tier 1 — optimistic restore: re-admit archived eyes for the app the user
   *  just switched TO, marked pending (overlay dims them), so they reappear
   *  instantly instead of after a full sense→OCR→LLM cycle. Newest-archived
   *  first, up to the region cap. The analyzer confirms (or the pending leash
   *  expires) them on the next tick. */
  private restorePending(curAppRaw: string | null | undefined): void {
    const curApp = (curAppRaw || "").toLowerCase().trim();
    if (!curApp) return;
    const now = Date.now();
    for (const [id, e] of [...this.expired.entries()].reverse()) {
      if (this.tracked.size >= this.maxRegions) break;
      const regionApp = (e.region.app || "").toLowerCase().trim();
      if (regionApp !== curApp) continue;
      // Freshness gate: only optimistically restore eyes that left the screen
      // recently. An eye archived minutes ago is anchored to content that has
      // since scrolled/changed away — flashing it back produces a stale eye
      // that re-confirms against nothing and dies on the pending leash, only to
      // reappear on the next focus switch (the resurrection loop). Stale eyes
      // stay in the archive for context fetches; the analyzer re-detects them
      // fresh (with a current anchor) if the issue is genuinely still present.
      // Manual eyes are user-pinned — they outlive any freshness window.
      if (!e.region.manual && now - e.expiredAt > this.restoreMaxAgeMs) {
        debug(TAG, `skip stale restore ${id} (off-screen ${Math.round((now - e.expiredAt) / 1000)}s > ${Math.round(this.restoreMaxAgeMs / 1000)}s)`);
        continue;
      }
      const region = e.region;
      // Manual regions are user-pinned and never analyzer-re-emitted, so they
      // can't be "confirmed" — restore them solid (the pending leash would
      // otherwise kill them in PENDING_CONFIRM_TICKS).
      region.pending = !region.manual;
      this.tracked.set(id, {
        region,
        lastSeenTick: this.tick,
        firstSeenTs: Date.now(),
        restoredAtTick: region.pending ? this.tick : undefined,
      });
      this.expired.delete(id);
      debug(TAG, `restored region ${id} on app re-entry (${curApp})${region.pending ? " [pending]" : ""}`);
    }
  }

  /**
   * Tier 1 entry point: the frontmost app changed. Archive eyes that belong
   * elsewhere and optimistically restore this app's archived eyes (pending).
   * Returns the new full set if it changed (caller broadcasts it), else null.
   * Call only on an actual focus change — restoring every tick would resurrect
   * just-expired eyes.
   */
  onAppFocus(appRaw: string | null | undefined): RegionHighlight[] | null {
    const before = this.stateKey();
    this.archiveForeign(appRaw);
    this.restorePending(appRaw);
    if (this.stateKey() === before) return null;
    const current = this.current();
    // Suppress broadcast when focus switches to an app with no regions
    // (was viewing another app's eyes). Prevents the overlay flashing a
    // "0 regions" highlight when the HUD should just describe the new app.
    if (current.length === 0) return null;
    log(TAG, `app focus → ${appRaw}: region set changed: ${current.length} active [${current.map(r => r.id).join(", ")}]`);
    return current;
  }

  /** Fast-path restore (additive only): re-show this app's archived eyes the
   *  instant a frontmost-app-change signal arrives from the overlay
   *  (NSWorkspace), ahead of the ~1.5s sense pipeline. Deliberately does NOT
   *  archiveForeign — the overlay's app name (localizedName) and sense's app
   *  name (process name) share a namespace only up to case, so a destructive
   *  archive on a mismatched name could wrongly clear live eyes. Archiving of
   *  the previous app's eyes stays on the sense path / per-tick archiveForeign,
   *  which use the consistent sense namespace. Returns the new set if changed. */
  restoreForApp(appRaw: string | null | undefined): RegionHighlight[] | null {
    const before = this.stateKey();
    this.restorePending(appRaw);
    if (this.stateKey() === before) return null;
    const current = this.current();
    log(TAG, `fast restore for ${appRaw}: ${current.length} active [${current.map(r => r.id).join(", ")}]`);
    return current;
  }

  /** Flip all live auto-detected eyes to pending ("rechecking" — the overlay
   *  dims them) after a large viewport change (scroll / in-app navigation), so
   *  eyes anchored to the old layout stop pointing at content that scrolled
   *  away. The urgent re-analysis that follows re-confirms + re-anchors the
   *  still-present ones (the pending-confirm path updates their bbox to the new
   *  position) and the pending leash drops the rest within PENDING_CONFIRM_TICKS.
   *  Manual (user-pinned) and already-pending eyes are left untouched. Returns
   *  the changed set to broadcast, or null if nothing flipped. */
  markStaleForRecheck(): RegionHighlight[] | null {
    const before = this.stateKey();
    for (const t of this.tracked.values()) {
      if (t.region.manual || t.region.pending) continue;
      t.region.pending = true;
      t.restoredAtTick = this.tick;
    }
    if (this.stateKey() === before) return null;
    const current = this.current();
    log(TAG, `recheck after viewport change: ${current.length} eyes pending re-confirm`);
    return current;
  }

  /**
   * A1 + A2 — local re-anchoring (no LLM). Runs per sense frame, between
   * analyzer ticks, so eyes track their content at capture rate:
   *  - A1: re-locate each live eye's issue text on the fresh frame and slide
   *    the eye to its new position (scroll / typing / window resize). A local
   *    match also counts as a re-confirmation — keeps the eye alive and un-dims
   *    it — so an eye whose content is visibly still present never expires just
   *    because the LLM's attention rotated away.
   *  - A2: when an eye's text is absent for LOCAL_MISS_LIMIT consecutive frames,
   *    dim it ("rechecking") immediately — its content scrolled off — instead of
   *    waiting out the analyzer miss window. Dim-only: the analyzer re-confirms
   *    (clearing pending) if it's still relevant, else the pending leash archives
   *    it. So a false miss self-corrects within a tick.
   * Manual (user-pinned) and foreign-app eyes are left untouched. Returns the
   * changed set to broadcast, or null.
   */
  reanchorLive(frame: ScreenEvent): RegionHighlight[] | null {
    if (!frame.ocrLines?.length) return null; // need line boxes to re-anchor
    const frameApp = (frame.meta.app || "").toLowerCase().trim();
    if (!frameApp) return null;
    const frameSize = frame.frameSize && frame.frameSize.length === 2
      ? frame.frameSize as [number, number]
      : undefined;

    let changed = false;
    for (const t of this.tracked.values()) {
      if (t.region.manual) continue; // user-pinned — never moved automatically
      const regionApp = (t.region.app || "").toLowerCase().trim();
      if (regionApp && regionApp !== frameApp) continue; // foreign — archiveForeign owns it

      // Track the verbatim anchored line first (robust to the issue being a
      // paraphrase that no longer token-matches); fall back to issue tokens,
      // refreshing anchorText when that path finds the line.
      let newBbox = t.region.anchorText
        ? findLineByText(t.region.anchorText, frame)
        : undefined;
      if (!newBbox) {
        const line = refineToLine(t.region.issue, frame);
        if (line) { newBbox = line.bbox; t.region.anchorText = line.text; }
      }
      if (newBbox) {
        t.localMisses = 0;
        // A1: slide to the content's current position (above jitter threshold).
        if (!t.region.bbox || bboxShift(t.region.bbox, newBbox) > RegionTracker.BBOX_MOVE_EPSILON) {
          t.region.bbox = newBbox;
          if (frameSize) t.region.frameSize = frameSize;
          changed = true;
        }
        // Local presence = re-confirmation: keep alive + un-dim.
        t.lastSeenTick = this.tick;
        if (t.region.pending) {
          t.region.pending = false;
          t.restoredAtTick = undefined;
          changed = true;
        }
      } else {
        // A2: content not on this frame — dim after a short miss streak.
        t.localMisses = (t.localMisses ?? 0) + 1;
        if (t.localMisses >= RegionTracker.LOCAL_MISS_LIMIT && !t.region.pending) {
          t.region.pending = true;
          t.restoredAtTick = this.tick; // hand off to the pending leash
          changed = true;
        }
      }
    }
    if (!changed) return null;
    const current = this.current();
    debug(TAG, `local re-anchor (app=${frameApp}): ${current.length} active`);
    return current;
  }

  /** Current region set (insertion order). */
  current(): RegionHighlight[] {
    return [...this.tracked.values()].map(t => t.region);
  }

  /** Look up a region for spawn-time context assembly. Live regions first,
   *  then the context archive — anything the user could see or click stays
   *  resolvable; eyes leaving the screen never invalidates their context. */
  /** Admit a user-selected region: bypasses the analyzer's admission cap
   *  and scoring — explicit user intent. Returns the created region. */
  addManual(input: {
    bbox: [number, number, number, number];
    frameSize: [number, number];
    app?: string;
    ocr: string;
    ocrLines?: { text: string; bbox: [number, number, number, number] }[];
  }): RegionHighlight {
    const id = `r-man-${Date.now().toString(36)}`;
    const firstLine = input.ocr.split("\n").map((l) => l.trim()).find((l) => l.length > 2);
    const region: RegionHighlight = {
      id,
      issue: firstLine ? `Selected: ${firstLine.slice(0, 56)}` : "Selected screen region",
      tip: "The user selected this region themselves — engage with its content and ask what they need if unclear.",
      bbox: input.bbox,
      frameSize: input.frameSize,
      sourceOcr: input.ocr.slice(0, 4000),
      ...(input.app ? { app: input.app } : {}),
      manual: true,
    };
    this.tracked.set(id, { region, lastSeenTick: this.tick, firstSeenTs: Date.now() });
    log(TAG, `manual region ${id} admitted (${input.ocr.length} OCR chars, app=${input.app ?? "?"})`);
    return region;
  }

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

  /** Cheap change-detection key: ids + tips + pending flag (tips refresh in
   *  place; the pending→confirmed flip must re-broadcast so the overlay
   *  un-dims a restored eye). */
  private stateKey(): string {
    return [...this.tracked.entries()]
      .map(([id, t]) => `${id}:${t.region.tip}:${t.region.pending ? "p" : ""}`)
      .join("|");
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
  const parts = region.manual
    ? [
        `[Region — user-selected] ${region.issue}`,
        `The user pointed at this screen area to get your help with whatever they're doing here — treat it as context, not as something to describe back.`,
      ]
    : [
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
    `\nYou have sinain MCP tools for deeper context: sinain_memory_query ` +
    `(long-term facts about entities/topics), sinain_context (current ` +
    `screen/audio + situation summary). Query them when ` +
    `the seed above isn't enough.`,
  );
  parts.push(
    `\nYou're a hands-on assistant, not a screen-reader. Use the above as context ` +
    `and HELP with what the user is actually doing — answer their question, ` +
    `diagnose the problem, write the fix, suggest the next step. If their goal ` +
    `isn't clear from the context, ask one short question. Don't narrate or ` +
    `summarize the screen — they can already see it.`,
  );
  return parts.join("\n");
}
