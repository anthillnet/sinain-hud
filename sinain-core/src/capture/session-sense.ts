import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  SenseEvent,
  SessionAction,
  SessionAssistMessage,
  SessionBookmarkRow,
  SessionChipMessage,
  SessionNudgeMessage,
  SessionNudgeResponse,
  SessionSenseConfig,
  SessionWrapMessage,
} from "../types.js";
import type { EpisodeQualified } from "./episode-tracker.js";
import type { SaveManager } from "./save-manager.js";
import { deriveProject } from "./thread-identity.js";
import type { SessionAssist } from "./window-ops.js";
import { log, warn } from "../log.js";

const TAG = "session-sense";

// Housekeeping cadence (pause/end/grace checks).
const HOUSEKEEPING_MS = 5_000;

interface Session {
  id: string;
  threadId: string;
  /** Display label — the episode's own thread label; "" when unlabeled. */
  label: string;
  startTs: number;
  /** Accumulated active ms, excluding pauses. */
  activeMs: number;
  /** When the current running stretch began (0 = paused). */
  runningSince: number;
  /** Last moment attention was on the session's apps/thread. */
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

/** What an accepted nudge teaches: the user confirmed that THIS thread is a
 *  track-worthy workflow, under THIS label. A lookup table the user's own
 *  accepts build — the future "guess" is just their past answer. */
interface Fingerprint {
  label: string;
  count: number;
  lastTs: number;
}

interface PersistedState {
  day: string;
  /** Once per thread per day (§7): threadId → last nudge ts. */
  nudgedThreads: Record<string, number>;
  /** ⚑ bookmarks by threadId (§9). */
  bookmarks: Record<string, Bookmark>;
  /** Accepted-nudge fingerprints by threadId. */
  fingerprints: Record<string, Fingerprint>;
}

interface PendingNudge {
  msg: SessionNudgeMessage;
  labelId: string;
  apps: string[];
  /** Assist composed for the nudge (variant A) — reused on track, so the
   *  chip's "✦ next steps" never pays for a second composition. */
  assist: SessionAssist | null;
}

/** How long the nudge waits for its assist before going out bare (variant
 *  A degrades, never delays — the moment matters more than the details). */
const ASSIST_WAIT_MS = 4_000;

/**
 * Session Sense (DESIGN-SESSION-SENSE.md, wireframes "Session Sense.dc.html"):
 * the Watch's workout nudge for knowledge work — the SHIPPED autosave
 * detection (episode tracker: engaged dwell on a thread family), reskinned to
 * ask DURING the episode instead of after it:
 *
 *   episode qualifies (same "long, engaged" signal the save offer waits for)
 *     → "Looks like you're working on: <thread label> — track from 11:02?"
 *     → tracking (warmth pause/resume, chip) → ending (wrap prompt, grace)
 *     → summary (standard save lifecycle, provenance "session_sense").
 *
 * No classifier, no prototypes, no priors — thread identity and dwell are the
 * whole detector, exactly as they are for the save offer. Zero LLM before the
 * tap; the label is the thread's own (the offer's "mostly: …" line), so the
 * card never claims more than the window title already shows. Guards are the
 * visible ones only: once per thread per day, one card at a time, and policy
 * A (a nudge consumes the episode's one ask — the save offer never re-asks).
 */
export class SessionSenseManager {
  private state: PersistedState;
  private pendingNudge: PendingNudge | null = null;
  private session: Session | null = null;

  /** Policy A (§7): nudges shown, so a rung-1 offer never re-asks the episode. */
  private askedEpisodes: { threadId: string; ts: number }[] = [];

  private housekeeping: ReturnType<typeof setInterval>;

  constructor(
    private saveManager: SaveManager,
    private broadcast: (msg: SessionNudgeMessage | SessionChipMessage | SessionWrapMessage | SessionAssistMessage) => void,
    private memoryDir: string,
    private cfg: SessionSenseConfig,
    /** Help-forward (§8 C): composes goal + next steps over the credited span
     *  via the burst lane. Null when the burst lane is unavailable. Runs only
     *  AFTER the tap — zero contract spent. */
    private composeAssist: ((minutes: number, apps: string[], label: string) => Promise<SessionAssist | null>) | null = null,
    /** Source chips for the card: distinct apps in the last N minutes — the
     *  same window data the save offer proposes from. */
    private listSources: ((minutes: number) => { name: string; kind: string; minutes: number }[]) | null = null,
  ) {
    this.state = this.loadState();
    this.housekeeping = setInterval(() => this.tick(), HOUSEKEEPING_MS);
    this.housekeeping.unref?.();
    log(TAG, cfg.enabled
      ? `armed: episode ≥${cfg.qualifyMinutes}m qualifies · wrap after ${cfg.endQuietMinutes}m quiet + ${cfg.wrapGraceMinutes}m grace`
      : "disabled (SESSION_SENSE_ENABLED=false)");
  }

