// WorkStateEngine — the thread bank (§9). Owns the KG-pretrained prior and a
// Map<topicId, ThreadState>; each observation is routed (with hysteresis) to one
// project-thread, the rest cool, and the board is ranked by cross-thread
// attention-need. No loop.ts/event-bus coupling — a self-paced poll over the
// sense/feed buffers. Read-only surfaces: GET /workstate + console (WSM_LOG=1).

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SenseBuffer } from "../buffers/sense-buffer.js";
import type { FeedBuffer } from "../buffers/feed-buffer.js";
import type { EmbeddingService } from "../embedding/service.js";
import { buildRawFeatures, type ExtractorState } from "./extractor.js";
import { estimate, type EmbedFn } from "./estimator.js";
import { decide, type PolicyContext } from "./policy.js";
import { PriorStore } from "./prior.js";
import { ReturnCorpus, type RetrievalCandidate } from "./retrieval.js";
import { fuseBand, loudnessFromRetrieval } from "./scorer.js";
import { SemanticIdModel, type SemanticId } from "./semantic-id.js";
import { SequenceModel, type SequencePrediction } from "./sequence.js";
import {
  bandForMinutes, bandForTier, continuationToken, supportMode,
  workStateTokens, type ReturnFeatures,
} from "./tokenizer.js";
import type {
  AthiumDecision,
  LastWork,
  NextAction,
  RawFeatures,
  RegionThreadLite,
  ResumeCard,
  ThreadBoardEntry,
  WorkStateVector,
  WorkStateView,
} from "./types.js";

const HYSTERESIS_TICKS = 2; // a rival project must win this many ticks to switch
// A KG topic must clear this similarity to NAME a thread (stricter than the
// ENRICH_MIN 0.45 that lets it enrich) — naming damping against noisy matches.
const NAME_MIN = 0.5;
// Re-attending after this gap = a "resumed" event (arms the §9 marker).
// Env-overridable (WSM_RESUME_GAP_MS) so the return flow can be exercised
// without a literal 5-minute absence.
const RESUME_GAP_MS = Number(process.env.WSM_RESUME_GAP_MS) || 5 * 60_000;
const TEMP_HALFLIFE_MS = 4 * 3_600_000; // working-memory cooling (~4h)
const DEFAULT_CADENCE_MS = 24 * 3_600_000; // fallback re-attention gap
const TRAJ_MAX = 16;
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

interface ThreadState {
  topicId: string; // structural key (proj:/chat:/web:/app:)
  label: string;
  kgContext: string | null; // KG sub-focus enrichment (null = unrecognized)
  cadenceMs: number;
  vector: WorkStateVector;
  decision: AthiumDecision;
  firstSeenTs: number;
  lastAttendedTs: number;
  attendCount: number;
  trajectory: number[];
  breakpoints: number[]; // ts of switch-aways
  lastWork?: LastWork; // frozen at switch-away — the resume card's "where you left off"
  liveWork?: LastWork; // rolling per-tick snapshot of the active session (→ lastWork on leave)
  switchCountAtLeave?: number; // global switchCount when this thread was last left
}

/** An in-flight return event (DESIGN-WSM-prediction.md §16) — opened when a
 *  resume arms, accrues outcome tokens, and is written as one complete record
 *  to workstate-returns.jsonl when the user leaves/dismisses (tokens_before →
 *  tokens_after, joinable). This is the training corpus Layers 2–5 fit on. */
interface ReturnEvent {
  id: string;
  threadId: string;
  ts: number; // return time
  tokensBefore: string[];
  retrieval: RetrievalCandidate; // Layer 2 candidate (k-NN over past returns)
  semanticId: SemanticId; // Layer 3 codebook assignment
  sequencePrediction: SequencePrediction; // Layer 4 co-occurrence next-token stub
  prediction: { reentry_cost: string; duration_band: string; next_actions: string[]; support_mode: string; confidence_tier: string };
  /** Latent head values at return time — the calibration harness joins these
   *  against the observed outcome (e.g. does stuckness-at-return predict
   *  abandonment?). INTERNAL: training data only, never surfaced. */
  latents: { difficulty: number; stuckness: number; topicAffinity: number; focusStability: number };
  brief: { claim: string; evidence: string[]; reliability: string };
  returnEvent: { gap_minutes: number; surface_match: string; return_confidence: string };
  uiPolicy: { surface: string; loudness: string; ask_feedback: boolean };
  outcomeTokens: string[];
  accepted: boolean;
  /** Set when the user switches away; cleared if they bounce back within
   *  RESUME_GAP_MS. The return only CLOSES once they've been away past the gap
   *  — so a 30s glance at another thread doesn't truncate the duration label
   *  (calibration showed time-to-first-switch collapses 95% of outcomes into
   *  the 2–5m band; that measures bounces, not work blocks). */
  leftAt?: number;
}

export interface WorkStateEngineOpts {
  senseBuffer: SenseBuffer;
  feedBuffer: FeedBuffer;
  embeddingService: EmbeddingService;
  memoryDir?: string;
  priorPath?: string;
  intervalMs?: number;
  log?: boolean;
  /** Called after each observation with the full view — wire to the overlay WS. */
  onUpdate?: (view: WorkStateView) => void;
}

