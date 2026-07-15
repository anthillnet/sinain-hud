import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EmbeddingService } from "../embedding/service.js";
import type {
  SenseEvent,
  SessionAction,
  SessionChipMessage,
  SessionNudgeGrade,
  SessionNudgeMessage,
  SessionNudgeResponse,
  SessionSenseConfig,
  SessionWrapMessage,
} from "../types.js";
import type { OfferManager } from "./offer-manager.js";
import type { SaveManager } from "./save-manager.js";
import { deriveProject } from "./thread-identity.js";
import { log, warn } from "../log.js";

const TAG = "session-sense";

// ── Stock workflow prototypes (DESIGN-SESSION-SENSE §5) ─────────────────────
//
// The day-one classifier: a small curated library of canonical workflow
// descriptions, embedded once at startup (local MiniLM, no LLM). Matching is
// embeddings-only; deterministic cues may BOOST a candidate later, never
// create one (the WSM domain-blind rule).
//
// `floor` is the category floor (§7): "unlabeled" workflows render the card
// without the label at ANY confidence (the classifier knows, the card doesn't
// say); "silent" workflows never nudge at all. The floor is a static category
// flag, not a runtime content filter.

type CategoryFloor = "none" | "unlabeled" | "silent";

interface StockPrototype {
  id: string;
  /** The nudge's claim: "Looks like: <label>". */
  label: string;
  floor: CategoryFloor;
  /** Canonical descriptions — embedded and averaged into one centroid. */
  texts: string[];
}

const STOCK_PROTOTYPES: StockPrototype[] = [
  {
    id: "job-application", label: "applying for a job", floor: "none",
    texts: [
      "applying for a job: tailoring a CV and resume to a job posting, writing a cover letter, filling an application form",
      "job search: role requirements, recruiter emails, interview scheduling, portfolio and LinkedIn profile updates",
    ],
  },
  {
    id: "travel-booking", label: "booking travel", floor: "none",
    texts: [
      "booking travel: comparing flights and hotels, picking dates, seats and baggage, checkout and booking confirmation",
      "trip planning: itinerary, destination research, airport transfers, travel insurance, boarding passes",
    ],
  },
  {
    id: "purchase-research", label: "researching a purchase", floor: "none",
    texts: [
      "researching a purchase: comparing products, reading reviews, prices and specs side by side, shopping cart",
      "buying decision: model comparison tables, discount codes, warranty terms, delivery options, checkout",
    ],
  },
  {
    id: "apartment-hunt", label: "apartment hunting", floor: "none",
    texts: [
      "apartment hunting: browsing listings, rent prices, floor plans, neighborhoods, scheduling viewings",
      "housing search: lease terms, deposits, commute times, real-estate portals, contacting landlords",
    ],
  },
  {
    id: "incident-debugging", label: "debugging an incident", floor: "none",
    texts: [
      "debugging an incident: error logs, stack traces, alerts and dashboards, reproducing a failure, rollback",
      "production issue: monitoring graphs, exception messages, failing tests, git blame, hotfix and postmortem",
    ],
  },
  {
    id: "meeting-prep", label: "preparing a meeting", floor: "none",
    texts: [
      "preparing for a meeting: writing an agenda, slides and talking points, reviewing attendees and notes",
      "presentation prep: quarterly review deck, status update, rehearsing key messages, action items",
    ],
  },
  // Personal finance — the label is withheld at any confidence (§7).
  {
    id: "tax-admin", label: "tax & admin paperwork", floor: "unlabeled",
    texts: [
      "tax and admin paperwork: tax return forms, invoices, receipts, bank statements, expense reports",
      "personal finance admin: filing documents, insurance claims, government portals, ID verification",
    ],
  },
  {
    id: "budget-planning", label: "budget planning", floor: "unlabeled",
    texts: [
      "budget planning: a spreadsheet of income and expenses, savings goals, recurring costs, categories",
      "financial planning: monthly budget review, account balances, investments, debt payments",
    ],
  },
  // Medical and dating — no card at all, at any confidence (§7).
  {
    id: "medical", label: "medical research", floor: "silent",
    texts: [
      "medical research: symptoms, diagnosis, treatment options, medication side effects, doctor appointments",
      "health concern: lab results, specialist referral, patient portal, therapy, medical conditions",
    ],
  },
  {
    id: "dating", label: "dating", floor: "silent",
    texts: [
      "online dating: browsing profiles and matches, writing messages, planning a date",
      "dating app conversations, relationship advice, dating profile photos",
    ],
  },
];

