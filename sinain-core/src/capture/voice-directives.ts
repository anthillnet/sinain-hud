import { log, warn } from "../log.js";

const TAG = "voice-dir";

/**
 * Desktop directives from a live ARSinain voice session ("Talk to Sinain").
 *
 * The cloud brain emits MEMORY:/REMEMBER:/HANDOFF: lines mid-reply (same
 * interception pattern as its SEARCH: directive); the call engine (ar-bridge
 * or the webview page) relays them from the meta datachannel to
 * POST /voice/directive, and this module executes them against the local
 * harness. Results ride back up the channel; the cloud speaks them.
 *
 * The executor is deliberately deterministic — no LLM here. Raw memory data
 * goes back to the cloud, which owns speech phrasing; only confirmations
 * with locally-known context (handoff target) return a ready-to-speak `say`.
 */

export interface DirectiveRequest {
  /** Correlation id, echoed back by the relay. Opaque to core. */
  id?: number | string;
  /** "memory" | "remember" | "handoff" */
  name: string;
  /** Directive argument: query, fact, or task text. */
  arg: string;
  /** Recent call transcript (handoff seed), sent by the cloud. */
  transcript?: string;
}

export interface DirectiveResult {
  ok: boolean;
  /** Speak this verbatim (deterministic confirmations). */
  say?: string;
  /** Raw payload for the cloud to phrase into speech. */
  data?: unknown;
  error?: string;
}

export interface DirectiveDeps {
  /** This core's own HTTP base (loopback self-calls, same surface the
   *  chat-agent tool pack uses). */
  coreUrl: string;
  /** Fork a call-handoff thread seeded with the call transcript and route
   *  the task to the chat lane. Returns the display label of the agent that
   *  got it (for the spoken confirmation). */
  createHandoff: (task: string, transcript: string, agentHint?: string) => { threadId: string; agentLabel: string };
}

const FETCH_TIMEOUT_MS = 8_000;
/** Keep datachannel payloads speech-sized, not dump-sized. */
const MAX_DATA = 2_400;

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  return await r.json();
}

/** Leading "to <agent>:" or "to <agent> —" names a handoff target. */
const AGENT_HINT = /^to\s+([\w .-]{1,40}?)\s*[:—-]\s*/i;

export async function execDirective(req: DirectiveRequest, deps: DirectiveDeps): Promise<DirectiveResult> {
  const arg = (req.arg || "").trim();
  const name = (req.name || "").toLowerCase();
  log(TAG, `${name}: "${arg.slice(0, 80)}"`);
  try {
    switch (name) {
      case "memory": {
        if (!arg) return { ok: false, error: "empty query" };
        const q = encodeURIComponent(arg);
        const [facts, episodes] = await Promise.allSettled([
          getJson(`${deps.coreUrl}/knowledge/query?q=${q}&max=12`),
          getJson(`${deps.coreUrl}/memory/episodes?q=${q}&limit=6`),
        ]);
        const factsText = facts.status === "fulfilled" ? String(facts.value?.facts_text ?? "") : "";
        const rawEps = episodes.status === "fulfilled" && episodes.value?.ok !== false
          ? episodes.value?.episodes ?? []
          : [];
        // Only the speakable fields — the cloud phrases these for TTS.
        const eps = (Array.isArray(rawEps) ? rawEps : []).map((e: any) => ({
          when: e?.t_start ?? "", kind: e?.kind ?? "", summary: e?.summary ?? "",
        }));
        if (!factsText && (!Array.isArray(eps) || eps.length === 0)) {
          return { ok: true, data: { facts: "", episodes: [] } };
        }
        return {
          ok: true,
          data: {
            facts: factsText.slice(0, MAX_DATA),
            episodes: JSON.stringify(eps).slice(0, MAX_DATA),
          },
        };
      }
      case "remember": {
        if (!arg) return { ok: false, error: "nothing to store" };
        // Same note-triple shape the chat-agent's sinain_memory_store uses;
        // the deterministic integrator dedups and makes it queryable.
        const r = await fetch(`${deps.coreUrl}/knowledge/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ facts: [{ entity: "user", attribute: "note", value: arg, confidence: 0.7 }] }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok || body?.ok === false) return { ok: false, error: String(body?.error ?? `import ${r.status}`) };
        return { ok: true };
      }
      case "handoff": {
        if (!arg) return { ok: false, error: "empty task" };
        const m = AGENT_HINT.exec(arg);
        const task = m ? arg.slice(m[0].length).trim() : arg;
        if (!task) return { ok: false, error: "empty task" };
        const { agentLabel } = deps.createHandoff(task, req.transcript ?? "", m?.[1]);
        return { ok: true, say: `Handed off to ${agentLabel} in a new thread on your desktop.` };
      }
      default:
        return { ok: false, error: `unknown directive: ${name}` };
    }
  } catch (err) {
    warn(TAG, `${name} failed: ${String(err).slice(0, 160)}`);
    return { ok: false, error: String((err as Error).message ?? err).slice(0, 200) };
  }
}