export class WorkStateEngine {
  private readonly prior: PriorStore;
  private readonly corpus: ReturnCorpus; // Layer 2 retrieval over past returns
  private readonly sidModel = new SemanticIdModel(); // Layer 3 codebook
  private readonly seqModel = new SequenceModel(); // Layer 4 sequence stub
  private readonly senseBuffer: SenseBuffer;
  private readonly feedBuffer: FeedBuffer;
  private readonly embeddingService: EmbeddingService;
  private readonly intervalMs: number;
  private readonly doLog: boolean;
  private readonly memoryDir: string;
  private readonly onUpdate?: (view: WorkStateView) => void;
  private readonly extractorState: ExtractorState = { prevApp: "", appRunStart: Date.now() };
  private readonly policyCtx: PolicyContext = { lastRejectTs: 0 };
  /** Source of the current surface's region-threads (the existing `regionId`
   *  layer), nested under the active project-thread in the board (§9). Wired
   *  after the RegionTracker is constructed (see index.ts). */
  private regionSource?: () => RegionThreadLite[];
  /** Source of the "last work" snapshot (digest/hud/OCR/regions/errors) frozen
   *  at the switch-away breakpoint — the calibrated resume card's content. */
  private lastWorkSource?: () => Omit<LastWork, "ts"> | null;
  /** Monotonic count of thread switch-aways — interruptions-since for a cooled
   *  thread = switchCount − its switchCountAtLeave (a re-entry-cost driver). */
  private switchCount = 0;
  /** Open return events (one per thread), keyed by threadId — written complete
   *  on leave/dismiss. */
  private readonly pendingReturns = new Map<string, ReturnEvent>();
  private returnSeq = 0;
  /** Threads the user genuinely switched away from THIS session. A snapshot-
   *  restored thread re-attended at startup has a huge gap but was never left
   *  here — so it must NOT pop a "welcome back". Only members arm a resume. */
  private readonly leftThisSession = new Set<string>();

  private readonly threads = new Map<string, ThreadState>();
  private activeThreadId: string | null = null;
  /** When the CURRENT thread became the attended one — per-THREAD dwell.
   *  (App dwell is wrong here: switching windows within one app never resets
   *  it, which froze the previous thread's digest into the new thread.) */
  private activeSince = 0;
  private pendingId: string | null = null;
  private pendingCount = 0;
  // Latched the moment the user switches BACK to a cooled thread (a resume
  // breakpoint, §9) — drives the overlay's "Back to…" dashed marker. Cleared
  // when they act on it (feedback) or switch to a different thread.
  private resumeThreadId: string | null = null;
  /** The card is FROZEN at arm time — built once in noteReturnEvent and served
   *  unchanged until disarmed, so it can't mutate while the user reads it. */
  private armedResumeCard: ResumeCard | null = null;

  private timer: NodeJS.Timeout | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(opts: WorkStateEngineOpts) {
    this.senseBuffer = opts.senseBuffer;
    this.feedBuffer = opts.feedBuffer;
    this.embeddingService = opts.embeddingService;
    this.intervalMs = opts.intervalMs ?? 2500;
    this.doLog = opts.log ?? false;
    this.onUpdate = opts.onUpdate;
    const memoryDir = opts.memoryDir || process.env.SINAIN_MEMORY_DIR || join(homedir(), ".sinain", "memory");
    this.memoryDir = memoryDir;
    this.prior = new PriorStore(opts.priorPath || join(memoryDir, "workstate-prior.json"));
    this.corpus = new ReturnCorpus(join(memoryDir, "workstate-returns.jsonl"));
  }

  private embed: EmbedFn = async (text: string) => {
    if (!this.embeddingService.ready) return null;
    const out = await this.embeddingService.embed([text]);
    return out[0] ?? null;
  };

  start(): void {
    if (this.timer) return;
    const ok = this.prior.reload();
    this.loadSnapshot(); // restore the thread bank from the previous session
    this.activeSince = Date.now(); // digest can't be about ANY thread yet at boot
    console.log(
      `[wsm] engine started — prior ${ok ? `loaded (${this.prior.info?.topics.length} topics, ${this.prior.info?.factCount} facts)` : "NOT FOUND (run prior_builder.py)"}${this.threads.size ? `; restored ${this.threads.size} threads` : ""}`,
    );
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    this.snapshotTimer = setInterval(() => this.persistSnapshot(), 60_000);
    if (this.snapshotTimer.unref) this.snapshotTimer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.timer = null;
    this.snapshotTimer = null;
    // Flush the session: a snapshot for continuity + a session-end history
    // record per live thread for learning.
    const now = Date.now();
    for (const id of [...this.pendingReturns.keys()]) this.finalizeReturn(id, now); // flush open returns
    for (const t of this.threads.values()) this.appendHistory("session-end", t, now);
    this.persistSnapshot();
  }

  noteRejection(ts = Date.now()): void {
    this.policyCtx.lastRejectTs = ts;
  }

  /** Wire the within-surface region-threads (the `regionId` layer). The engine
   *  is constructed before the RegionTracker, so this is set afterwards; the
   *  source is read lazily per board render and only nested under the active
   *  project-thread (regions belong to the surface in focus, §9). */
  setRegionSource(fn: () => RegionThreadLite[]): void {
    this.regionSource = fn;
  }

  /** Wire the "last work" snapshot source (digest/hud/OCR/transcript/errors).
   *  Sampled each active tick into liveWork; frozen to lastWork on leave. */
  setLastWorkSource(fn: () => Omit<LastWork, "ts"> | null): void {
    this.lastWorkSource = fn;
  }

