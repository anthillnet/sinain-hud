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
  /** True when the label was TYPED by the user (corrected path) — such a
   *  label is never overwritten by an inferred assist title. Absent/false
   *  for labels the user merely accepted (thread fallback or assist title). */
  userTyped?: boolean;
}

interface PersistedState {
  day: string;
  /** Threads whose nudge was explicitly ✕-DECLINED today → don't re-ask.
   *  An accepted nudge never silences a thread — multiple sessions of the
   *  same workflow per day are the normal case (§7). */
  declinedThreads: Record<string, number>;
  /** Threads whose nudge merely EXPIRED (ignored — "not now", not "no"):
   *  snoozed until this ts, then a new episode may ask again. */
  snoozedUntil: Record<string, number>;
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
  /** Parallel sessions (§5): warmth is attention and attention is singular —
   *  one session is ever warm; the rest sit paused, each heading toward its
   *  own wrap flow independently. Keyed by session id. */
  private sessions = new Map<string, Session>();
  /** Latest ready assist per live session, retained only for deterministic
   *  hook enrichment while that Session Sense session is active. */
  private assists = new Map<string, SessionAssist>();
  private agentAugments: ((threadId: string) => { working: number; receipts: string[] }) | null = null;
  private agentWrapHook: ((threadId: string) => void) | null = null;

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

