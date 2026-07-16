import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EmbeddingService } from "../embedding/service.js";
import type {
  SenseEvent,
  SessionAction,
  SessionAssistMessage,
  SessionBookmarkRow,
  SessionChipMessage,
  SessionNudgeGrade,
  SessionNudgeMessage,
  SessionNudgeResponse,
  SessionSenseConfig,
  SessionWrapMessage,
} from "../types.js";
import type { SessionAssist } from "./window-ops.js";
import { PriorStore } from "./prior-store.js";
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
// Housekeeping cadence (prompt, pause/end/grace checks).
const HOUSEKEEPING_MS = 5_000;

/** A classifier hit — either a stock prototype or a personal prior topic
 *  (the two tiers of §5; personal wins when its signal is stronger). */
interface WorkflowMatch {
  kind: "stock" | "personal";
  id: string;
  label: string;
  floor: CategoryFloor;
}

interface Candidate {
  match: WorkflowMatch;
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
  match: WorkflowMatch | null;
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

/** A bookmarked thread (§9): a flag + cumulative history, not an open
 *  session. Nothing runs overnight; what persists is the promise. */
interface Bookmark {
  label: string;
  sessions: number;
  totalMs: number;
  lastTs: number;
  createdTs: number;
}

interface PersistedState {
  day: string;
  /** Once per thread per day (§7): threadId → last nudge ts. */
  nudgedThreads: Record<string, number>;
  /** ⚑ bookmarks by threadId (§9). */
  bookmarks: Record<string, Bookmark>;
}

interface PendingNudge {
  msg: SessionNudgeMessage;
  labelId: string;
  match: WorkflowMatch | null;
  apps: Set<string>;
}

/**
 * Session Sense (DESIGN-SESSION-SENSE.md, wireframes "Session Sense.dc.html"):
 * live workflow detection — the Watch's workout nudge for knowledge work.
 *
 *   idle → candidate (embedding match, dwell hysteresis, credit pinned)
 *        → prompted (once per thread per day, category floor — nothing else)
 *        → tracking (warmth pause/resume, chip) → ending (wrap prompt, grace)
 *        → summary (standard save lifecycle, provenance "session_sense").
 *
 * Deliberately Watch-simple: the dwell wait IS the etiquette. No attention
 * budgets, no breakpoint model, no dismissal streaks — the only cross-feature
 * coupling is policy A (a nudge consumes the episode's one ask, so the rung-1
 * save offer never re-asks about the same minutes).
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
  /** Personal tier (§5): KG-pretrained topic priors (prior_builder.py) —
   *  "Back on: <label>". Hot-reloads when the file changes; absent until the
   *  builder has run at least once. */
  private prior: PriorStore;

  /** Rolling OCR of the attended thread (per-tick classifier input). */
  private recentText: { text: string; ts: number }[] = [];
  private activeThreadId = "";
  private activeThreadLabel = "";
  private lastTickTs = 0;
  private lastSenseTs = 0;
  /** Last tick's full ranking (both tiers) — the "Wrong?" picker's rows. */
  private lastScores: { id: string; label: string; sim: number; floor: CategoryFloor; kind: "stock" | "personal" }[] = [];
  /** Policy A (§7): nudges shown, so a rung-1 offer never re-asks the episode. */
  private askedEpisodes: { threadId: string; ts: number }[] = [];

  private housekeeping: ReturnType<typeof setInterval>;

