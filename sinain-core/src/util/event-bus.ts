import { EventEmitter } from "node:events";
import type { AgentEntry, ContextWindow } from "../types.js";

/**
 * Domain-generic events emitted by sinain-core. Optional agent modules
 * (currently just openclaw, future bridges to other gateways) subscribe
 * to these instead of being wired directly into Escalator. The contract
 * here is the only stable surface modules can rely on.
 */
export interface CoreEvents {
  /** An escalation has been routed to an agent. Modules whose roster
   *  matches `agent` should run their delivery (WS, HTTP, etc). */
  "escalation:dispatched": {
    entry: AgentEntry;
    contextWindow: ContextWindow;
    message: string;
    agent: string;
  };

  /** User typed a direct message in the overlay command input. */
  "user:direct": { text: string; ts: number };

  /** Periodic feedback summary ready for forwarding to long-running agents. */
  "feedback:periodic": { summary: string; lastNTicks: number };

  /** Agent loop completed an analysis tick. Used by SITUATION.md writers
   *  and other context consumers. */
  "tick:complete": { entry: AgentEntry };
}

export interface CoreEventBus {
  on<K extends keyof CoreEvents>(
    event: K,
    listener: (payload: CoreEvents[K]) => void,
  ): () => void;
  emit<K extends keyof CoreEvents>(event: K, payload: CoreEvents[K]): void;
  removeAllListeners(): void;
}

class TypedEventBus implements CoreEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Default Node limit (10) is too low for a long-running bus with many
    // subscribers across the lifetime of the process. Disable the warning;
    // we control the listener set internally.
    this.emitter.setMaxListeners(0);
  }

  on<K extends keyof CoreEvents>(
    event: K,
    listener: (payload: CoreEvents[K]) => void,
  ): () => void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return () => this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof CoreEvents>(event: K, payload: CoreEvents[K]): void {
    this.emitter.emit(event, payload);
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}

export function createCoreEventBus(): CoreEventBus {
  return new TypedEventBus();
}