  activeSessions(): { id: string; threadId: string; label: string; startTs: number; paused: boolean }[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.id, threadId: s.threadId, label: s.label, startTs: s.startTs, paused: s.paused,
    }));
  }

  assistForThread(threadId: string): SessionAssist | null {
    const session = [...this.sessions.values()].find((s) => s.threadId === threadId);
    return session ? this.assists.get(session.id) ?? null : null;
  }

  setAgentAugments(fn: (threadId: string) => { working: number; receipts: string[] }): void {
    this.agentAugments = fn;
  }

  setAgentWrapHook(fn: (threadId: string) => void): void {
    this.agentWrapHook = fn;
  }

  rebroadcastChip(threadId: string): void {
    const session = [...this.sessions.values()].find((s) => s.threadId === threadId);
    if (session) this.broadcastChip(session, session.paused ? "paused" : "running");
  }

  private get statePath(): string { return join(this.memoryDir, "session-sense-state.json"); }
  private get labelsPath(): string { return join(this.memoryDir, "capture-labels.jsonl"); }

  private loadState(): PersistedState {
    const empty: PersistedState = { day: today(), declinedThreads: {}, snoozedUntil: {}, bookmarks: {}, fingerprints: {} };
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
      this.state.declinedThreads = {};
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
   *  keeps session warmth honest (auto-pause / auto-resume). Attention is
   *  singular: each event warms AT MOST ONE session — a thread-identity
   *  match beats an app-family match, and ties go to the most recently
   *  active session (shared apps like a browser must not warm every
   *  session that ever touched them). */
  observe(event: SenseEvent): void {
    if (!this.cfg.enabled) return;
    const app = event.meta.app;
    if (!app || app === "unknown") return;
    if (this.sessions.size === 0) return;

    const { key } = deriveProject(app, event.meta.windowTitle ?? "");
    let match: Session | null = null;
    for (const s of this.sessions.values()) {
      if (key === s.threadId) { match = s; break; } // exact thread wins
      if (s.apps.has(app) && (!match || s.lastActiveTs > match.lastActiveTs)) {
        match = s;
      }
    }
    if (!match) return;
    match.lastActiveTs = event.ts;
    match.apps.add(app);
    if (match.paused) this.resumeSession(match);
    if (match.wrapPromptTs) this.keepGoing(match, "activity resumed");
  }

  // ── The nudge (episode qualified → prompted) ────────────────────────────────

  /** Episode-tracker hook: a live episode crossed the engaged threshold —
   *  the autosave signal, surfaced mid-episode. Ask now, once. */
  onEpisodeQualified(ep: EpisodeQualified): void {
    if (!this.cfg.enabled) return;
    this.rollDay();

    const skip = (why: string): void =>
      log(TAG, `${ep.threadId}: episode qualified (${Math.round(ep.engagedMs / 60_000)}m) — no nudge: ${why}`);

    // Parallel sessions are the normal workflow — only a session ALREADY ON
    // THIS THREAD blocks a new ask (you can't track the same work twice).
    for (const s of this.sessions.values()) {
      if (s.threadId === ep.threadId) return skip("this thread is already being tracked");
    }
    if (this.pendingNudge) return skip("a nudge is already on screen");
    // Frequency rules, by reaction: an explicit ✕ silences the thread for
    // the day; merely ignoring it (expiry) only snoozes it for a while —
    // "not now" is not "no". A yes never silences anything: a second
    // job-search session this afternoon asks again (greeting with the
    // fingerprint label). Episodes provide the natural spacing: the hook
    // fires once per episode, so only a genuinely new episode can re-ask.
    if (this.state.declinedThreads[ep.threadId]) return skip("declined (✕) earlier today");
    const snoozed = this.state.snoozedUntil[ep.threadId];
    if (snoozed && ep.at < snoozed) {
      return skip(`ignored recently — snoozed for ${Math.ceil((snoozed - ep.at) / 60_000)}m more`);
    }

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
          // Container labels ("Google Chrome", "Home / X", a repo name) teach
          // nothing — the assist just read the screen, so its title names the
          // WORK. Any label the user didn't type upgrades; when the fresh
          // title genuinely differs from a remembered one, the claim
          // downgrades to "Looks like:" — an inference is not the user's own
          // past answer, even when it replaces one.
          if (assist.title && this.labelUpgradable(msg.threadId)) {
            const same = (msg.label ?? "").toLowerCase() === assist.title.toLowerCase();
            msg.label = assist.title;
            if (!same) msg.grade = "stock";
          }
        } else {
          // Late composition still lands on the pending nudge — a track after
          // the race window reuses it for the chip's ✦ instead of recomposing.
          void compose.then((late) => {
            if (late && this.pendingNudge === pending) pending.assist = late;
          }).catch(() => { /* already degraded */ });
        }
      } catch (err) {
        // Bare card — the moment matters more than the details. But say so:
        // a silently-swallowed composition failure cost a debugging session.
        warn(TAG, `nudge assist composition failed: ${String(err).slice(0, 160)}`);
      }
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
      case "tracked": {
        // A late assist (lost the 4s race, resolved before the tap) still
        // upgrades a weak label at consent time — same rule as the card.
        let accepted = pending.msg.label ?? "";
        if (pending.assist?.title && this.labelUpgradable(pending.msg.threadId)) {
          accepted = pending.assist.title;
        }
        sessionId = this.startSession(pending, accepted);
        this.recordFingerprint(pending.msg.threadId, accepted);
        break;
      }
      case "corrected":
        sessionId = this.startSession(pending, (label ?? "").trim());
        this.recordFingerprint(pending.msg.threadId, (label ?? "").trim(), true);
        break;
      case "dismissed":
        // An explicit no is respected for the rest of the day.
        this.state.declinedThreads[pending.msg.threadId] = Date.now();
        this.saveState();
        break;
      case "expired":
        // Ignored is "not now", not "no" — snooze, then ask again on a
        // fresh episode.
        this.state.snoozedUntil[pending.msg.threadId] =
          Date.now() + this.cfg.snoozeMinutes * 60_000;
        this.saveState();
        break;
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

  /** The assist's inferred title may upgrade ANY label the user didn't type
   *  themselves (product call 2026-07-17: all sessions — "Home / X" or a repo
   *  name describe the container just like "Google Chrome" does; the title
   *  names the work). Only a user-TYPED label (corrected path) is permanent. */
  private labelUpgradable(threadId: string): boolean {
    return !this.state.fingerprints[threadId]?.userTyped;
  }

  /** An accept is a consent moment AND a lesson: remember thread → label so
   *  the next qualification on this thread greets with the user's own
   *  answer ("Back on: <label>") instead of the raw window title. */
  private recordFingerprint(threadId: string, label: string, userTyped = false): void {
    const prev = this.state.fingerprints[threadId];
    this.state.fingerprints[threadId] = {
      label: label || prev?.label || "",
      count: (prev?.count ?? 0) + 1,
      lastTs: Date.now(),
      userTyped: (userTyped && !!label) || prev?.userTyped || undefined,
    };
    this.saveState();
  }

  /** Upgrade a weak (app-name) label to the assist's inferred title everywhere
   *  the old label lives: the running session, its bookmark row, and the
   *  thread fingerprint. Call sites guard with weakLabel, so a user-typed
   *  label can never be renamed away. */
  private renameSession(s: Session, title: string): void {
    const old = s.label || "(unlabeled)";
    s.label = title;
    const bm = this.state.bookmarks[s.threadId];
    if (bm) bm.label = title;
    const fp = this.state.fingerprints[s.threadId];
    if (fp && !fp.userTyped) fp.label = title;
    this.saveState();
    this.broadcastChip(s, s.paused ? "paused" : "running");
    this.appendLabel({
      id: `ss-rename-${s.id}`, ts: Date.now(), kind: "session_sense", event: "renamed",
      sessionId: s.id, threadId: s.threadId, from: old, to: title,
    });
    log(TAG, `${s.id}: renamed "${old}" → "${title}" (assist title)`);
  }

  private startSession(pending: PendingNudge, label: string): string {
    const now = Date.now();
    const id = `sess-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    // Tracked sessions persist in the bookmarks list from the moment of
    // consent (product call 2026-07-16): the list is the session's home,
    // before and after it wraps — release (✕) is the user's own act.
    this.bookmarkThread(
      pending.msg.threadId, label || pending.msg.label || "session");
    const session: Session = {
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
    this.sessions.set(id, session);
    this.broadcastChip(session, "running");
    if (pending.assist) {
      // The nudge already paid for the composition — the chip's ✦ reuses it.
      this.assists.set(id, pending.assist);
      this.broadcast({
        type: "session_assist", sessionId: id, status: "ready",
        goal: pending.assist.goal, steps: pending.assist.steps, ts: now,
      });
    } else {
      this.fireAssist(session);
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
        if (!this.sessions.has(sessionId)) return; // session already gone
        if (!assist || (!assist.goal && assist.steps.length === 0)) {
          warn(TAG, `${sessionId}: assist composed nothing`);
          this.broadcast({ type: "session_assist", sessionId, status: "error", error: "nothing composed", ts: Date.now() });
          return;
        }
        this.assists.set(sessionId, assist);
        this.broadcast({
          type: "session_assist", sessionId, status: "ready",
          goal: assist.goal, steps: assist.steps, ts: Date.now(),
        });
        log(TAG, `${sessionId}: assist ready (${assist.steps.length} steps)`);
        // Session started under an app-name label (nudge went out bare) —
        // the assist read the screen anyway, so rename the running session
        // after the work. Chip re-broadcast carries the new label to the UI.
        if (assist.title && this.labelUpgradable(s.threadId) &&
            s.label.toLowerCase() !== assist.title.toLowerCase()) {
          this.renameSession(s, assist.title);
        }
      })
      .catch((err) => {
        warn(TAG, `${sessionId}: assist failed: ${String(err).slice(0, 160)}`);
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

    // Every session advances independently (§5): a paused session that stays
    // cold hits its own ending flow while another runs warm.
    for (const s of [...this.sessions.values()]) {
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
  }

  // ── Session actions (chip / wrap card) ──────────────────────────────────────

  /** Wrap now (§6 confirm), keep going (corrects a too-eager decay model),
   *  end from the chip (a boundary correction), or "⚑ Later" (§9). */
  sessionAction(sessionId: string, action: SessionAction):
      { ok: boolean; saveId?: string; error?: string } {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, error: "no such session" };

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
      case "flag":
        // Mid-session ⚑ (§9 "come back later" from the chip): flag the
        // thread for return WITHOUT ending the session — for the case where
        // you're being pulled away and know it.
        this.bookmarkThread(s.threadId, s.label || "session");
        return { ok: true };
      case "keep_going":
        this.keepGoing(s, "user said keep going");
        return { ok: true };
    }
  }

  // ── Bookmarks (§9): the shelf, ⚑, resume, release ───────────────────────────

  private bookmarkThread(threadId: string, label: string): void {
    const existing = this.state.bookmarks[threadId];
    // A user-typed label is kept; anything else yields to the incoming label,
    // so a bookmark row upgrades the first time its thread tracks under a
    // real title.
    const keep = existing?.label && !this.labelUpgradable(threadId);
    this.state.bookmarks[threadId] = existing
      ? { ...existing, label: keep ? existing.label : (label || existing.label) }
      : { label, sessions: 0, totalMs: 0, lastTs: Date.now(), createdTs: Date.now() };
    this.saveState();
    log(TAG, `⚑ bookmarked ${threadId} ("${label}")`);
  }

  /** Live-session snapshots for the sessions list (chip-shaped: the overlay
   *  hydrates from these, then rides the chip stream). Warm first. */
  activeSnapshots(): { sessionId: string; status: "running" | "paused"; label: string; startedTs: number; activeMs: number; threadId: string }[] {
    const now = Date.now();
    return [...this.sessions.values()]
      .map((s) => ({
        sessionId: s.id,
        status: s.paused ? ("paused" as const) : ("running" as const),
        label: s.label || "session",
        startedTs: s.startTs,
        activeMs: this.activeMsOf(s, now),
        threadId: s.threadId,
        ...(this.agentAugments && this.agentAugments(s.threadId).working > 0
          ? { agentsWorking: this.agentAugments(s.threadId).working }
          : {}),
      }))
      .sort((a, b) =>
        a.status === b.status ? b.activeMs - a.activeMs : a.status === "running" ? -1 : 1);
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

    for (const s of this.sessions.values()) {
      if (s.threadId === threadId) {
        return { ok: false, error: "this thread is already being tracked" };
      }
    }
    const now = Date.now();
    const id = `sess-${now.toString(36)}-${randomBytes(3).toString("hex")}`;
    const session: Session = {
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
    this.sessions.set(id, session);
    this.broadcastChip(session, "running");
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
    const agentAugments = this.agentAugments?.(s.threadId) ?? { working: 0, receipts: [] };
    // Scope to the session's own apps — never "mic" (privacy floor, §7).
    const saveId = this.saveManager.save(minutes, apps.length ? { apps } : undefined, "session_sense", agentAugments.receipts);
    this.agentWrapHook?.(s.threadId);

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
    this.sessions.delete(s.id);
    this.assists.delete(s.id);
    return saveId;
  }

  private broadcastChip(s: Session, status: "running" | "paused" | "ended"): void {
    this.broadcast({
      type: "session_chip",
      sessionId: s.id,
      threadId: s.threadId,
      status,
      label: s.label || "session",
      startedTs: s.startTs,
      activeMs: this.activeMsOf(s, Date.now()),
      ...(this.agentAugments && this.agentAugments(s.threadId).working > 0
        ? { agentsWorking: this.agentAugments(s.threadId).working }
        : {}),
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