  /** Episode sink (DESIGN-MEMORY-V2 §3.8): breakpoint/return events flow into
   *  memoryd's T1 store — estimates earn their way into memory by becoming
   *  events. The engine stays fire-and-forget: memory owns what happened. */
  private episodeSink?: (ev: {
    kind: "breakpoint" | "return"; threadId: string; label: string;
    at: number; gapMs?: number; lastWork?: LastWork;
  }) => void;

  setEpisodeSink(fn: NonNullable<WorkStateEngine["episodeSink"]>): void {
    this.episodeSink = fn;
  }

  /** Roll the active thread's live snapshot. The global digest lags a thread
   *  switch, so only TRUST it once the user has dwelled long enough ON THIS
   *  THREAD for it to be about this thread (else null → the brief falls back to
   *  OCR/structured and a lower reliability, never a confident wrong claim).
   *  Thread dwell, not app dwell: the agent debounces ~6s + inference latency,
   *  so ~15s on-thread is the earliest the digest can describe it. OCR/regions
   *  are the live surface and are always current. */
  private snapshotLiveWork(t: ThreadState, _f: RawFeatures, now: number): void {
    const lw = this.lastWorkSource?.();
    if (!lw) return;
    const trustDigest = now - this.activeSince > 15_000;
    t.liveWork = { ts: now, ...lw, digest: trustDigest ? lw.digest : null };
  }

  /** Route one observation into the thread bank: estimate → decide → route. */
  async observe(features: RawFeatures, now = features.ts): Promise<void> {
    const vector = await estimate(features, this.prior, this.embed);
    const decision = decide(vector, features, this.policyCtx);

    // Thread identity is STRUCTURAL (repo / conversation / page / app), not a
    // fuzzy KG match — so one project = one stable thread, and brand-new work
    // isn't mislabeled onto the nearest stale topic. The KG match is only an
    // *enrichment* (sub-focus + friction), attached when confident (≥ ENRICH_MIN).
    // The NAME is the BEST-SIMILARITY match, and only above NAME_MIN — naming by
    // recurrence let a popular-but-tangential topic (e.g. "jcp-project" ×97)
    // hijack the label of a surface whose best match was the actual work.
    const matched = vector.matchedTopics ?? []; // estimator order: similarity desc
    const routeId = features.projectKey;
    const nameMatch = matched.length && matched[0].similarity >= NAME_MIN ? matched[0] : null;
    const routeLabel = nameMatch ? nameMatch.label : features.projectLabel;
    const kgContext = matched.length > 1
      ? matched.slice(1).map((t) => t.label).join(" · ")
      : null;

    // Hysteresis — a rival must persist HYSTERESIS_TICKS before we switch.
    let attended = this.activeThreadId;
    if (routeId !== this.activeThreadId) {
      if (routeId === this.pendingId) this.pendingCount++;
      else { this.pendingId = routeId; this.pendingCount = 1; }
      if (this.activeThreadId === null || this.pendingCount >= HYSTERESIS_TICKS) {
        const outgoing = this.activeThreadId && this.threads.get(this.activeThreadId);
        if (outgoing) {
          outgoing.breakpoints.push(now); // switch = a breakpoint for it
          this.appendHistory("switched-away", outgoing, now);
          // Freeze "last work" + the interruption baseline at the breakpoint.
          this.switchCount++;
          outgoing.switchCountAtLeave = this.switchCount;
          // Freeze where-you-left-off from the thread's OWN last active tick —
          // not a fresh read here (the global digest already lags the switch and
          // the surface is becoming the new thread). See DESIGN-WSM §3.
          if (outgoing.liveWork) outgoing.lastWork = outgoing.liveWork;
          this.episodeSink?.({
            kind: "breakpoint", threadId: outgoing.topicId,
            label: outgoing.label, at: now, lastWork: outgoing.lastWork,
          });
          this.leftThisSession.add(outgoing.topicId); // a genuine in-session leave
          // Don't close the open return yet — mark the leave and let the sweep
          // (or a bounce-back) decide whether this was an excursion or the end.
          const openRet = this.pendingReturns.get(outgoing.topicId);
          if (openRet && !openRet.leftAt) openRet.leftAt = now;
        }
        this.activeThreadId = routeId;
        this.activeSince = now; // per-thread dwell clock (digest trust latch)
        this.pendingId = null;
        this.pendingCount = 0;
        this.resumeThreadId = null; // switching threads supersedes a prior resume
        attended = routeId;
      }
    } else {
      this.pendingId = null;
      this.pendingCount = 0;
    }
    if (attended !== routeId) return; // mid-hysteresis: don't update yet

    // Update (or create) the attended thread.
    const cadenceMs = this.cadenceFor(vector.matchedTopic?.distinctDays ?? 0);
    const existing = this.threads.get(routeId);
    if (existing) {
      const gap = now - existing.lastAttendedTs;
      let justResumed = false;
      if (gap > RESUME_GAP_MS && this.leftThisSession.has(routeId)) {
        this.appendHistory("resumed", existing, now); // logs the gap
        this.resumeThreadId = routeId; // returned to a thread we actually left this session
        justResumed = true;
        this.episodeSink?.({
          kind: "return", threadId: routeId, label: existing.label,
          at: now, gapMs: gap,
        });
      } else {
        // Bounce-back within the gap: the excursion didn't end the open return —
        // clear the leave marker so the duration keeps accruing.
        const openRet = this.pendingReturns.get(routeId);
        if (openRet) delete openRet.leftAt;
      }
      existing.vector = vector;
      existing.decision = decision;
      existing.lastAttendedTs = now;
      existing.attendCount++;
      existing.cadenceMs = cadenceMs;
      if (nameMatch) existing.label = routeLabel; // refresh to KG name when strongly recognized
      existing.kgContext = kgContext ?? existing.kgContext; // keep last enrichment
      existing.trajectory.push(decision.assistValue);
      if (existing.trajectory.length > TRAJ_MAX) existing.trajectory.shift();
      if (justResumed) this.noteReturnEvent(existing, now); // open the §16 return-event record (uses FROZEN lastWork)
      this.snapshotLiveWork(existing, features, now); // ...then roll the live snapshot for the new active session
    } else {
      const created: ThreadState = {
        topicId: routeId, label: routeLabel, kgContext, cadenceMs,
        vector, decision, firstSeenTs: now, lastAttendedTs: now,
        attendCount: 1, trajectory: [decision.assistValue], breakpoints: [],
      };
      this.threads.set(routeId, created);
      this.appendHistory("created", created, now);
      this.snapshotLiveWork(created, features, now);
    }
    if (this.doLog) console.log(formatLine(vector, decision));
    this.onUpdate?.(this.getView(now));
  }