  constructor(
    private embedding: EmbeddingService,
    private saveManager: SaveManager,
    private broadcast: (msg: SessionNudgeMessage | SessionChipMessage | SessionWrapMessage | SessionAssistMessage) => void,
    private memoryDir: string,
    private cfg: SessionSenseConfig,
    /** Help-forward (§8 C): composes goal + next steps over the credited span
     *  via the burst lane. Null when the burst lane is unavailable. Runs only
     *  AFTER the tap — zero contract spent. */
    private composeAssist: ((minutes: number, apps: string[], label: string) => Promise<SessionAssist | null>) | null = null,
  ) {
    this.state = this.loadState();
    this.prior = new PriorStore(join(memoryDir, "workstate-prior.json"));
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
    const empty: PersistedState = { day: today(), nudgedThreads: {}, bookmarks: {} };
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

    // Two-tier ranking (§5): personal prior topics compete with the stock
    // library on the same cosine scale; the personal tier wins ties — the KG
    // already knows this thread by name, with recurrence behind it.
    this.prior.reload();
    const personal = this.prior.ready
      ? this.prior.topMatches(vec, 3, this.cfg.similarityThreshold)
      : [];
    this.lastScores = [
      ...personal.map((m) => ({
        id: `personal:${m.topic.id}`, label: m.topic.label,
        sim: m.similarity, floor: "none" as CategoryFloor, kind: "personal" as const,
      })),
      ...scored.map((s) => ({
        id: s.proto.id, label: s.proto.label, sim: s.sim,
        floor: s.proto.floor, kind: "stock" as const,
      })),
    ].sort((a, b) => b.sim - a.sim);

    const stockBest = scored[0];
    const personalBest = personal[0];
    const usePersonal =
      personalBest !== undefined && personalBest.similarity >= stockBest.sim;
    const bestSim = usePersonal ? personalBest.similarity : stockBest.sim;
    const bestMatch: WorkflowMatch = usePersonal
      ? { kind: "personal", id: personalBest.topic.id, label: personalBest.topic.label, floor: "none" }
      : { kind: "stock", id: stockBest.proto.id, label: stockBest.proto.label, floor: stockBest.proto.floor };

    if (bestSim < this.cfg.similarityThreshold) {
      // Below the floor: a matching run is broken; a confirmed candidate
      // decays silently (most candidates are never prompted — §4).
      if (this.candidate && !this.candidate.confirmedAt) this.candidate = null;
      return;
    }

    const c = this.candidate;
    if (c && c.threadId === this.activeThreadId &&
        c.match.kind === bestMatch.kind && c.match.id === bestMatch.id) {
      c.ticks++;
      c.bestSim = Math.max(c.bestSim, bestSim);
      c.apps.add(app);
      if (!c.confirmedAt && c.ticks >= this.cfg.dwellTicks) {
        c.confirmedAt = ts;
        log(TAG, `candidate confirmed: ${bestMatch.kind}/${bestMatch.id} on ${c.threadId} (sim ${bestSim.toFixed(2)}, credited from ${new Date(c.startTs).toISOString()})`);
      }
    } else if (!c || !c.confirmedAt) {
      // New matching run — the credit is pinned HERE (§4): accepting later
      // credits everything from this moment.
      this.candidate = {
        match: bestMatch,
        threadId: this.activeThreadId,
        startTs: this.recentText[0]?.ts ?? ts,
        ticks: 1,
        bestSim,
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
    // A confirmed candidate prompts on the next tick — the dwell hysteresis
    // already waited 2-3 minutes, which is the Watch's whole etiquette. No
    // breakpoint model, no budget: the card is quiet and ignorable by design.
    const c = this.candidate;
    if (c?.confirmedAt && !this.session && !this.pendingNudge) {
      this.maybePrompt(c, now);
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
    const match = c.match;

    const skip = (why: string): void => {
      log(TAG, `${c.threadId}: candidate ${match.kind}/${match.id} not prompted — ${why}`);
      this.candidate = null;
    };

    // The Watch model, deliberately simple: sustained signal → ask once →
    // never nag about the same thing again. The only guards are visible ones:
    // Category floor (§7): medical/dating never nudge, at any confidence.
    if (match.floor === "silent") return skip("category floor (silent)");
    // Once per thread per day (§7) — applies to resume nudges too.
    if (this.state.nudgedThreads[c.threadId]) return skip("thread already nudged today");

    // Bookmark return (§9): the ⚑ marks the user's own promise, not the
    // classifier's guess.
    const bookmark = this.state.bookmarks[c.threadId];

    // Confidence buys the label, never the card (§2): high similarity earns
    // the claim; medium drops it entirely — never hedged. Floored categories
    // are always unlabeled regardless of confidence. A bookmark's own label
    // always renders — it is the user's, not a claim.
    const high = c.bestSim >= this.cfg.similarityThreshold + this.cfg.labelMargin;
    const labeled = bookmark !== undefined || (high && match.floor === "none");
    const grade: SessionNudgeGrade = labeled
      ? (bookmark || match.kind === "personal" ? "personal" : "stock")
      : "unlabeled";

    // "Wrong?" rows: the classifier's own next candidates by similarity (§3),
    // both tiers mixed. Silent-floor prototypes never appear — self-labeling
    // may reveal a category, the card may not propose one. Resume nudges get
    // "Not this" instead of a picker — the correction is about the match.
    const seen = new Set<string>();
    const alternates = labeled && !bookmark
      ? this.lastScores
          .filter((p) => p.label !== match.label && p.floor !== "silent")
          .filter((p) => !seen.has(p.label) && seen.add(p.label))
          .slice(0, 3)
          .map((p) => p.label)
      : [];

    const nudgeId = `nudge-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const msg: SessionNudgeMessage = {
      type: "session_nudge",
      nudgeId,
      grade,
      label: bookmark ? bookmark.label : labeled ? match.label : undefined,
      threadId: c.threadId,
      candidateStartTs: c.startTs,
      elapsedMinutes: Math.max(1, Math.round((now - c.startTs) / 60_000)),
      apps: [...c.apps],
      alternates,
      ...(bookmark ? {
        resume: true,
        resumeMeta: describeBookmark(bookmark, now),
      } : {}),
      expirySeconds: this.cfg.expirySeconds,
      ts: now,
    };

    this.state.nudgedThreads[c.threadId] = now;
    this.saveState();
    this.askedEpisodes.push({ threadId: c.threadId, ts: now });
    if (this.askedEpisodes.length > 50) this.askedEpisodes.shift();

    const labelId = `ss-${nudgeId}`;
    this.appendLabel({
      id: labelId, ts: now, kind: "session_sense", stage: 2,
      threadId: c.threadId, tier: match.kind, protoId: match.id, grade,
      similarity: Number(c.bestSim.toFixed(3)),
      candidateStartTs: c.startTs, elapsedMinutes: msg.elapsedMinutes,
      decision: "nudged",
    });
    this.pendingNudge = { msg, labelId, match, apps: c.apps };
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
        break;
      case "corrected": {
        const picked = (label ?? "").trim();
        sessionId = this.startSession(pending, picked, picked ? "stock" : "unlabeled");
        break;
      }
      case "dismissed":
      case "expired":
        break; // labels record the negative; no suppression machinery beyond
               // once-per-thread-per-day — dismissing costs the user nothing.
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
      match: pending.match,
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
    this.fireAssist(this.session);
    return id;
  }

  /** Help-forward (§8 C): compose goal + next steps over the credited span,
   *  on the tap. Floored workflows never get an assist card, at any
   *  confidence, in any variant (§8 rules). */
  private fireAssist(s: Session): void {
    if (!this.composeAssist) return;
    if (s.match && s.match.floor !== "none") return;
    const minutes = Math.min(
      this.cfg.maxSessionMinutes,
      Math.max(1, Math.ceil((Date.now() - s.startTs) / 60_000)),
    );
    const sessionId = s.id;
    this.broadcast({ type: "session_assist", sessionId, status: "working", ts: Date.now() });
    void this.composeAssist(minutes, [...s.apps], s.label)
      .then((assist) => {
        if (this.session?.id !== sessionId) return; // session already gone
        if (!assist || (!assist.goal && assist.steps.length === 0)) {
          this.broadcast({ type: "session_assist", sessionId, status: "error", error: "nothing composed", ts: Date.now() });
          return;
        }
        this.broadcast({
          type: "session_assist", sessionId, status: "ready",
          goal: assist.goal, steps: assist.steps, ts: Date.now(),
        });
        log(TAG, `${sessionId}: assist ready (${assist.steps.length} steps)`);
      })
      .catch((err) => {
        this.broadcast({
          type: "session_assist", sessionId, status: "error",
          error: String(err).slice(0, 160), ts: Date.now(),
        });
      });
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
      case "later": {
        // ⚑ Later = Wrap up + a promise (§9). Same receipt, same undo; the
        // thread gains a bookmark. Always an explicit act — auto-wrap never
        // bookmarks.
        this.bookmarkThread(s.threadId, s.label || "session");
        return { ok: true, saveId: this.wrapSession(s, "wrap_later") };
      }
      case "keep_going":
        this.keepGoing(s, "user said keep going");
        return { ok: true };
    }
  }

  // ── Bookmarks (§9): the shelf, ⚑, resume, release ───────────────────────────

  private bookmarkThread(threadId: string, label: string): void {
    const existing = this.state.bookmarks[threadId];
    this.state.bookmarks[threadId] = existing
      ? { ...existing, label: existing.label || label }
      : { label, sessions: 0, totalMs: 0, lastTs: Date.now(), createdTs: Date.now() };
    this.saveState();
    log(TAG, `⚑ bookmarked ${threadId} ("${label}")`);
  }

  /** Shelf rows, most recent first. kgPath resolution is the server's job. */
  listBookmarks(): SessionBookmarkRow[] {
    return Object.entries(this.state.bookmarks)
      .map(([threadId, b]) => ({
        threadId, label: b.label, sessions: b.sessions,
        totalMs: b.totalMs, lastTs: b.lastTs,
      }))
      .sort((a, b) => b.lastTs - a.lastTs);
  }

  /** Shelf actions: ▶ resume starts a fresh session on the thread NOW (no
   *  detection wait, no nudge — §9); ✕ releases the promise. */
  bookmarkAction(threadId: string, action: "resume" | "remove"):
      { ok: boolean; sessionId?: string; error?: string } {
    const bookmark = this.state.bookmarks[threadId];
    if (!bookmark) return { ok: false, error: "no such bookmark" };

    if (action === "remove") {
      delete this.state.bookmarks[threadId];
      this.saveState();
      this.appendLabel({
        id: `ss-bm-${Date.now().toString(36)}`, ts: Date.now(),
        kind: "session_sense", event: "bookmark_released", threadId,
      });
      return { ok: true };
    }

    if (this.session) return { ok: false, error: "a session is already running" };
    const now = Date.now();
    const id = `sess-${now.toString(36)}-${randomBytes(3).toString("hex")}`;
    this.session = {
      id,
      threadId,
      match: null,
      label: bookmark.label,
      grade: "personal",
      startTs: now, // a fresh session — no retroactive credit on manual resume
      activeMs: 0,
      runningSince: now,
      lastActiveTs: now,
      paused: false,
      apps: new Set(),
      wrapPromptTs: 0,
    };
    this.broadcastChip(this.session, "running");
    this.appendLabel({
      id: `ss-bm-${now.toString(36)}`, ts: now, kind: "session_sense",
      event: "bookmark_resumed", threadId, sessionId: id,
    });
    log(TAG, `⚑ resumed ${threadId} → ${id}`);
    return { ok: true, sessionId: id };
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
  private wrapSession(s: Session, how: "wrap_confirmed" | "auto_wrap" | "chip_ended" | "wrap_later"): string {
    const now = Date.now();
    const minutes = Math.min(
      this.cfg.maxSessionMinutes,
      Math.max(1, Math.ceil((now - s.startTs) / 60_000)),
    );
    const apps = [...s.apps];
    // Scope to the session's own apps — never "mic" (privacy floor, §7).
    const saveId = this.saveManager.save(minutes, apps.length ? { apps } : undefined, "session_sense");

    // Cumulative bookmark history (§9): sessions link by thread id — three
    // workouts, one habit. Any wrap on a bookmarked thread counts.
    const bookmark = this.state.bookmarks[s.threadId];
    if (bookmark) {
      bookmark.sessions++;
      bookmark.totalMs += this.activeMsOf(s, now);
      bookmark.lastTs = now;
      if (s.label) bookmark.label = s.label;
      this.saveState();
    }

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

/** "bookmarked yesterday · 2 sessions · 1h 19m so far" — the resume card's
 *  history line, composed core-side so every token is checkable. */
function describeBookmark(b: { createdTs: number; sessions: number; totalMs: number }, now: number): string {
  const days = Math.floor((now - b.createdTs) / 86_400_000);
  const when = days <= 0 ? "today" : days === 1 ? "yesterday" : `${days}d ago`;
  const parts = [`bookmarked ${when}`];
  if (b.sessions > 0) {
    parts.push(`${b.sessions} session${b.sessions === 1 ? "" : "s"}`);
    parts.push(`${fmtDuration(b.totalMs)} so far`);
  }
  return parts.join(" · ");
}

function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${(m % 60).toString().padStart(2, "0")}m` : `${m}m`;
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
