import { log, warn } from "../log.js";
import type { OpenClawWsClient } from "./openclaw-ws.js";
import type { OpenClawConfig } from "../types.js";

const TAG = "escalation-slot";

export interface QueueFeedbackCtx {
  tickId: number;
  hud: string;
  currentApp: string;
  escalationScore: number;
  escalationReasons: string[];
  codingContext: boolean;
  digest: string;
}

export interface SlotEntry {
  /** sha256(sessionKey + ts).hex[:16] — idempotency key */
  id: string;
  message: string;
  sessionKey: string;
  feedbackCtx: QueueFeedbackCtx | undefined;
  ts: number;
}

export interface EscalationSlotCallbacks {
  onResponse: (result: any, entry: SlotEntry, latencyMs: number) => void;
  onPhase1Failure: (isTimeout: boolean) => void;
  onOutboundBytes: (n: number) => void;
}

/**
 * Two-slot escalation buffer: latest-wins.
 *
 * Invariants:
 *   - Depth is always 0, 1, or 2
 *   - inFlight: the entry currently in Phase 1 or Phase 2
 *   - latest: the next entry to send (replaced on insert — stale context is discarded)
 *   - Phase 1 retry re-sends `latest` (not the stale failed entry)
 *   - Phase 2 always resolves — both .then and .catch clear inFlight and tryAdvance
 */
export class EscalationSlot {
  private inFlight: SlotEntry | null = null;
  private latest: SlotEntry | null = null;

  constructor(
    private readonly wsClient: OpenClawWsClient,
    private readonly config: OpenClawConfig,
    private readonly callbacks: EscalationSlotCallbacks,
  ) {}

  /** Replace latest with the new entry (discarding any previous unsent entry). */
  insert(entry: SlotEntry): void {
    this.latest = entry;
    log(TAG, `insert id=${entry.id} depth=${this.depth} (inFlight=${this.inFlight?.id ?? "none"})`);
    this.tryAdvance();
  }

  /** Called on WS reconnect — attempt to send the pending latest entry. */
  onConnected(): void {
    this.tryAdvance();
  }

  /** Current slot depth: 0 (idle), 1 (in-flight only or latest only), or 2 (both). */
  get depth(): number {
    return (this.inFlight ? 1 : 0) + (this.latest ? 1 : 0);
  }

  get inFlightId(): string | null {
    return this.inFlight?.id ?? null;
  }

  // ── Private ──

  /**
   * Promote latest → inFlight and send, if preconditions are met.
   * No-op if already in-flight, nothing queued, or WS disconnected.
   */
  private tryAdvance(): void {
    if (this.inFlight || !this.latest || !this.wsClient.isConnected) return;
    const entry = this.latest;
    this.latest = null;
    this.inFlight = entry;
    this.sendToAgent(entry);
  }

  /**
   * Two-phase delivery for the given entry.
   *
   * Phase 1: await acceptedPromise (30s timeout)
   *   success → log, Phase 2 runs async
   *   failure → clear inFlight, call onPhase1Failure, schedule retry via tryAdvance
   *
   * Phase 2: async .then/.catch on finalPromise
   *   resolve → call onResponse, clear inFlight, tryAdvance
   *   reject  → if Phase 1 succeeded (pure Phase 2 failure): clear inFlight, tryAdvance
   *             if Phase 1 failed: cleanup already done above — skip
   */
  private sendToAgent(entry: SlotEntry): void {
    const rpcStart = Date.now();
    this.callbacks.onOutboundBytes(Buffer.byteLength(entry.message));

    const { acceptedPromise, finalPromise } = this.wsClient.sendAgentRpcSplit(
      entry.message, entry.id, entry.sessionKey,
    );

    // Track whether Phase 1 resolved so finalPromise.catch can distinguish causes
    let phase1Succeeded = false;

    acceptedPromise.then(() => {
      phase1Succeeded = true;
      log(TAG, `Phase 1 accepted id=${entry.id} (${Date.now() - rpcStart}ms) — slot releasing`);
    }).catch((phase1Err: any) => {
      const isTimeout = /phase1 timeout|rpc timeout/i.test(phase1Err.message);
      warn(TAG, `Phase 1 failed id=${entry.id}: ${phase1Err.message}`);
      this.callbacks.onPhase1Failure(isTimeout);
      this.inFlight = null;
      // Retry picks up latest (not the stale failed entry) after brief backoff
      setTimeout(() => this.tryAdvance(), 5_000);
    });

    finalPromise.then((result: any) => {
      this.callbacks.onResponse(result, entry, Date.now() - rpcStart);
      this.inFlight = null;
      this.tryAdvance();
    }).catch((err: any) => {
      if (phase1Succeeded) {
        // Pure Phase 2 failure — Phase 1 already logged; Phase 1 path did not clean up
        warn(TAG, `Phase 2 failed id=${entry.id}: ${err.message} — clearing slot`);
        this.inFlight = null;
        this.tryAdvance();
      }
      // else: Phase 1 failed → acceptedPromise.catch already cleared inFlight and scheduled retry
    });
  }
}