  /** Overlay accept/dismiss on an offer (P2 label channel). Dismiss opens the
   *  Athium backoff window; both append a label for future calibration. */
  recordFeedback(threadId: string, action: string, now = Date.now()): void {
    if (action === "dismiss") this.noteRejection(now);
    // Only accept/dismiss disarm the marker; useful/somewhat/not-useful are
    // pure calibration labels and leave the resume in place.
    if ((action === "accept" || action === "dismiss") && threadId === this.resumeThreadId) this.resumeThreadId = null;
    // Accrue outcome tokens onto the open return event (§16 tokens_after).
    const ev = this.pendingReturns.get(threadId);
    if (ev) {
      if (action === "accept") { ev.accepted = true; ev.outcomeTokens.push("CARD_OPENED", "CARD_ACCEPTED"); }
      else if (action === "dismiss") { ev.outcomeTokens.push("CARD_DISMISSED"); this.finalizeReturn(threadId, now); }
      else ev.outcomeTokens.push(`FEEDBACK_${action.toUpperCase().replace(/-/g, "_")}`);
    }
    const t = this.threads.get(threadId);
    const label = {
      ts: now, threadId, action,
      returnId: ev?.id ?? null, // exact join key to workstate-returns.jsonl
      label: t?.label ?? threadId,
      assistValue: t?.decision.assistValue ?? null,
      difficulty: t?.vector.difficulty.value ?? null,
      stuckness: t?.vector.stuckness.value ?? null,
      staleness: t ? Math.min(1, (now - t.lastAttendedTs) / t.cadenceMs) : null,
    };
    try {
      appendFileSync(join(this.memoryDir, "workstate-labels.jsonl"), JSON.stringify(label) + "\n");
    } catch { /* best-effort */ }
  }

  private cadenceFor(distinctDays: number): number {
    const span = this.prior.info?.spanDays ?? 0;
    if (distinctDays > 0 && span > 0) return Math.max(1, span / distinctDays) * 24 * 3_600_000;
    return DEFAULT_CADENCE_MS;
  }

  /** The active thread's raw vector + decision (console / back-compat). */
  getCurrent(): { vector: WorkStateVector; decision: AthiumDecision } | null {
    const t = this.activeThreadId && this.threads.get(this.activeThreadId);
    return t ? { vector: t.vector, decision: t.decision } : null;
  }

  /** Full view: active thread + the attention-ranked board. */
  getView(now = Date.now()): WorkStateView {
    return {
      activeThreadId: this.activeThreadId,
      active: this.getCurrent(),
      board: this.getBoard(now),
      resumeThreadId: this.resumeThreadId,
      resumeCard: this.resumeThreadId ? this.armedResumeCard : null, // frozen at arm
    };
  }

  /** The return-situation feature snapshot (Layer 1 input) — shared by the card
   *  heads and the behavioral tokenizer. All from the durable ThreadState. */
  private returnFeatures(t: ThreadState, now: number): ReturnFeatures {
    const lw = t.lastWork;
    const leaveTs = lw?.ts ?? t.lastAttendedTs;
    const regions = lw?.regions ?? [];
    const diff = t.vector.difficulty.value;
    // Checkable evidence ONLY — an error claim needs a captured error marker,
    // never the difficulty score (friction alone must not say "left with errors").
    const hasError = (lw?.errorReasons?.length ?? 0) > 0;
    // "agent outputs" = genuine background-agent deliverables (OpenClaw/spawn
    // results), NOT the analyzer's ambient HUD recap, which is also pushed with
    // source "agent" every tick. Counting the latter inflated the number into
    // the dozens and leaked HUD-digest prose into "changed while away".
    const agentOutputs = this.feedBuffer
      .query(0)
      .filter((f) => f.source === "openclaw" && f.ts > leaveTs).length;
    const ageMs = now - t.firstSeenTs;
    return {
      threadId: t.topicId, label: t.label, app: t.vector.app,
      gapMinutes: Math.round((now - leaveTs) / 60_000),
      // Clamped: switchCount resets each session while switchCountAtLeave is
      // restored from the snapshot — an unclamped diff goes negative.
      interruptions: t.switchCountAtLeave ? Math.max(0, this.switchCount - t.switchCountAtLeave) : 0,
      agentOutputs, attendCount: t.attendCount, ageMs, trajectoryLen: t.trajectory.length,
      difficulty: diff, hasError, openRegions: regions.length,
      frozen: !!lw && !!(lw.digest || lw.ocrLines.length || regions.length),
      roiEngaged: regions.length, unresolved: regions.length > 0 || hasError,
      longThread: t.attendCount >= 8 || ageMs > 2 * 3_600_000 || t.trajectory.length >= 8,
      topicAffinity: t.vector.topicAffinity.value, recurrence: t.vector.matchedTopic?.recurrence ?? 0,
      surfaceMatch: "same_project", returnConfidence: "high",
    };
  }

