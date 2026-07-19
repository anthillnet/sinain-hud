/**
 * Episode tracker — the save-offer's breakpoint source (DESIGN-SAVE-OFFER §2).
 *
 * Follows ONE attended thread at a time, keyed by structural project identity
 * (thread-identity.ts: editors → repo, chat apps → conversation, browsers →
 * site/page, else app). An episode is continuous dwell on that thread; it ends
 * — a breakpoint — on:
 *
 *   - a SUSTAINED SWITCH: the user moves to a different thread and stays (a
 *     30 s glance at Slack never splits an episode; bouncing back clears the
 *     pending switch), or
 *   - an IDLE GAP: activity stops. The breakpoint is emitted on the next
 *     event — i.e. when the user is back at the screen to see the offer;
 *     the card's recency line says "ended N min ago" honestly.
 *
 * Deliberately tiny and deterministic: no models, no LLM, no persistence.
 * Whether the episode is worth offering (long ∧ loud, caps, privacy floor)
 * is the OfferManager's job — this only draws the episode boundary.
 */

import { basename } from "node:path";
import { deriveProject } from "./thread-identity.js";

const MINUTE = 60_000;

export interface EpisodeBreakpoint {
  /** Stable thread key (proj:/chat:/web:/app:) — exclusion memory joins on it. */
  threadId: string;
  /** Human thread label — the card's "mostly: …" context line. */
  label: string;
  /** When the episode ended. */
  at: number;
  /** Engaged span start→end. */
  engagedMs: number;
}

/** A live episode that just crossed the engagement threshold — the
 *  mid-episode signal Session Sense nudges on (same detection the save
 *  offer uses, fired while the user is still in it). */
export interface EpisodeQualified {
  threadId: string;
  label: string;
  /** Episode start — the retroactive-credit anchor. */
  startTs: number;
  engagedMs: number;
  at: number;
}

/** The cwd identity shared by agent attachment and the Session Sense
 * candidate detector. Keeping this here makes a pre-track lane land on the
 * same thread that noteAgentLaunch seeds. */
export function deriveAgentLaunchCandidate(cwd: string): { threadId: string; label: string } | null {
  const label = basename(cwd);
  return label ? { threadId: `proj:${label.toLowerCase()}`, label } : null;
}

export class EpisodeTracker {
  private readonly idleGapMs =
    (Number(process.env.SAVE_OFFER_IDLE_GAP_MINUTES) || 5) * MINUTE;
  private readonly shiftMs =
    (Number(process.env.SAVE_OFFER_SHIFT_MINUTES) || 2) * MINUTE;

  private activeKey = "";
  private activeLabel = "";
  private startTs = 0;
  private lastTs = 0;
  /** A candidate departure: a different thread seen since `sinceTs`. */
  private pending: { key: string; label: string; sinceTs: number } | null = null;

  /** Mid-episode hook: fired ONCE per episode when engaged dwell crosses
   *  `qualifyMs`. 0 disables. */
  private qualified: ((ep: EpisodeQualified) => void) | null = null;
  private qualifyMs = 0;
  private qualifiedFired = false;

  constructor(private emit: (bp: EpisodeBreakpoint) => void) {}

  setQualifiedHook(qualifyMs: number, fn: (ep: EpisodeQualified) => void): void {
    this.qualifyMs = qualifyMs;
    this.qualified = fn;
  }

  /** Feed one sense event. Cheap — a title parse and a couple of compares. */
  observe(app: string | undefined, windowTitle: string | undefined, ts: number): void {
    if (!app || app === "unknown") return;
    const { key, label } = deriveProject(app, windowTitle ?? "");
    this.observeThread(key, label, ts);
  }

  /** Feed one cwd-derived agent-launch signal through the same candidate
   *  detector as attended screen events. One launch can seed an episode or a
   *  pending switch, but cannot by itself qualify either one. */
  noteAgentLaunch(cwd: string, ts = Date.now()): void {
    const candidate = deriveAgentLaunchCandidate(cwd);
    if (!candidate) return;
    this.observeThread(candidate.threadId, candidate.label, ts);
  }

  private observeThread(key: string, label: string, ts: number): void {
    if (this.startTs === 0) {
      this.start(key, label, ts);
      return;
    }

    // Idle gap: the episode ended back at lastTs; the user just returned.
    if (ts - this.lastTs >= this.idleGapMs) {
      this.close(this.lastTs);
      this.start(key, label, ts);
      return;
    }

    if (key === this.activeKey) {
      this.pending = null; // bounce-back: the glance didn't end the episode
      this.lastTs = ts;
      // Mid-episode qualification: the same "long, engaged" signal the save
      // offer waits for at the breakpoint, surfaced while the user is in it.
      if (!this.qualifiedFired && this.qualified && this.qualifyMs > 0 &&
          ts - this.startTs >= this.qualifyMs) {
        this.qualifiedFired = true;
        this.qualified({
          threadId: this.activeKey,
          label: this.activeLabel,
          startTs: this.startTs,
          engagedMs: ts - this.startTs,
          at: ts,
        });
      }
      return;
    }

    if (!this.pending || this.pending.key !== key) {
      this.pending = { key, label, sinceTs: ts };
    } else if (ts - this.pending.sinceTs >= this.shiftMs) {
      // Sustained switch: the outgoing episode ended at its last activity.
      const next = this.pending;
      this.close(this.lastTs);
      this.start(next.key, next.label, next.sinceTs);
      this.lastTs = ts;
    }
    // While a switch is pending, the outgoing episode's span does not grow —
    // lastTs stays at the last attended activity, so engagedMs is honest.
  }

  private start(key: string, label: string, ts: number): void {
    this.activeKey = key;
    this.activeLabel = label;
    this.startTs = ts;
    this.lastTs = ts;
    this.pending = null;
    this.qualifiedFired = false;
  }

  private close(endTs: number): void {
    const engagedMs = endTs - this.startTs;
    if (engagedMs <= 0 || !this.activeKey) return;
    this.emit({
      threadId: this.activeKey,
      label: this.activeLabel,
      at: endTs,
      engagedMs,
    });
  }
}