// Classification needs real text under it — a near-empty frame never ticks.
const MIN_TICK_CHARS = 80;
// Recent-OCR window fed to the embedder per tick.
const MAX_TICK_CHARS = 1500;
// Housekeeping cadence (prompt gate, pause/end/grace checks).
const HOUSEKEEPING_MS = 5_000;
// The prompt gate's micro-breakpoint: the screen has been visually quiet this
// long (sense events are change-gated, so no events = nothing changing) while
// the user was active moments before. Stand-in for the Athium
// offer-at-breakpoint gate until the WSM lands on main.
const SETTLE_MIN_MS = 4_000;
const SETTLE_MAX_MS = 60_000;
// If no settle window shows up, prompt anyway after this long — a confirmed
// candidate must not silently rot because the screen never went quiet.
const SETTLE_FORCE_MS = 90_000;

interface Candidate {
  protoId: string;
  threadId: string;
  /** Retroactive credit start — pinned the moment the FIRST tick matched. */
  startTs: number;
  ticks: number;
  /** Best similarity seen (drives the label grade). */
  bestSim: number;
  confirmedAt: number | null;
  apps: Set<string>;
}

interface Session {
  id: string;
  threadId: string;
  protoId: string | null;
  /** Display label — "" when tracking unlabeled ("just work"). */
  label: string;
  grade: SessionNudgeGrade;
  startTs: number;
  /** Accumulated active ms, excluding pauses. */
  activeMs: number;
  /** When the current running stretch began (0 = paused). */
  runningSince: number;
  /** Last moment attention was on the session thread. */
  lastActiveTs: number;
  paused: boolean;
  apps: Set<string>;
  /** A wrap prompt is on screen since this ts (0 = none). */
  wrapPromptTs: number;
}

interface PersistedState {
  day: string;
  /** Once per thread per day (§7): threadId → last nudge ts. */
  nudgedThreads: Record<string, number>;
}

interface PendingNudge {
  msg: SessionNudgeMessage;
  labelId: string;
  protoId: string | null;
  apps: Set<string>;
}

/**
 * Session Sense (DESIGN-SESSION-SENSE.md, wireframes "Session Sense.dc.html"):
 * live workflow detection — the Watch's workout nudge for knowledge work.
 *
 *   idle → candidate (embedding match, dwell hysteresis, credit pinned)
 *        → prompted (micro-breakpoint, shared attention budget, category floor)
 *        → tracking (warmth pause/resume, chip) → ending (wrap prompt, grace)
 *        → summary (standard save lifecycle, provenance "session_sense").
 *
 * Detection and prompting are LLM-free by construction — in-process embeddings
 * plus deterministic features. The tap is the gesture; the distillation LLM
 * runs only after it (SaveManager.save → receipt → undo → commit).
 */
export class SessionSenseManager {
  private state: PersistedState;
  private pendingNudge: PendingNudge | null = null;
  private session: Session | null = null;
  private candidate: Candidate | null = null;

  /** Prototype centroids — embedded lazily once the model is ready. */
  private centroids: { proto: StockPrototype; vec: Float32Array }[] | null = null;
  private embeddingBusy = false;