  /** Calibrated Resume Card (P5) — deterministic heads from per-thread signals
   *  (no ML). Predictions choose timing/shape; every surfaced claim is backed by
   *  evidence. See docs/DESIGN-WSM-SIGNAL-INVENTORY.md §6. */
  buildResumeCard(threadId: string, now = Date.now()): ResumeCard | null {
    const t = this.threads.get(threadId);
    if (!t) return null;
    const f = this.returnFeatures(t, now);
    const lw = t.lastWork;
    const regions = lw?.regions ?? [];

    // ── reentry_cost (additive, interpretable) → tier ─────────────────────────
    let score = 0;
    const drivers: string[] = [];
    const reducers: string[] = [];
    if (f.longThread) { score++; drivers.push("long thread"); }
    if (f.interruptions >= 3) { score++; drivers.push(`${f.interruptions} interruptions since`); }
    else if (f.interruptions > 0) drivers.push(`${f.interruptions} interruption${f.interruptions > 1 ? "s" : ""} since`);
    if (f.unresolved) { score++; drivers.push(f.hasError ? "left with a blocker on screen" : `${f.openRegions} open issue${f.openRegions > 1 ? "s" : ""} at leave`); }
    if (f.agentOutputs > 0) { score++; drivers.push(`${f.agentOutputs} agent output${f.agentOutputs > 1 ? "s" : ""}`); }
    if (f.frozen) { score--; reducers.push("snapshot exists"); }
    if (f.roiEngaged > 0) { score--; reducers.push(`ROI engaged${f.roiEngaged > 1 ? ` ${f.roiEngaged}×` : ""}`); }
    const reentryTier: ResumeCard["reentryTier"] = score >= 3 ? "high" : score >= 1 ? "medium" : "low";

    // ── estimated_focus_time → band — heuristic, then Layer 5 calibration: let
    //    actual outcomes of similar past returns override it when well-supported.
    const heuristicBand = bandForTier(reentryTier, f.longThread);
    const retrieval = this.corpus.retrieve(workStateTokens(f));
    const fused = fuseBand(heuristicBand, retrieval);
    const focusBand = { label: fused.band.label, display: fused.band.display };
    if (fused.fromData) reducers.push(`${retrieval.qualifiedN} similar returns`);

    // ── actual context from the frozen snapshot (file/window, open ROI, agent
    //    output text) — load it into the brief + actions instead of placeholders.
    const topRegion = regions[0];
    const winShort = clip((t.vector.windowTitle ?? "").split(/\s+[—–|]\s+/)[0], 38);
    const ocr0 = lw?.ocrLines.find((l) => l.length > 8) ?? null;
    const leaveTs = lw?.ts ?? t.lastAttendedTs;
    const agentText = this.feedBuffer.query(0)
      .filter((x) => x.source === "openclaw" && x.ts > leaveTs)
      .slice(-1)[0]?.text ?? null;

    // ── next_likely_action → top-k (closed vocab; labels carry real context) ──
    const cand: NextAction[] = [];
    if (f.hasError) cand.push({ action: "fix_blocker", label: clip(`Fix: ${topRegion?.issue ?? lw?.errorReasons[0] ?? winShort ?? "the error"}`, 46) });
    if (topRegion) cand.push({ action: "continue_implementation", label: clip(`Continue: ${topRegion.issue}`, 46) });
    else if (winShort) cand.push({ action: "continue_implementation", label: clip(`Continue ${winShort}`, 46) });
    if (f.agentOutputs > 0) cand.push({ action: "review_agent_output", label: `Review ${f.agentOutputs} agent output${f.agentOutputs > 1 ? "s" : ""}` });
    if (f.difficulty >= 0.45 && (topRegion || t.kgContext)) cand.push({ action: "make_decision", label: clip(`Decide: ${topRegion?.issue ?? t.kgContext}`, 46) });
    if (winShort) cand.push({ action: "read", label: clip(`Re-read ${winShort}`, 46) });
    cand.push({ action: "continue_implementation", label: winShort ? clip(`Continue ${winShort}`, 46) : "Continue where you left off" });
    cand.push({ action: "summarize_defer", label: "Note where you are & defer" });
    const seen = new Set<string>();
    const nextActions = cand.filter((a) => !seen.has(a.action) && seen.add(a.action)).slice(0, 3);

    // ── resume_brief (real content: digest → open issue → file+OCR → structured)
    const digestProse = cleanProse(lw?.digest);
    const reliability: ResumeCard["reliability"] = digestProse ? "good" : (topRegion || ocr0 || winShort) ? "medium" : "low";
    const gist = digestProse
      ? firstSentence(digestProse)
      : topRegion
        ? `on “${clip(topRegion.issue, 70)}”`
        : winShort
          ? `in ${winShort}${ocr0 ? ` — “${clip(ocr0, 56)}”` : ""}`
          : `${t.vector.activity} in ${t.vector.app}`;
    const brief =
      reliability === "good" ? `You likely left off — ${gist}.`
      : reliability === "medium" ? `Looks like you left off ${gist}.`
      : `Possible resume point. This may relate to ${t.label}. Verify before continuing.`;

    // ── changed while away (the actual agent output, when present) ─────────────
    const changedWhileAway = f.agentOutputs > 0
      ? `${f.agentOutputs} agent output${f.agentOutputs > 1 ? "s" : ""} arrived${agentText ? `: “${clip(agentText, 72)}”` : ""}.${f.hasError ? " A blocker may need attention." : ""}`
      : null;

    // ── continuation_probability → loudness (INTERNAL; never shown). Retrieval's
    //    observed continuation rate sets it when trusted, else the heuristic. ───
    const loudness: ResumeCard["loudness"] = reliability === "low"
      ? "low"
      : loudnessFromRetrieval(retrieval) ??
        (reentryTier === "high" ? "full" : reentryTier === "medium" ? "compact" : "quiet");

    return {
      threadId, label: t.label, brief, reliability, reentryTier,
      drivers, reducers, focusBand, nextActions, changedWhileAway, loudness,
    };
  }

