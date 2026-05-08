import { OpenClawWsClient } from "./ws-client.js";
import { EscalationSlot, type SlotEntry } from "./escalation-slot.js";
import type { OpenClawConfig } from "../../types.js";
import { log } from "../../log.js";

const TAG = "openclaw-module";

/**
 * Callbacks the module surfaces to its host (Escalator). The module
 * doesn't know what the host does with these — it just relays slot
 * lifecycle events. Keeping these as deps (instead of EventEmitter
 * style) so the host's call sites stay synchronous and direct.
 */
export interface OpenClawModuleDeps {
  config: OpenClawConfig;
  onResponse: (result: unknown, entry: SlotEntry, latencyMs: number) => void;
  onPhase1Failure: (isTimeout: boolean) => void;
  onOutboundBytes: (n: number) => void;
}

/**
 * Public interface of the OpenClaw agent module. Lifecycle is gated by
 * the host: start() is called when a gateway-typed profile becomes the
 * selected agent on at least one lane; stop() is called when the user
 * moves off every gateway lane. Between stop() and the next start(),
 * `wsClient` and `slot` return null — host code must null-check.
 *
 * This is the only thing escalator/index.ts should import from the
 * module. The internal classes (OpenClawWsClient, EscalationSlot) are
 * implementation detail.
 */
export interface OpenClawModule {
  start(): void;
  stop(): void;
  isActive(): boolean;
  /** Live WS client when active; null otherwise. */
  readonly wsClient: OpenClawWsClient | null;
  /** Live escalation slot when active; null otherwise. */
  readonly slot: EscalationSlot | null;
}

/**
 * Construct an inactive OpenClaw module. Resources (WS socket, slot
 * buffer, reconnect timer) are NOT allocated until start() runs. A
 * module that's never started costs essentially nothing — a few closure
 * fields and the deps reference.
 */
export function createOpenClawModule(deps: OpenClawModuleDeps): OpenClawModule {
  let wsClient: OpenClawWsClient | null = null;
  let slot: EscalationSlot | null = null;
  let active = false;

  return {
    start(): void {
      if (active) return;
      log(TAG, `starting (wsUrl=${deps.config.gatewayWsUrl || "<empty>"})`);
      wsClient = new OpenClawWsClient(deps.config);
      slot = new EscalationSlot(wsClient, deps.config, {
        onResponse: deps.onResponse,
        onPhase1Failure: deps.onPhase1Failure,
        onOutboundBytes: deps.onOutboundBytes,
      });
      // Re-attempt slot delivery on every WS reconnect.
      wsClient.on("connected", () => slot?.onConnected());
      wsClient.connect();
      active = true;
    },

    stop(): void {
      if (!active) return;
      log(TAG, "stopping");
      wsClient?.disconnect();
      wsClient = null;
      slot = null;
      active = false;
    },

    isActive(): boolean {
      return active;
    },

    get wsClient() { return wsClient; },
    get slot() { return slot; },
  };
}

// Re-export types host code needs
export type { OpenClawWsClient } from "./ws-client.js";
export type { EscalationSlot, SlotEntry, QueueFeedbackCtx } from "./escalation-slot.js";