  /** Rolling OCR of the attended thread (per-tick classifier input). */
  private recentText: { text: string; ts: number }[] = [];
  private activeThreadId = "";
  private activeThreadLabel = "";
  private lastTickTs = 0;
  private lastSenseTs = 0;
  /** Last tick's full ranking — the "Wrong?" picker's rows come from here. */
  private lastScores: { id: string; label: string; sim: number; floor: CategoryFloor }[] = [];
  /** Policy A (§7): nudges shown, so a rung-1 offer never re-asks the episode. */
  private askedEpisodes: { threadId: string; ts: number }[] = [];

  private housekeeping: ReturnType<typeof setInterval>;

  constructor(
    private embedding: EmbeddingService,
    private saveManager: SaveManager,
    /** Shared attention budget — offers and nudges are ONE allowance (§7). */
    private offers: OfferManager | null,
    private broadcast: (msg: SessionNudgeMessage | SessionChipMessage | SessionWrapMessage) => void,
    private memoryDir: string,
    private cfg: SessionSenseConfig,
  ) {
    this.state = this.loadState();
    this.housekeeping = setInterval(() => this.tick(), HOUSEKEEPING_MS);
    this.housekeeping.unref?.();
    log(TAG, cfg.enabled
      ? `armed: sim≥${cfg.similarityThreshold} · ${cfg.dwellTicks} ticks dwell · wrap after ${cfg.endQuietMinutes}m quiet + ${cfg.wrapGraceMinutes}m grace`
      : "disabled (SESSION_SENSE_ENABLED=false)");
  }

  stop(): void {
    clearInterval(this.housekeeping);
  }

  private get statePath(): string { return join(this.memoryDir, "session-sense-state.json"); }
  private get labelsPath(): string { return join(this.memoryDir, "capture-labels.jsonl"); }

  private loadState(): PersistedState {
    const empty: PersistedState = { day: today(), nudgedThreads: {} };
    try {
      if (!existsSync(this.statePath)) return empty;
      return { ...empty, ...JSON.parse(readFileSync(this.statePath, "utf-8")) };
    } catch (err) {
      warn(TAG, `state unreadable, starting fresh: ${String(err).slice(0, 120)}`);
      return empty;
    }
  }

