/**
 * Episode tracker — the save-offer's breakpoint source (DESIGN-SAVE-OFFER §2).
 *
 * Watches the stream of sense events (app + ts, already flowing) and detects
 * when a work episode ENDS, so the OfferManager can propose saving it. An
 * episode is a run of activity across a small family of apps; it ends on:
 *
 *   - a CONTEXT SHIFT: the user moves to an app outside the episode's family
 *     and stays there (a 30s Slack glance never ends an episode — the shift
 *     must sustain), or
 *   - an IDLE GAP: activity stops. The breakpoint is emitted on the next
 *     event — i.e. when the user is back at the screen to see the offer;
 *     the card's recency line says "ended N min ago" honestly.
 *
 * Deliberately tiny and deterministic: no models, no LLM, no persistence.
 * Whether the episode is worth offering (long ∧ loud, caps, privacy floor)
 * is the OfferManager's job — this only draws the episode boundary.
 */

const MINUTE = 60_000;

export interface EpisodeBreakpoint {
  /** Stable id for exclusion memory — the episode's dominant app. */
  threadId: string;
  /** Context line for the card; empty = omitted (no confident label here). */
  label: string;
  /** When the episode ended. */
  at: number;
  /** Engaged span start→end. */
  engagedMs: number;
}

export class EpisodeTracker {
  // A new app "joins the family" while the episode is young or once it has
  // carried a real share of it; below that it's a bystander whose sustained
  // presence means the user actually left.
  private static readonly YOUNG_MS = 5 * MINUTE;
  private static readonly JOIN_FRACTION = 0.15;

  private readonly idleGapMs =
    (Number(process.env.SAVE_OFFER_IDLE_GAP_MINUTES) || 5) * MINUTE;
  private readonly shiftMs =
    (Number(process.env.SAVE_OFFER_SHIFT_MINUTES) || 2) * MINUTE;

  private startTs = 0;
  private lastTs = 0;
  /** Distinct minute-buckets each app was active in this episode. */
  private appBuckets = new Map<string, Set<number>>();
  /** A candidate departure: outside-family app seen since `sinceTs`. */
  private pendingShift: { app: string; sinceTs: number } | null = null;

  constructor(private emit: (bp: EpisodeBreakpoint) => void) {}

  /** Feed one sense event. Cheap — a map update and a couple of compares. */
  observe(app: string | undefined, ts: number): void {
    if (!app || app === "unknown") return;

    if (this.startTs === 0) {
      this.start(app, ts);
      return;
    }

    // Idle gap: the episode ended back at lastTs; the user just returned.
    if (ts - this.lastTs >= this.idleGapMs) {
      this.close(this.lastTs);
      this.start(app, ts);
      return;
    }

    if (this.inFamily(app, ts)) {
      this.pendingShift = null;
      this.bucket(app, ts);
      this.lastTs = ts;
      return;
    }

    // Outside-family app: NEVER bucketed into this episode (otherwise a
    // sustained departure would accrue share and sneak into the family
    // before the sustain elapses). engagedMs likewise excludes its dwell —
    // the episode's span ends at the last family activity.
    if (!this.pendingShift || this.pendingShift.app !== app) {
      this.pendingShift = { app, sinceTs: ts };
    } else if (ts - this.pendingShift.sinceTs >= this.shiftMs) {
      // Sustained departure: the episode ended when the shift began.
      const shift = this.pendingShift;
      this.close(this.lastTs);
      this.start(shift.app, shift.sinceTs);
      this.bucket(app, ts);
      this.lastTs = ts;
    }
  }

  private inFamily(app: string, now: number): boolean {
    if (this.appBuckets.has(app)) {
      if (now - this.startTs <= EpisodeTracker.YOUNG_MS) return true;
      const share = (this.appBuckets.get(app)?.size ?? 0) /
        Math.max(1, (this.lastTs - this.startTs) / MINUTE);
      return share >= EpisodeTracker.JOIN_FRACTION;
    }
    // Brand-new app: joins freely only while the episode is young.
    return now - this.startTs <= EpisodeTracker.YOUNG_MS;
  }

  private bucket(app: string, ts: number): void {
    let b = this.appBuckets.get(app);
    if (!b) this.appBuckets.set(app, (b = new Set()));
    b.add(Math.floor(ts / MINUTE));
  }

  private start(app: string, ts: number): void {
    this.startTs = ts;
    this.lastTs = ts;
    this.appBuckets = new Map();
    this.pendingShift = null;
    this.bucket(app, ts);
  }

  private close(endTs: number): void {
    const engagedMs = endTs - this.startTs;
    if (engagedMs <= 0) return;
    let dominant = "";
    let best = 0;
    for (const [app, buckets] of this.appBuckets) {
      if (buckets.size > best) { best = buckets.size; dominant = app; }
    }
    if (!dominant) return;
    this.emit({
      threadId: `app:${dominant}`,
      label: "", // no confident thread label at this layer — card omits the line
      at: endTs,
      engagedMs,
    });
  }
}