  /** Compose the seed + directive for "Resume thread → open sinain chat": the
   *  thread's frozen re-entry context (where you left off, the work snapshot,
   *  what changed while away, likely next steps) preloaded so the resident chat
   *  lane can nudge the user back in rather than cold-starting. */
  buildResumeChatSeed(threadId: string, now = Date.now()):
    { seed: string; directive: string; label: string } | null {
    const t = this.threads.get(threadId);
    if (!t) return null;
    const card = this.buildResumeCard(threadId, now);
    if (!card) return null;
    const lw = t.lastWork;

    const lines: string[] = [`[Resuming thread: ${t.label}]`];
    if (t.kgContext) lines.push(`Focus: ${t.kgContext}`);
    lines.push(`Where you left off: ${card.brief}`);
    const digest = cleanProse(lw?.digest);
    if (digest) lines.push(`Last working context: ${clip(digest, 400)}`);
    const regions = lw?.regions ?? [];
    if (regions.length) {
      lines.push("Open items at leave:");
      for (const r of regions.slice(0, 4)) {
        lines.push(`  • ${clip(r.issue, 100)}${r.tip ? ` — ${clip(r.tip, 80)}` : ""}`);
      }
    }
    if (lw?.errorReasons?.length) {
      lines.push(`Blockers: ${lw.errorReasons.slice(0, 3).map((e) => clip(e, 80)).join("; ")}`);
    }
    const ocr = (lw?.ocrLines ?? []).filter((l) => l.length > 8).slice(0, 4);
    if (ocr.length) lines.push(`On screen at leave: ${ocr.map((l) => clip(l, 80)).join(" | ")}`);
    if (lw?.transcriptTail) lines.push(`Last heard: ${clip(lw.transcriptTail, 160)}`);
    if (card.changedWhileAway) lines.push(`Changed while away: ${card.changedWhileAway}`);
    if (card.nextActions.length) {
      lines.push("Likely next steps:");
      card.nextActions.forEach((a, i) => lines.push(`  ${i + 1}. ${a.label}`));
    }

    const seed = lines.join("\n");
    const directive =
      "I'm back on this thread after a break. Using the re-entry context above, " +
      "give me a short, concrete nudge to pick it back up: one line on where I was, " +
      "anything that changed while I was away, and the single best next step. Keep it tight.";
    return { seed, directive, label: t.label };
  }

  /** Open a return-event record (§16) the instant a resume arms: tokens_before
   *  (the situation) + the card's prediction + ui policy. Held until the user
   *  leaves/dismisses, then written complete with tokens_after. */
  private noteReturnEvent(t: ThreadState, now: number): void {
    // A prior return for this thread may still be open (lazy close) — finalize
    // it at its recorded leave time before opening the new one.
    this.finalizeReturn(t.topicId, now);
    const f = this.returnFeatures(t, now);
    const card = this.buildResumeCard(t.topicId, now);
    if (!card) return;
    this.armedResumeCard = card; // freeze it for the lifetime of this resume
    const band = bandForTier(card.reentryTier, f.longThread);
    const tokensBefore = workStateTokens(f);
    // Fit L3/L4 from the corpus (mtime-cached, no-op when unchanged) + annotate.
    const rows = this.corpus.getRows();
    this.sidModel.fit(rows, this.corpus.mtime());
    this.seqModel.fit(rows, this.corpus.mtime());
    this.returnSeq++;
    this.pendingReturns.set(t.topicId, {
      id: `ret-${now.toString(36)}-${this.returnSeq}`,
      threadId: t.topicId, ts: now,
      tokensBefore,
      retrieval: this.corpus.retrieve(tokensBefore), // k-NN over PAST returns (candidate only)
      semanticId: this.sidModel.assign(tokensBefore), // L3 codebook entry
      sequencePrediction: this.seqModel.predict(tokensBefore), // L4 next-token (analysis only)
      prediction: {
        reentry_cost: card.reentryTier,
        duration_band: band.code,
        next_actions: card.nextActions.map((a) => a.action),
        support_mode: supportMode(card.loudness),
        confidence_tier: card.reliability,
      },
      latents: {
        difficulty: t.vector.difficulty.value,
        stuckness: t.vector.stuckness.value,
        topicAffinity: t.vector.topicAffinity.value,
        focusStability: t.vector.focusStability.value,
      },
      brief: { claim: card.brief, evidence: [...card.drivers, ...card.reducers], reliability: card.reliability },
      returnEvent: { gap_minutes: f.gapMinutes, surface_match: f.surfaceMatch, return_confidence: f.returnConfidence },
      uiPolicy: { surface: supportMode(card.loudness), loudness: card.loudness, ask_feedback: true },
      outcomeTokens: ["CARD_SHOWN"],
      accepted: false,
    });
  }