  stop(): void {
    clearInterval(this.housekeeping);
  }

  private get statePath(): string { return join(this.memoryDir, "session-sense-state.json"); }
  private get labelsPath(): string { return join(this.memoryDir, "capture-labels.jsonl"); }

  private loadState(): PersistedState {
    const empty: PersistedState = { day: today(), nudgedThreads: {}, bookmarks: {}, fingerprints: {} };
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

  // ── Sense intake: session warmth only ───────────────────────────────────────

  /** Feed one sense event. Detection lives in the episode tracker; this only
   *  keeps a running session's warmth honest (auto-pause / auto-resume). */
  observe(event: SenseEvent): void {
    if (!this.cfg.enabled) return;
    const app = event.meta.app;
    if (!app || app === "unknown") return;
    const s = this.session;
    if (!s) return;

    const { key } = deriveProject(app, event.meta.windowTitle ?? "");
    // A workflow is a family of apps, like an episode: attention on any of
    // the session's apps (or its thread) keeps it running.
    if (s.apps.has(app) || key === s.threadId) {
      s.lastActiveTs = event.ts;
      s.apps.add(app);
      if (s.paused) this.resumeSession(s);
      if (s.wrapPromptTs) this.keepGoing(s, "activity resumed");
    }
  }

  // ── The nudge (episode qualified → prompted) ────────────────────────────────

  /** Episode-tracker hook: a live episode crossed the engaged threshold —
   *  the autosave signal, surfaced mid-episode. Ask now, once. */
  onEpisodeQualified(ep: EpisodeQualified): void {
    if (!this.cfg.enabled) return;
    this.rollDay();

    const skip = (why: string): void =>
      log(TAG, `${ep.threadId}: episode qualified (${Math.round(ep.engagedMs / 60_000)}m) — no nudge: ${why}`);

    if (this.session) return skip("a session is already running");
    if (this.pendingNudge) return skip("a nudge is already on screen");
    // Once per thread per day — the only frequency rule.
    if (this.state.nudgedThreads[ep.threadId]) return skip("thread already nudged today");

    // Source chips from the same window data the save offer proposes from.
    const minutes = Math.max(1, Math.round(ep.engagedMs / 60_000));
    const apps = (this.listSources?.(minutes) ?? [])
      .filter((s) => s.kind === "app")
      .map((s) => s.name);

    // Bookmark return (§9): the ⚑ marks the user's own promise. A past
    // accept (fingerprint) upgrades the label the same way — the guess is
    // the user's own previous answer, rendered as "Back on: <label>".
    const bookmark = this.state.bookmarks[ep.threadId];
    const fingerprint = this.state.fingerprints[ep.threadId];
    const known = bookmark ?? fingerprint;

    const nudgeId = `nudge-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const msg: SessionNudgeMessage = {
      type: "session_nudge",
      nudgeId,
      // The label is the thread's own — the same source as the save offer's
      // "mostly: …" line. The card never claims more than the screen shows,
      // or than the user has themselves confirmed before.
      grade: known ? "personal" : "stock",
      label: known ? known.label : ep.label || undefined,
      threadId: ep.threadId,
      candidateStartTs: ep.startTs,
      elapsedMinutes: minutes,
      apps: apps.slice(0, 4),
      alternates: [],
      ...(bookmark ? {
        resume: true,
        resumeMeta: describeBookmark(bookmark, ep.at),
      } : {}),
      expirySeconds: this.cfg.expirySeconds,
      ts: ep.at,
    };

    this.state.nudgedThreads[ep.threadId] = ep.at;
    this.saveState();
    this.askedEpisodes.push({ threadId: ep.threadId, ts: ep.at });
    if (this.askedEpisodes.length > 50) this.askedEpisodes.shift();

    const labelId = `ss-${nudgeId}`;
    const pending: PendingNudge = { msg, labelId, apps, assist: null };
    this.pendingNudge = pending;
    setTimeout(() => {
      // Server-side TTL well past client expiry — abandoned asks don't linger.
      if (this.pendingNudge?.msg.nudgeId === nudgeId) this.pendingNudge = null;
    }, (this.cfg.expirySeconds + 300) * 1000).unref?.();

    void this.composeAndSend(pending, ep, minutes);
  }

  /** Variant A (§8 — explicit contract amendment 2026-07-16): compose goal +
   *  next steps on the burst lane BEFORE consent, bounded by ASSIST_WAIT_MS —
   *  the card degrades to the bare claim rather than arriving late. The
   *  composition is reused on track (chip ✦), never paid twice. */
  private async composeAndSend(pending: PendingNudge, ep: EpisodeQualified, minutes: number): Promise<void> {
    const msg = pending.msg;
    if (this.composeAssist) {
      try {
        const compose = this.composeAssist(minutes, pending.apps, msg.label ?? ep.label);
        const assist = await Promise.race([
          compose,
          new Promise<null>((res) => {
            const t = setTimeout(() => res(null), ASSIST_WAIT_MS);
            t.unref?.();
          }),
        ]);
        if (assist && (assist.goal || assist.steps.length > 0)) {
          pending.assist = assist;
          msg.goal = assist.goal || undefined;
          msg.steps = assist.steps.length ? assist.steps : undefined;
        } else {
          // Late composition still lands on the pending nudge — a track after
          // the race window reuses it for the chip's ✦ instead of recomposing.
          void compose.then((late) => {
            if (late && this.pendingNudge === pending) pending.assist = late;
          }).catch(() => { /* already degraded */ });
        }
      } catch { /* bare card — the moment matters more than the details */ }
    }

    if (this.pendingNudge !== pending) return; // expired during composition

    this.appendLabel({
      id: pending.labelId, ts: msg.ts, kind: "session_sense", stage: 2,
      threadId: msg.threadId, threadLabel: ep.label,
      candidateStartTs: msg.candidateStartTs, elapsedMinutes: minutes,
      assist: pending.assist !== null,
      ...(msg.resume ? { resume: true } : {}),
      decision: "nudged",
    });
    log(TAG, `${msg.nudgeId}: nudging "${msg.label ?? "(unlabeled)"}" on ${msg.threadId} — credited from ${new Date(msg.candidateStartTs).toISOString()}${pending.assist ? " · assist attached" : ""}`);
    this.broadcast(msg);
  }

  // ── Nudge responses (prompted → tracking | idle) ────────────────────────────

  /** Overlay response to a nudge. `corrected` carries a user-typed label
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
        sessionId = this.startSession(pending, pending.msg.label ?? "");
        this.recordFingerprint(pending.msg.threadId, pending.msg.label ?? "");
        break;
      case "corrected":
        sessionId = this.startSession(pending, (label ?? "").trim());
        this.recordFingerprint(pending.msg.threadId, (label ?? "").trim());
        break;
      case "dismissed":
      case "expired":
        break; // labels record the negative; dismissing costs the user nothing.
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

  /** An accept is a consent moment AND a lesson: remember thread → label so
   *  the next qualification on this thread greets with the user's own
   *  answer ("Back on: <label>") instead of the raw window title. */
  private recordFingerprint(threadId: string, label: string): void {
    const prev = this.state.fingerprints[threadId];
    this.state.fingerprints[threadId] = {
      label: label || prev?.label || "",
      count: (prev?.count ?? 0) + 1,
      lastTs: Date.now(),
    };
    this.saveState();
  }

  private startSession(pending: PendingNudge, label: string): string {
    const now = Date.now();
    const id = `sess-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    this.session = {
      id,
      threadId: pending.msg.threadId,
      label,
      startTs: pending.msg.candidateStartTs,
      activeMs: now - pending.msg.candidateStartTs, // the retroactive credit
      runningSince: now,
      lastActiveTs: now,
      paused: false,
      apps: new Set(pending.apps),
      wrapPromptTs: 0,
    };
    this.broadcastChip(this.session, "running");
    if (pending.assist) {
      // The nudge already paid for the composition — the chip's ✦ reuses it.
      this.broadcast({
        type: "session_assist", sessionId: id, status: "ready",
        goal: pending.assist.goal, steps: pending.assist.steps, ts: now,
      });
    } else {
      this.fireAssist(this.session);
    }
    return id;
  }

  /** Help-forward (§8 C): compose goal + next steps over the credited span,
   *  on the tap. */
  private fireAssist(s: Session): void {
    if (!this.composeAssist) return;
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

  // ── Housekeeping: pause, wrap, grace ────────────────────────────────────────

  private tick(): void {
    if (!this.cfg.enabled) return;
    const now = Date.now();
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

  // ── Session actions (chip / wrap card) ──────────────────────────────────────

  /** Wrap now (§6 confirm), keep going (corrects a too-eager decay model),
   *  end from the chip (a boundary correction), or "⚑ Later" (§9). */
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
      label: bookmark.label,
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

  // ── Session internals ───────────────────────────────────────────────────────

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
