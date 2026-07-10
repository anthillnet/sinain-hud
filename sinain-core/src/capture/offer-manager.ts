import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FeedBuffer } from "../buffers/feed-buffer.js";
import type { SenseBuffer } from "../buffers/sense-buffer.js";
import type { SaveOfferConfig, SaveOfferMessage, SaveOfferResponse } from "../types.js";
import type { SaveManager } from "./save-manager.js";
import { describeCoverage, listWindowSources } from "./window-ops.js";
import { log, warn } from "../log.js";

const TAG = "save-offer";

// An app must carry a real share of the episode to be proposed; minor
// bystanders (a 2-min Slack glance in a 47-min block) stay unticked and
// visible only in the Adjust chooser. Design: propose ≥25% of range or ≥10min.
const PROPOSE_MIN_FRACTION = 0.25;
const PROPOSE_MIN_MINUTES = 10;
// "Loud": the top app must have been active for at least half the range's
// minute-buckets — a mostly-idle dwell never offers.
const LOUD_MIN_TOP_FRACTION = 0.5;
// Explicit ✕-dismissals that silence offers for the rest of the day.
const DAY_OFF_AFTER_DISMISSALS = 2;
// Chooser slider ceiling — offers never propose past what Adjust can express.
const MAX_OFFER_MINUTES = 120;

interface PersistedState {
  day: string; // YYYY-MM-DD of the counters
  offersToday: number;
  lastOfferTs: number;
  consecutiveDismissals: number;
  offeredEpisodes: string[]; // `${threadId}@${breakpointTs}` — offered at most once
  /** Privacy floor: apps the user has EVER excluded for a thread (learned
   *  from Adjust corrections) are never proposed for it again. */
  exclusions: Record<string, string[]>;
}

interface PendingOffer {
  msg: SaveOfferMessage;
  labelId: string;
}

/**
 * Breakpoint save offers (DESIGN-SAVE-OFFER.md, autosave ladder rung 1):
 * on a long, loud episode's breakpoint, compose "Save these N min? (apps)"
 * from data the window already holds — zero LLM — and broadcast it. The
 * overlay renders chip-first; every response comes back through respond()
 * and is appended to capture-labels.jsonl (the corpus that gates autosave).
 */
export class OfferManager {
  private state: PersistedState;
  private pending = new Map<string, PendingOffer>();

  constructor(
    private feedBuffer: FeedBuffer,
    private senseBuffer: SenseBuffer,
    private saveManager: SaveManager,
    private broadcast: (msg: SaveOfferMessage) => void,
    private memoryDir: string,
    private cfg: SaveOfferConfig,
  ) {
    this.state = this.loadState();
    log(TAG, cfg.enabled
      ? `armed: ≥${cfg.minMinutes}m episodes · ≤${cfg.maxPerDay}/day · ${cfg.cooldownMinutes}m cooldown · ${cfg.expirySeconds}s expiry`
      : "disabled (SAVE_OFFER_ENABLED=false)");
  }

  private get statePath(): string { return join(this.memoryDir, "save-offer-state.json"); }
  private get labelsPath(): string { return join(this.memoryDir, "capture-labels.jsonl"); }

  private loadState(): PersistedState {
    const empty: PersistedState = {
      day: today(), offersToday: 0, lastOfferTs: 0,
      consecutiveDismissals: 0, offeredEpisodes: [], exclusions: {},
    };
    try {
      if (!existsSync(this.statePath)) return empty;
      const raw = JSON.parse(readFileSync(this.statePath, "utf-8"));
      return { ...empty, ...raw };
    } catch (err) {
      warn(TAG, `state unreadable, starting fresh: ${String(err).slice(0, 120)}`);
      return empty;
    }
  }