  private saveState(): void {
    try {
      const tmp = `${this.statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: "utf-8", mode: 0o600 });
      renameSync(tmp, this.statePath);
    } catch (err) {
      warn(TAG, `state persist failed: ${String(err).slice(0, 120)}`);
    }
  }

  private rollDay(): void {
    const d = today();
    if (this.state.day !== d) {
      this.state.day = d;
      this.state.nudgedThreads = {};
    }
  }

  /** Policy A hook for the OfferManager: a nudge shown inside an episode's
   *  span consumed that episode's one ask — the rung-1 offer stays silent. */
  wasAskedDuring(threadId: string, startTs: number, endTs: number): boolean {
    return this.askedEpisodes.some(
      (a) => a.threadId === threadId && a.ts >= startTs && a.ts <= endTs + 60_000,
    );
  }

  // ── Sense intake ───────────────────────────────────────────────────────────

  /** Feed one sense event. Cheap on every call; the embedding classifier runs
   *  at most once per tickSeconds, and only once the model is ready. */
  observe(event: SenseEvent): void {
    if (!this.cfg.enabled) return;
    const app = event.meta.app;
    if (!app || app === "unknown") return;

    const ts = event.ts;
    this.lastSenseTs = ts;
    const { key, label } = deriveProject(app, event.meta.windowTitle ?? "");

    if (key !== this.activeThreadId) {
      this.activeThreadId = key;
      this.activeThreadLabel = label;
      this.recentText = []; // classifier input never mixes threads
      // A thread switch away from a still-unconfirmed candidate kills it.
      if (this.candidate && this.candidate.threadId !== key && !this.candidate.confirmedAt) {
        this.candidate = null;
      }
    }

    // Session warmth: attention back on the session thread resumes it.
    const s = this.session;
    if (s) {
      if (key === s.threadId) {
        s.lastActiveTs = ts;
        s.apps.add(app);
        if (s.paused) this.resumeSession(s);
        if (s.wrapPromptTs) this.keepGoing(s, "activity resumed");
      }
      return; // one session at a time — no new candidates while one exists
    }

    if (this.pendingNudge) return; // the ask is on screen — nothing to add

    if (event.ocr && event.ocr.trim().length > 0) {
      this.recentText.push({ text: event.ocr, ts });
      if (this.recentText.length > 12) this.recentText.shift();
    }
    this.candidate?.apps.add(app);

    // Classifier tick, rate-limited.
    if (ts - this.lastTickTs >= this.cfg.tickSeconds * 1000) {
      this.lastTickTs = ts;
      void this.classifyTick(ts, app);
    }
  }

  // ── Candidate detection (idle → candidate) ──────────────────────────────────

  private async ensureCentroids(): Promise<boolean> {
    if (this.centroids) return true;
    if (!this.embedding.ready || this.embeddingBusy) return false;
    this.embeddingBusy = true;
    try {
      const centroids: { proto: StockPrototype; vec: Float32Array }[] = [];
      for (const proto of STOCK_PROTOTYPES) {
        const vecs = await this.embedding.embed(proto.texts);
        centroids.push({ proto, vec: meanNormalized(vecs) });
      }
      this.centroids = centroids;
      log(TAG, `stock prototypes embedded: ${centroids.length}`);
      return true;
    } catch (err) {
      warn(TAG, `prototype embedding failed: ${String(err).slice(0, 120)}`);
      return false;
    } finally {
      this.embeddingBusy = false;
    }
  }

  private async classifyTick(ts: number, app: string): Promise<void> {
    if (!(await this.ensureCentroids()) || !this.centroids) return;

    const text = this.recentText.map((r) => r.text).join("\n").slice(-MAX_TICK_CHARS);
    if (text.length < MIN_TICK_CHARS) return;

    let vec: Float32Array;
    try {
      [vec] = await this.embedding.embed([text]);
    } catch {
      return; // model hiccup — the next tick retries
    }

    const scored = this.centroids
      .map((c) => ({ proto: c.proto, sim: EmbeddingService.cosine(vec, c.vec) }))
      .sort((a, b) => b.sim - a.sim);
    const best = scored[0];
    this.lastScores = scored.map((s) => ({
      id: s.proto.id, label: s.proto.label, sim: s.sim, floor: s.proto.floor,
    }));

    if (best.sim < this.cfg.similarityThreshold) {
      // Below the floor: a matching run is broken; a confirmed candidate
      // decays silently (most candidates are never prompted — §4).
      if (this.candidate && !this.candidate.confirmedAt) this.candidate = null;
      return;
    }

    const c = this.candidate;
    if (c && c.threadId === this.activeThreadId && c.protoId === best.proto.id) {
      c.ticks++;
      c.bestSim = Math.max(c.bestSim, best.sim);
      c.apps.add(app);
      if (!c.confirmedAt && c.ticks >= this.cfg.dwellTicks) {
        c.confirmedAt = ts;
        log(TAG, `candidate confirmed: ${best.proto.id} on ${c.threadId} (sim ${best.sim.toFixed(2)}, credited from ${new Date(c.startTs).toISOString()})`);
      }
    } else if (!c || !c.confirmedAt) {
      // New matching run — the credit is pinned HERE (§4): accepting later
      // credits everything from this moment.
      this.candidate = {
        protoId: best.proto.id,
        threadId: this.activeThreadId,
        startTs: this.recentText[0]?.ts ?? ts,
        ticks: 1,
        bestSim: best.sim,
        confirmedAt: null,
        apps: new Set([app]),
      };
    }
  }

  // ── Housekeeping: prompt gate, pause, wrap, grace ───────────────────────────

  private tick(): void {
    if (!this.cfg.enabled) return;
    const now = Date.now();

    // Prompted → expired is client-driven; everything else advances here.
    const c = this.candidate;
    if (c?.confirmedAt && !this.session && !this.pendingNudge) {
      // Micro-breakpoint stand-in for Athium offer-at-breakpoint: the screen
      // has settled (change-gated sense stream went quiet) but the user was
      // just here — or the settle never comes and we force after a while.
      const quiet = now - this.lastSenseTs;
      const sinceConfirm = now - c.confirmedAt;
      const settled = quiet >= SETTLE_MIN_MS && quiet <= SETTLE_MAX_MS;
      if (settled || sinceConfirm >= SETTLE_FORCE_MS) this.maybePrompt(c, now);
    }

    const s = this.session;
    if (!s) return;

    // Warmth decay: attention has been elsewhere → pause (auto-pause, §5).
    if (!s.paused && now - s.lastActiveTs >= this.cfg.pauseGraceSeconds * 1000) {
      this.pauseSession(s);
    }

    // Sustained quiet → the wrap prompt (§6), once.
    if (s.paused && !s.wrapPromptTs &&
        now - s.lastActiveTs >= this.cfg.endQuietMinutes * 60_000) {
      s.wrapPromptTs = now;
      const msg: SessionWrapMessage = {
        type: "session_wrap",
        sessionId: s.id,
        label: s.label || "session",
        activeMinutes: Math.round(this.activeMsOf(s, now) / 60_000),
        quietMinutes: Math.round((now - s.lastActiveTs) / 60_000),
        graceMinutes: this.cfg.wrapGraceMinutes,
        ts: now,
      };
      this.broadcast(msg);
      this.appendLabel({
        id: `ss-wrap-${s.id}`, ts: now, kind: "session_sense", event: "wrap_prompted",
        sessionId: s.id, threadId: s.threadId, quietMinutes: msg.quietMinutes,
      });
      log(TAG, `${s.id}: wrap prompt (quiet ${msg.quietMinutes}m, auto-wraps in ${this.cfg.wrapGraceMinutes}m)`);
    }

    // Grace expiry → auto-wrap: same receipt, zero taps (§10 "walk away").
    if (s.wrapPromptTs && now - s.wrapPromptTs >= this.cfg.wrapGraceMinutes * 60_000) {
      this.wrapSession(s, "auto_wrap");
    }
  }

  // ── Prompting (candidate → prompted) ────────────────────────────────────────

  private maybePrompt(c: Candidate, now: number): void {
    this.rollDay();
    const proto = STOCK_PROTOTYPES.find((p) => p.id === c.protoId);
    if (!proto) { this.candidate = null; return; }

    const skip = (why: string): void => {
      log(TAG, `${c.threadId}: candidate ${c.protoId} not prompted — ${why}`);
      this.candidate = null;
    };

    // Category floor (§7): medical/dating never nudge, at any confidence.
    if (proto.floor === "silent") return skip("category floor (silent)");
    // Once per thread per day (§7).
    if (this.state.nudgedThreads[c.threadId]) return skip("thread already nudged today");
    // One attention budget, shared with rung 1 (§7).
    const budget = this.offers?.budgetAllows() ?? { ok: true };
    if (!budget.ok) return skip(budget.why ?? "budget");

    // Confidence buys the label, never the card (§2): high similarity earns
    // the claim; medium drops it entirely — never hedged. Floored categories
    // are always unlabeled regardless of confidence.
    const high = c.bestSim >= this.cfg.similarityThreshold + this.cfg.labelMargin;
    const labeled = high && proto.floor === "none";
    const grade: SessionNudgeGrade = labeled ? "stock" : "unlabeled";

    // "Wrong?" rows: the classifier's own next candidates by similarity (§3).
    // Silent-floor prototypes never appear — self-labeling may reveal a
    // category, the card may not propose one.
    const alternates = labeled
      ? this.lastScores
          .filter((p) => p.id !== proto.id && p.floor !== "silent")
          .slice(0, 3)
          .map((p) => p.label)
      : [];

    const nudgeId = `nudge-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const msg: SessionNudgeMessage = {
      type: "session_nudge",
      nudgeId,
      grade,
      label: labeled ? proto.label : undefined,
      threadId: c.threadId,
      candidateStartTs: c.startTs,
      elapsedMinutes: Math.max(1, Math.round((now - c.startTs) / 60_000)),
      apps: [...c.apps],
      alternates,
      expirySeconds: this.cfg.expirySeconds,
      ts: now,
    };

    this.offers?.consumeAsk();
    this.state.nudgedThreads[c.threadId] = now;
    this.saveState();
    this.askedEpisodes.push({ threadId: c.threadId, ts: now });
    if (this.askedEpisodes.length > 50) this.askedEpisodes.shift();

    const labelId = `ss-${nudgeId}`;
    this.appendLabel({
      id: labelId, ts: now, kind: "session_sense", stage: 2,
      threadId: c.threadId, protoId: proto.id, grade,
      similarity: Number(c.bestSim.toFixed(3)),
      candidateStartTs: c.startTs, elapsedMinutes: msg.elapsedMinutes,
      decision: "nudged",
    });
    this.pendingNudge = { msg, labelId, protoId: proto.id, apps: c.apps };
    this.candidate = null;
    setTimeout(() => {
      // Server-side TTL well past client expiry — abandoned asks don't linger.
      if (this.pendingNudge?.msg.nudgeId === nudgeId) this.pendingNudge = null;
    }, (this.cfg.expirySeconds + 300) * 1000).unref?.();

    log(TAG, `${nudgeId}: nudging "${msg.label ?? "(unlabeled)"}" on ${c.threadId} — credited from ${new Date(c.startTs).toISOString()}`);
    this.broadcast(msg);
  }

  // ── Nudge responses (prompted → tracking | idle) ────────────────────────────

  /** Overlay response to a nudge. `corrected` carries the picked label
   *  ("" = just work). Every response is a training label (§3). */
  respond(nudgeId: string, response: SessionNudgeResponse, label?: string):
      { ok: boolean; sessionId?: string; error?: string } {
    const pending = this.pendingNudge;
    if (!pending || pending.msg.nudgeId !== nudgeId) {
      return { ok: false, error: "unknown or expired nudge" };
    }
    this.pendingNudge = null;

    let sessionId: string | undefined;
    switch (response) {
      case "tracked":
        sessionId = this.startSession(pending, pending.msg.label ?? "", pending.msg.grade);
        this.offers?.noteAccepted();
        break;
      case "corrected": {
        const picked = (label ?? "").trim();
        sessionId = this.startSession(pending, picked, picked ? "stock" : "unlabeled");
        this.offers?.noteAccepted();
        break;
      }
      case "dismissed":
        this.offers?.noteDismissal();
        break;
      case "expired":
        break; // weak negative — counted lighter than ✕ (§3)
    }

    this.appendLabel({
      id: pending.labelId, ts: Date.now(), kind: "session_sense", event: "response",
      response,
      ...(response === "corrected" ? { correctedLabel: label ?? "" } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
    log(TAG, `${nudgeId}: ${response}${sessionId ? ` → ${sessionId}` : ""}`);
    return { ok: true, sessionId };
  }

  private startSession(pending: PendingNudge, label: string, grade: SessionNudgeGrade): string {
    const now = Date.now();
    const id = `sess-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    this.session = {
      id,
      threadId: pending.msg.threadId,
      protoId: pending.protoId,
      label,
      grade,
      startTs: pending.msg.candidateStartTs,
      activeMs: now - pending.msg.candidateStartTs, // the retroactive credit
      runningSince: now,
      lastActiveTs: now,
      paused: false,
      apps: new Set(pending.apps),
      wrapPromptTs: 0,
    };
    this.candidate = null;
    this.broadcastChip(this.session, "running");
    return id;
  }

  // ── Session actions (chip / wrap card) ──────────────────────────────────────

  /** Wrap now (§6 confirm), keep going (corrects a too-eager decay model), or
   *  end from the chip (a boundary correction the model learns from). */
  sessionAction(sessionId: string, action: SessionAction):
      { ok: boolean; saveId?: string; error?: string } {
    const s = this.session;
    if (!s || s.id !== sessionId) return { ok: false, error: "no such session" };

    switch (action) {
      case "wrapped":
        return { ok: true, saveId: this.wrapSession(s, "wrap_confirmed") };
      case "ended":
        return { ok: true, saveId: this.wrapSession(s, "chip_ended") };
      case "keep_going":
        this.keepGoing(s, "user said keep going");
        return { ok: true };
    }
  }

  private keepGoing(s: Session, why: string): void {
    if (!s.wrapPromptTs) return;
    s.wrapPromptTs = 0;
    s.lastActiveTs = Date.now(); // the correction resets the quiet clock
    this.appendLabel({
      id: `ss-wrap-${s.id}`, ts: Date.now(), kind: "session_sense", event: "wrap_response",
      sessionId: s.id, response: "keep_going",
    });
    log(TAG, `${s.id}: wrap declined — ${why}`);
  }

  private pauseSession(s: Session): void {
    if (s.paused) return;
    s.activeMs += Math.max(0, s.lastActiveTs - s.runningSince);
    s.runningSince = 0;
    s.paused = true;
    this.broadcastChip(s, "paused");
    log(TAG, `${s.id}: paused (warmth decay)`);
  }

  private resumeSession(s: Session): void {
    if (!s.paused) return;
    s.paused = false;
    s.runningSince = Date.now();
    this.broadcastChip(s, "running");
    log(TAG, `${s.id}: resumed`);
  }

  private activeMsOf(s: Session, now: number): number {
    return s.activeMs + (s.paused || !s.runningSince ? 0 : Math.max(0, now - s.runningSince));
  }

  /** tracking/ending → summary: the standard save lifecycle over the credited
   *  span — candidateStart → end, honestly, pauses included in the receipt's
   *  span math. Undo remains a true cancel. */
  private wrapSession(s: Session, how: "wrap_confirmed" | "auto_wrap" | "chip_ended"): string {
    const now = Date.now();
    const minutes = Math.min(
      this.cfg.maxSessionMinutes,
      Math.max(1, Math.ceil((now - s.startTs) / 60_000)),
    );
    const apps = [...s.apps];
    // Scope to the session's own apps — never "mic" (privacy floor, §7).
    const saveId = this.saveManager.save(minutes, apps.length ? { apps } : undefined, "session_sense");

    this.appendLabel({
      id: `ss-wrap-${s.id}`, ts: now, kind: "session_sense", event: "wrap_response",
      sessionId: s.id, response: how,
      activeMinutes: Math.round(this.activeMsOf(s, now) / 60_000),
      creditedMinutes: minutes, saveId,
    });
    this.broadcastChip(s, "ended");
    log(TAG, `${s.id}: wrapped (${how}) — saving ${minutes}m over ${apps.join(", ")} → ${saveId}`);
    this.session = null;
    return saveId;
  }

  private broadcastChip(s: Session, status: "running" | "paused" | "ended"): void {
    this.broadcast({
      type: "session_chip",
      sessionId: s.id,
      status,
      label: s.label || "session",
      startedTs: s.startTs,
      activeMs: this.activeMsOf(s, Date.now()),
      ts: Date.now(),
    });
  }

  /** One JSONL record per event; nudge + response records share `id`. Same
   *  corpus as rung 1 (capture-labels.jsonl) — the graduation gate reads both. */
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

/** Mean of unit vectors, re-normalized — one centroid per prototype. */
function meanNormalized(vecs: Float32Array[]): Float32Array {
  const out = new Float32Array(vecs[0].length);
  for (const v of vecs) for (let i = 0; i < v.length; i++) out[i] += v[i];
  let norm = 0;
  for (let i = 0; i < out.length; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}