  /** Close an open return event (away past the gap / dismiss / shutdown):
   *  stamp the duration outcome and write the complete record — the joined
   *  training row. Duration ends at the recorded leave (`leftAt`), so brief
   *  excursions don't truncate it; a close with no leave marker (shutdown) is
   *  right-censored and flagged as such. */
  private finalizeReturn(threadId: string, now: number): void {
    const ev = this.pendingReturns.get(threadId);
    if (!ev) return;
    this.pendingReturns.delete(threadId);
    const end = ev.leftAt ?? now;
    const censored = ev.leftAt === undefined; // never saw a real leave
    const activeMin = Math.max(0, (end - ev.ts) / 60_000);
    if (!ev.outcomeTokens.includes("CARD_DISMISSED")) {
      ev.outcomeTokens.push(continuationToken(activeMin, ev.accepted));
    }
    const rec = {
      // schema 2: semantic-sourced STATE tokens (no OCR keyword matching),
      // return_id (label join key), latents, excursion-tolerant durations +
      // censored flag. Schema-1 rows carry regex-inflated STATE_UNRESOLVED_ERROR
      // and bounce-truncated durations — calibration segments on this.
      schema: 2,
      event_type: "thread_return",
      return_id: ev.id,
      thread_id: ev.threadId,
      timestamp: new Date(ev.ts).toISOString(),
      latents: ev.latents,
      return_event: ev.returnEvent,
      tokens_before: ev.tokensBefore,
      semantic_ids: ev.semanticId, // Layer 3
      resume_brief: ev.brief,
      calibrated_prediction: ev.prediction,
      retrieval: ev.retrieval, // Layer 2 candidate (k-NN over past returns; not yet driving the card)
      sequence_prediction: ev.sequencePrediction, // Layer 4 stub (analysis only)
      ui_policy: ev.uiPolicy,
      tokens_after: ev.outcomeTokens,
      observed: {
        active_minutes: Math.round(activeMin * 10) / 10,
        active_band: bandForMinutes(activeMin).code,
        accepted: ev.accepted,
        // A "real" return, not a sub-2-min bounce (test-gap artifact). Training
        // filters on this rather than dropping the negatives outright.
        qualified: ev.returnEvent.gap_minutes >= 2,
        // Closed without ever seeing a leave (session shutdown) — the true
        // duration is longer than measured; duration training must skip these.
        censored,
        closed_at: new Date(now).toISOString(),
      },
    };
    try {
      appendFileSync(join(this.memoryDir, "workstate-returns.jsonl"), JSON.stringify(rec) + "\n");
    } catch { /* best-effort */ }
  }

  /** Clear a thread's KG enrichment when its topic no longer exists in the prior
   *  (e.g. an umbrella got filtered out) so stale labels don't linger on cooled
   *  threads. The thread re-enriches with a fresh match next time it's attended. */
  private validateEnrichment(): void {
    const labels = new Set(this.prior.info?.topics.map((t) => t.label) ?? []);
    if (labels.size === 0) return;
    for (const t of this.threads.values()) {
      if (!t.kgContext) continue;
      const kept = t.kgContext.split(" · ").filter((l) => labels.has(l));
      t.kgContext = kept.length ? kept.join(" · ") : null;
    }
  }

  private snapshotPath(): string {
    return join(this.memoryDir, "workstate-threads.json");
  }

  /** B — continuity: restore the thread bank from the previous session so the
   *  board survives restarts and the resumption card can show where you left off. */
  private loadSnapshot(): void {
    try {
      const p = this.snapshotPath();
      if (!existsSync(p)) return;
      const data = JSON.parse(readFileSync(p, "utf-8")) as {
        activeThreadId: string | null;
        threads: ThreadState[];
      };
      for (const t of data.threads ?? []) this.threads.set(t.topicId, t);
      this.activeThreadId = data.activeThreadId ?? null;
    } catch {
      /* corrupt/missing → start fresh */
    }
  }