  private saveState(): void {
    try {
      const tmp = `${this.statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: "utf-8", mode: 0o600 });
      renameSync(tmp, this.statePath); // atomic — crash mid-write never corrupts
    } catch (err) {
      warn(TAG, `state persist failed: ${String(err).slice(0, 120)}`);
    }
  }

  /** Roll the day counters when the calendar day changes. */
  private rollDay(): void {
    const d = today();
    if (this.state.day !== d) {
      this.state.day = d;
      this.state.offersToday = 0;
      this.state.consecutiveDismissals = 0;
    }
  }

  /** Episode-tracker breakpoint hook: decide skip-or-offer. Free — no LLM, no I/O beyond
   *  the ring buffers; every skip path returns before composing anything. */
  onBreakpoint(ev: { threadId: string; label: string; at: number; engagedMs: number }): void {
    if (!this.cfg.enabled) return;
    this.rollDay();

    // Skips log their reason — episode boundaries are rare (a few per hour),
    // and a silent gate is undiagnosable in the field.
    const skip = (why: string): void =>
      log(TAG, `${ev.threadId}: episode ended (${Math.round(ev.engagedMs / 60_000)}m) — no offer: ${why}`);

    const minutes = Math.min(Math.round(ev.engagedMs / 60_000), MAX_OFFER_MINUTES);
    if (minutes < this.cfg.minMinutes) return skip(`short (< ${this.cfg.minMinutes}m)`);

    // Guardrails: ≤N/day · cooldown · 2 dismissals end the day · once per episode.
    if (this.state.offersToday >= this.cfg.maxPerDay) return skip(`day cap (${this.cfg.maxPerDay})`);
    if (this.state.consecutiveDismissals >= DAY_OFF_AFTER_DISMISSALS) return skip("2 dismissals — offers off for the day");
    if (Date.now() - this.state.lastOfferTs < this.cfg.cooldownMinutes * 60_000) return skip(`cooldown (${this.cfg.cooldownMinutes}m)`);
    const episodeKey = `${ev.threadId}@${ev.at}`;
    if (this.state.offeredEpisodes.includes(episodeKey)) return skip("already offered");

    // Scope: apps with a real share of the episode, minus learned exclusions.
    // Never "mic" (privacy floor — voice is opt-in through Adjust only).
    const sources = listWindowSources(this.feedBuffer, this.senseBuffer, minutes)
      .filter((s) => s.kind === "app");
    const excluded = this.state.exclusions[ev.threadId] ?? [];
    const proposed = sources.filter((s) =>
      !excluded.includes(s.name) &&
      (s.minutes >= PROPOSE_MIN_MINUTES || s.minutes >= minutes * PROPOSE_MIN_FRACTION));
    if (proposed.length === 0) return skip("no proposable sources");

    // "Loud": a mostly-idle dwell never offers. Measured over the proposed
    // scope COMBINED — an episode is a family of apps, so demanding one app
    // hold half the range mis-skips genuinely busy multi-app work (and sense
    // events are change-gated: reading time yields few event-minutes).
    const activeMinutes = proposed.reduce((sum, s) => sum + s.minutes, 0);
    if (activeMinutes < minutes * LOUD_MIN_TOP_FRACTION) return skip(`quiet (${activeMinutes} active min of ${minutes}m)`);

    // Honest idle tail: trailing minutes with no scoped activity get named
    // on the card ("47 min · 12 min idle at the end"), never hidden.
    const idleTail = this.idleTailMinutes(minutes, proposed.map((s) => s.name), ev.at);

    const apps = proposed.map((s) => s.name);
    const offerId = `offer-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const msg: SaveOfferMessage = {
      type: "save_offer",
      offerId,
      minutes,
      apps,
      coverage: describeCoverage(this.feedBuffer, this.senseBuffer, minutes, { apps }),
      threadId: ev.threadId,
      threadLabel: ev.label || undefined,
      idleTailMinutes: idleTail >= 10 ? idleTail : undefined,
      endedTs: ev.at,
      expirySeconds: this.cfg.expirySeconds,
      ts: Date.now(),
    };

    this.state.offersToday++;
    this.state.lastOfferTs = Date.now();
    this.state.offeredEpisodes.push(episodeKey);
    if (this.state.offeredEpisodes.length > 50) this.state.offeredEpisodes.shift();
    this.saveState();

    const labelId = `cap-${offerId}`;
    this.appendLabel({
      id: labelId,
      ts: Date.now(),
      stage: 1, // ladder rung 1: offers
      threadId: ev.threadId,
      episode: { startTs: ev.at - ev.engagedMs, endTs: ev.at, breakpointTs: ev.at },
      proposal: {
        rangeMinutes: minutes,
        scope: { apps },
        drivers: [
          `engaged_${minutes}m`,
          `active_${activeMinutes}m`,
          ...(idleTail >= 10 ? [`idle_tail_${idleTail}m`] : []),
        ],
      },
      decision: "offered",
    });
    this.pending.set(offerId, { msg, labelId });
    // Server-side pending TTL: well past client expiry so a slow response
    // still lands, but abandoned offers don't accumulate.
    setTimeout(() => this.pending.delete(offerId), (this.cfg.expirySeconds + 300) * 1000).unref?.();

    log(TAG, `${offerId}: offering ${minutes} min (${apps.join(", ")}) for "${ev.label}" — ${this.state.offersToday}/${this.cfg.maxPerDay} today`);
    this.broadcast(msg);
  }

  /** Overlay response. accepted/adjusted run the normal save lifecycle with
   *  offered_save provenance; every response becomes a label. */
  respond(offerId: string, response: SaveOfferResponse, minutes?: number, apps?: string[]):
      { ok: boolean; saveId?: string; error?: string } {
    const offer = this.pending.get(offerId);
    if (!offer) return { ok: false, error: "unknown or expired offer" };
    this.pending.delete(offerId);
    this.rollDay();

    let saveId: string | undefined;
    switch (response) {
      case "accepted":
        saveId = this.saveManager.save(offer.msg.minutes, { apps: offer.msg.apps }, "offered_save");
        this.state.consecutiveDismissals = 0;
        break;
      case "adjusted": {
        const m = clamp(minutes ?? offer.msg.minutes, 5, MAX_OFFER_MINUTES);
        const chosen = apps && apps.length > 0 ? apps : offer.msg.apps;
        saveId = this.saveManager.save(m, { apps: chosen }, "offered_save");
        this.state.consecutiveDismissals = 0;
        // Unticked proposed apps are corrections — and the privacy floor:
        // once excluded for this thread, never proposed for it again.
        const dropped = offer.msg.apps.filter((a) => !chosen.includes(a));
        if (dropped.length > 0) {
          const prev = this.state.exclusions[offer.msg.threadId] ?? [];
          this.state.exclusions[offer.msg.threadId] = [...new Set([...prev, ...dropped])];
          log(TAG, `${offerId}: learned exclusions for ${offer.msg.threadId}: ${dropped.join(", ")}`);
        }
        break;
      }
      case "dismissed":
        this.state.consecutiveDismissals++;
        break;
      case "expired":
        break; // weak negative — never counts toward the day-off threshold
    }
    this.saveState();

    this.appendLabel({
      id: offer.labelId,
      ts: Date.now(),
      event: "response",
      response,
      ...(response === "adjusted" ? {
        editedRange: minutes ?? null,
        editedScope: apps ?? null,
      } : {}),
      ...(saveId ? { saveId } : {}),
    });
    log(TAG, `${offerId}: ${response}${saveId ? ` → ${saveId}` : ""}`);
    return { ok: true, saveId };
  }

  /** Trailing minutes of the range with no activity from the scoped apps. */
  private idleTailMinutes(minutes: number, apps: string[], endTs: number): number {
    const since = endTs - minutes * 60_000;
    let lastTs = since;
    for (const ev of this.senseBuffer.queryByTime(since)) {
      if (ev.ts > endTs) continue;
      const app = ev.semantic?.context?.app || ev.meta.app || "";
      if (apps.includes(app) && ev.ts > lastTs) lastTs = ev.ts;
    }
    return Math.floor((endTs - lastTs) / 60_000);
  }

  /** One JSONL record per event; offer + response records share `id`
   *  (joined by consumers). */
  private appendLabel(record: Record<string, unknown>): void {
    try {
      appendFileSync(this.labelsPath, JSON.stringify(record) + "\n", { encoding: "utf-8", mode: 0o600 });
    } catch (err) {
      warn(TAG, `label append failed: ${String(err).slice(0, 120)}`);
    }
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