  /** B — snapshot the live thread bank (atomic write). Periodic + on shutdown. */
  private persistSnapshot(): void {
    try {
      const data = {
        savedAt: Date.now(),
        activeThreadId: this.activeThreadId,
        threads: [...this.threads.values()],
      };
      const tmp = this.snapshotPath() + ".tmp";
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, this.snapshotPath());
    } catch {
      /* best-effort */
    }
  }

  /** A — learning substrate: append a thread-lifecycle record (created /
   *  switched-away / resumed / session-end) with the work-state + trajectory.
   *  This is the {predicted → realized} dataset the calibration loop trains on. */
  private appendHistory(event: string, t: ThreadState, now: number): void {
    const rec = {
      ts: now, event, threadId: t.topicId, label: t.label, kgContext: t.kgContext,
      activity: t.vector.activity, ageMs: now - t.lastAttendedTs,
      attendCount: t.attendCount, cadenceMs: t.cadenceMs,
      assistValue: t.decision.assistValue, difficulty: t.vector.difficulty.value,
      stuckness: t.vector.stuckness.value, action: t.decision.action,
      trajectory: t.trajectory.slice(), firstSeenTs: t.firstSeenTs,
      lastAttendedTs: t.lastAttendedTs,
    };
    try {
      appendFileSync(join(this.memoryDir, "workstate-history.jsonl"), JSON.stringify(rec) + "\n");
    } catch {
      /* best-effort */
    }
  }

  getBoard(now = Date.now()): ThreadBoardEntry[] {
    const board: ThreadBoardEntry[] = [];
    for (const t of this.threads.values()) {
      const ageMs = now - t.lastAttendedTs;
      const staleness = clamp01(ageMs / t.cadenceMs);
      const temperature = Math.exp(-ageMs / TEMP_HALFLIFE_MS);
      const assistValue = t.decision.assistValue;
      const difficulty = t.vector.difficulty.value;
      // needScore: RELIABLE staleness + PARTIAL assist/difficulty. stuckness is
      // carried for display but NOT scored (ASPIRATIONAL — honesty rule §4).
      const needScore = clamp01(0.4 * staleness + 0.35 * assistValue + 0.25 * difficulty);
      const isActive = t.topicId === this.activeThreadId;
      board.push({
        topicId: t.topicId, label: t.label, activity: t.vector.activity,
        isActive, kgContext: t.kgContext,
        needScore, staleness, temperature, assistValue, difficulty,
        stuckness: t.vector.stuckness.value, ageMs, attendCount: t.attendCount,
        action: t.decision.action, trajectory: t.trajectory.slice(), why: t.decision.why,
        // Region-threads nest under the active project-thread only (§9).
        regions: isActive ? this.regionSource?.() : undefined,
      });
    }
    return board.sort((a, b) => b.needScore - a.needScore);
  }

  getPriorInfo(): unknown {
    const mdl = this.prior.info;
    return mdl && { builtAt: mdl.builtAt, factCount: mdl.factCount, topics: mdl.topics.length, globalReturnRate: mdl.globalReturnRate, activityBaseRates: mdl.activityBaseRates };
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.prior.reload();
      this.validateEnrichment(); // clear kgContext for topics the prior dropped
      // Lazy-close sweep: a return whose thread has been left for longer than
      // the resume gap is over — finalize it at its leave time.
      const sweepNow = Date.now();
      for (const [id, ev] of this.pendingReturns) {
        if (ev.leftAt && sweepNow - ev.leftAt > RESUME_GAP_MS) this.finalizeReturn(id, sweepNow);
      }
      // Region ids feed the repeated-same-issue signal (semantic recurrence).
      const regionIds = (this.regionSource?.() ?? []).map((r) => r.id);
      const features = buildRawFeatures(this.senseBuffer, this.feedBuffer, this.extractorState, Date.now(), regionIds);
      if (features) await this.observe(features);
    } catch (err) {
      console.warn("[wsm] tick error:", (err as Error).message);
    } finally {
      this.ticking = false;
    }
  }
}

/** Reject digests that are raw JSON / code (parse-failure fallbacks) so they
 *  never leak into the brief prose — the card falls back to OCR/structured. */
function cleanProse(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (!t || /^[{[]/.test(t) || /"\s*:\s*["{[]/.test(t) || /\b(hud|digest|regions)\s*"\s*:/.test(t)) return null;
  const cleaned = t.replace(/[{}]/g, "").replace(/^["'`]+|["'`]+$/g, "").trim();
  return cleaned.length > 3 ? cleaned : null;
}

/** Collapse whitespace + cap length with an ellipsis — for card field content. */
function clip(s: string | null | undefined, n: number): string {
  const t = (s ?? "").trim().replace(/\s+/g, " ");
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}

/** First sentence (or a trimmed clause), capped — the brief's gist from a digest. */
function firstSentence(text: string): string {
  const s = text.trim().replace(/\s+/g, " ");
  const m = s.match(/^(.*?[.!?])(\s|$)/);
  const out = (m ? m[1] : s).replace(/[.!?]+$/, "");
  return out.length > 140 ? out.slice(0, 139).trimEnd() + "…" : out;
}

function bar(v: number): string {
  const n = Math.round(v * 5);
  return "▓".repeat(n) + "░".repeat(5 - n);
}

export function formatLine(v: WorkStateVector, d: AthiumDecision): string {
  const topic = v.matchedTopic
    ? `◆ "${v.matchedTopic.label}" sim ${v.matchedTopic.similarity.toFixed(2)} ×${v.matchedTopic.recurrence}`
    : "◇ no topic";
  return (
    `[wsm] ${v.activity}·${v.app.slice(0, 14).padEnd(14)} ` +
    `focus${bar(v.focusStability.value)} avail${bar(v.availability.value)} ` +
    `${topic}  diff ${v.difficulty.value.toFixed(2)} ` +
    `→ ${d.action} (v${d.assistValue.toFixed(2)} c${d.interruptCost.toFixed(2)})`
  );
}

const SPARK = "▁▂▃▄▅▆▇█";
export function sparkline(xs: number[]): string {
  if (!xs.length) return "";
  return xs.map((x) => SPARK[Math.min(SPARK.length - 1, Math.max(0, Math.round(x * (SPARK.length - 1))))]).join("");
}
