/** sinain chat-agent sidecar (JS) — resident Vercel AI SDK loop behind a WebSocket.
 *
 * Drop-in replacement for sinain-chat-agent/sidecar.py speaking the SAME protocol,
 * with no Python runtime: deps ship in node_modules, spawned from the bundled Node.
 *
 *   → client text frame:  {"message": "...", "context": {"kind":"main"|"roi", "seed":"...",
 *                          "source":"user"|"escalation"}}
 *                         {"cancel": true}            (interrupt the in-flight turn)
 *                         {"type":"status"}           (health probe)
 *   ← server event frames:
 *       {"type":"token","text":"..."}                 (assistant CONTENT delta)
 *       {"type":"tool_call","tool_name":"...","tool_args":{...}}
 *       {"type":"tool_result","tool_name":"...","tool_result":"..."}
 *       {"type":"usage_tick","usage":{...}}           (mid-turn spend DELTA)
 *       {"type":"done","text":"<full reply>","usage":{...}}
 *       {"type":"error","text":"...","usage":{...}}
 *       {"type":"status","state":"running"|"degraded"|"starting","error":...}
 *
 * Harness controls (ported from sidecar.py — the HARNESS owns the ceiling):
 *   - SINAIN_CHAT_TURN_TIMEOUT (90s): idle watchdog — a turn with no event for the
 *     whole window is aborted and the lane resets (a wedged stream can't hold it).
 *   - SINAIN_CHAT_TURN_BUDGET_USD / _TURN_MAX_INPUT_TOKENS: hard per-turn caps —
 *     crossing either aborts and closes the turn with what it has.
 *   - SINAIN_CHAT_CONTEXT_RESET_TOKENS: a turn that crossed this rebuilds a fresh
 *     history next turn — resident context stays bounded.
 *   - usage ticks every SINAIN_CHAT_USAGE_TICK_SECONDS: cost DELTAS ship mid-turn
 *     so core's CostTracker can sum blindly.
 *
 * Env: selected provider stack from ~/.sinain/.env with SINAIN_CHAT_* overrides,
 *      SINAIN_CHAT_REASONING (off|on), SINAIN_CORE_URL, SINAIN_CHAT_WS_PORT (9610).
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { streamText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { buildTools, setSink } from "./tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const TURN_TIMEOUT_S = Number(process.env.SINAIN_CHAT_TURN_TIMEOUT || "90");
const TURN_BUDGET_USD = Number(process.env.SINAIN_CHAT_TURN_BUDGET_USD || "0.50");
const TURN_MAX_INPUT_TOKENS = Number(process.env.SINAIN_CHAT_TURN_MAX_INPUT_TOKENS || "400000");
const CONTEXT_RESET_TOKENS = Number(process.env.SINAIN_CHAT_CONTEXT_RESET_TOKENS || "150000");
const USAGE_TICK_S = Number(process.env.SINAIN_CHAT_USAGE_TICK_SECONDS || "15");

const SYSTEM =
  "You are Sinain's chat assistant — a fast, concise helper with access to the user's " +
  "private knowledge graph, their current screen/audio context, and their machine. " +
  "Prefer a tool over guessing; answer directly and briefly. Do only what's asked.";

type Emit = (ev: Record<string, unknown>) => void;

// ── env chain: process → own .env → ~/.sinain/.env → repo .env ───────────────
// Process env wins. File values are rebuilt on every call so adding or changing
// a provider key heals the degraded sidecar without a restart.
const PROCESS_ENV = new Set(Object.keys(process.env));
const FILE_ENV_KEYS = new Set<string>();

function loadEnv(): void {
  for (const key of FILE_ENV_KEYS) {
    if (!PROCESS_ENV.has(key)) delete process.env[key];
  }
  FILE_ENV_KEYS.clear();
  const candidates = [
    resolve(HERE, "..", ".env"),
    resolve(homedir(), ".sinain", ".env"),
    resolve(HERE, "..", "..", ".env"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    for (const raw of readFileSync(p, "utf-8").split("\n")) {
      const ln = raw.trim();
      if (!ln || ln.startsWith("#") || !ln.includes("=")) continue;
      const i = ln.indexOf("=");
      const k = ln.slice(0, i).trim();
      const v = ln.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (!(k in process.env)) {
        process.env[k] = v;
        FILE_ENV_KEYS.add(k);
      }
    }
  }
}

// ── provider resolution (port of sidecar.py::_resolve_provider) ──────────────
function openaiBase(endpoint: string): string {
  const e = endpoint.replace(/\/+$/, "");
  return e.endsWith("/chat/completions") ? e.slice(0, -"/chat/completions".length) : e;
}

async function providerStatus(): Promise<Record<string, unknown>> {
  try {
    const res = await fetch("http://127.0.0.1:9500/setup/providers", { signal: AbortSignal.timeout(2000) });
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

interface ProviderConfig {
  stack: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

async function resolveProvider(): Promise<ProviderConfig> {
  const endpoint = (process.env.SINAIN_CHAT_ENDPOINT || "").trim();
  const explicitKey = (process.env.SINAIN_CHAT_API_KEY || "").trim();
  const explicitModel = (process.env.SINAIN_CHAT_MODEL || "").trim();
  const analysisEndpoint = (process.env.ANALYSIS_ENDPOINT || "").trim();
  const burst = (process.env.BURST_PROVIDER || "").toLowerCase();
  const local = (process.env.SINAIN_LOCAL_MODE || "").toLowerCase() === "true";

  let stack: string;
  if (local) stack = "local";
  else if (burst === "cerebras" || analysisEndpoint.includes("cerebras.ai")) stack = "cerebras";
  else if (burst === "openrouter" || analysisEndpoint.includes("openrouter.ai")) stack = "openrouter";
  else stack = String((await providerStatus()).activeStack || "openrouter").toLowerCase();

  let base: string, key: string, model: string;
  if (stack === "cerebras") {
    base = "https://api.cerebras.ai/v1";
    key = (process.env.CEREBRAS_API_KEY || "").trim();
    model = (process.env.SINAIN_CHAT_MODEL_CEREBRAS || "").trim() || process.env.ANALYSIS_MODEL || "gemma-4-31b";
  } else if (stack === "local") {
    base = analysisEndpoint ? openaiBase(analysisEndpoint) : "http://localhost:11434";
    // Ollama's OpenAI-compatible surface lives under /v1 (litellm used the
    // native /api/chat; the AI SDK speaks chat-completions, so /v1 it is).
    if (!/\/v1$/.test(base)) base = base.replace(/\/+$/, "") + "/v1";
    key = "local";
    let m = (process.env.ANALYSIS_MODEL || "").trim() || process.env.SINAIN_LOCAL_LLM || "qwen2.5vl:7b";
    // A cloud slug pinned in env must not leak into local mode (the 2026-07-15
    // lesson): anything namespaced like openrouter slugs falls back to the
    // local-mode standard model.
    if (m.includes("/")) m = "qwen2.5vl:7b";
    model = m;
  } else {
    stack = "openrouter";
    base = "https://openrouter.ai/api/v1";
    key = (process.env.OPENROUTER_API_KEY || "").trim();
    model = "qwen/qwen3.5-flash-02-23";
  }
  return {
    stack,
    baseUrl: endpoint ? openaiBase(endpoint) : base,
    apiKey: explicitKey || key,
    model: explicitModel || model,
  };
}

// ── OpenRouter cost capture ──────────────────────────────────────────────────
// The AI SDK surfaces token usage but not OpenRouter's usage.cost. We own the
// fetch anyway (to inject reasoning-off + usage accounting into the body), so
// tee the SSE response and scan the tail for the final usage chunk's cost.
function makeFetch(stack: string, onCost: (c: number) => void): typeof fetch {
  return async (input, init) => {
    if (stack === "openrouter" && init?.body && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if ((process.env.SINAIN_CHAT_REASONING || "off").toLowerCase() !== "on") {
          body.reasoning = { enabled: false };
        }
        body.usage = { include: true };
        init = { ...init, body: JSON.stringify(body) };
      } catch { /* non-JSON body — pass through */ }
    }
    const res = await fetch(input, init);
    if (stack === "openrouter" && res.body) {
      const [toSdk, toScan] = res.body.tee();
      void scanCost(toScan, onCost);
      return new Response(toSdk, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    return res;
  };
}

async function scanCost(stream: ReadableStream<Uint8Array>, onCost: (c: number) => void): Promise<void> {
  try {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let tail = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      tail = (tail + dec.decode(value, { stream: true })).slice(-8000);
    }
    const m = /"usage"\s*:\s*\{[^}]*"cost"\s*:\s*([0-9.eE+-]+)/.exec(tail);
    if (m) onCost(parseFloat(m[1]));
  } catch { /* cost capture is best-effort — never break the turn */ }
}

// ── resident chat agent ──────────────────────────────────────────────────────
class ChatAgent {
  state: "starting" | "running" | "degraded" = "starting";
  error: string | null = null;

  private model: ReturnType<ReturnType<typeof createOpenAICompatible>["chatModel"]> | null = null;
  private tools: ToolSet | null = null;
  private modelName = "sinain-chat";
  private history: ModelMessage[] = [];
  private needsReset = false;
  private busy = false;
  private activeSource: string | null = null;
  private currentAbort: AbortController | null = null;
  // One resident history serves BOTH user chat and ambient escalations —
  // serialize turns; run() enqueues on this chain.
  private queue: Promise<void> = Promise.resolve();
  // Cost lands via the fetch tee, async to the step loop — accumulate per turn.
  private turnCost = 0;

  async setup(): Promise<void> {
    const cfg = await resolveProvider();
    if (cfg.stack !== "local" && !cfg.apiKey) {
      throw new Error(`sinain chat is not configured: ${cfg.stack} needs an API key — add it in AI Provider settings`);
    }
    const provider = createOpenAICompatible({
      name: cfg.stack,
      baseURL: cfg.baseUrl,
      apiKey: cfg.apiKey || "local",
      fetch: makeFetch(cfg.stack, (c) => { this.turnCost += c; }),
    });
    this.model = provider.chatModel(cfg.model);
    this.modelName = cfg.model;
    this.tools = buildTools();
    this.history = [];
    console.log(`[sinain-chat] ready · stack=${cfg.stack} model=${cfg.model} base=${cfg.baseUrl}`);
  }

  cancel(): void {
    this.currentAbort?.abort();
  }

  run(message: string, context: Record<string, unknown>, emit: Emit): Promise<void> {
    const source = String(context?.source || "user");
    // Escalations are ephemeral: if a turn is running, DROP rather than queue —
    // a backlog of ambient escalations would starve user turns.
    if (this.busy && source !== "user") {
      emit({ type: "done", text: "" });
      return Promise.resolve();
    }
    // A user turn PREEMPTS an in-flight escalation so the user is never starved.
    if (this.busy && source === "user" && this.activeSource !== "user") {
      this.cancel();
    }
    const p = this.queue.then(() => this.turn(message, context, source, emit));
    this.queue = p.catch(() => { /* keep the chain alive */ });
    return p;
  }

  private async turn(message: string, context: Record<string, unknown>, source: string, emit: Emit): Promise<void> {
    if (!this.model || !this.tools) {
      emit({ type: "error", text: this.error || "sinain chat is starting" });
      return;
    }
    if (this.needsReset) {
      this.history = [];
      this.needsReset = false;
    }
    this.busy = true;
    this.activeSource = source;
    this.turnCost = 0;

    const seed = String(context?.seed || "");
    const kind = String(context?.kind || "main");
    const msg = seed ? `[${kind} context]\n${seed}\n\n${message}` : message;
    this.history.push({ role: "user", content: msg });

    let acc = "";
    let turnIn = 0;
    let turnOut = 0;
    // Every terminal event and every tick carries a DELTA since the last
    // report, so core's CostTracker can sum blindly.
    const reported = { cost: 0, in: 0, out: 0 };
    const delta = () => {
      const d = {
        cost: Math.max(0, this.turnCost - reported.cost),
        tokensIn: Math.max(0, turnIn - reported.in),
        tokensOut: Math.max(0, turnOut - reported.out),
        model: this.modelName,
      };
      reported.cost = this.turnCost;
      reported.in = turnIn;
      reported.out = turnOut;
      return d;
    };

    const ac = new AbortController();
    this.currentAbort = ac;
    let lastEvent = Date.now();
    let lastTick = Date.now();
    let stalled = false;
    let budgetStop: string | null = null;
    const touch = () => { lastEvent = Date.now(); };
    setSink((ev) => { touch(); emit(ev); });

    // The harness owns the ceiling: watchdog + budget + usage ticks run on a
    // side interval so a silent stream can't suppress them.
    const guard = setInterval(() => {
      const now = Date.now();
      if (budgetStop === null && (this.turnCost > TURN_BUDGET_USD || turnIn > TURN_MAX_INPUT_TOKENS)) {
        budgetStop = `turn budget exceeded ($${this.turnCost.toFixed(2)}, ${turnIn} input tokens)`;
        console.warn(`[sinain-chat] budget stop: ${budgetStop}`);
        ac.abort();
      }
      if (!stalled && now - lastEvent > TURN_TIMEOUT_S * 1000) {
        stalled = true;
        ac.abort();
      }
      if (now - lastTick >= USAGE_TICK_S * 1000) {
        lastTick = now;
        const d = delta();
        if (d.cost || d.tokensIn) emit({ type: "usage_tick", usage: d });
      }
    }, 2000);

    try {
      const result = streamText({
        model: this.model,
        system: SYSTEM,
        messages: this.history,
        tools: this.tools,
        stopWhen: stepCountIs(12),
        abortSignal: ac.signal,
        onStepFinish: (step) => {
          turnIn += step.usage?.inputTokens ?? 0;
          turnOut += step.usage?.outputTokens ?? 0;
        },
      });
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          const text = (part as { text?: string; textDelta?: string }).text ??
            (part as { textDelta?: string }).textDelta ?? "";
          if (text) {
            acc += text;
            touch();
            emit({ type: "token", text });
          }
        } else if (part.type === "error") {
          const err = (part as { error?: unknown }).error;
          throw err instanceof Error ? err : new Error(String(err));
        } else {
          touch(); // any stream part proves liveness (tool steps, step finish, …)
        }
      }
      // Persist the full step trace (assistant + tool messages) so multi-turn
      // tool context survives — matches the resident OpenHands Conversation.
      const response = await result.response;
      this.history.push(...response.messages);
      emit({ type: "done", text: acc, usage: delta() });
    } catch (e) {
      if (ac.signal.aborted) {
        if (stalled) {
          // No event for the whole window — the LLM call is wedged. Reset the lane.
          this.needsReset = true;
          emit({
            type: "error",
            text: `chat turn stalled (>${Math.round(TURN_TIMEOUT_S)}s) — resetting the chat lane`,
            usage: delta(),
          });
        } else if (budgetStop) {
          this.needsReset = true;
          emit({ type: "done", text: `${acc}\n\n[stopped: ${budgetStop}]`, usage: delta() });
        } else {
          // user cancel / preemption — close the turn with what it has
          if (acc) this.history.push({ role: "assistant", content: acc });
          emit({ type: "done", text: acc, usage: delta() });
        }
      } else {
        const err = e instanceof Error ? e : new Error(String(e));
        emit({ type: "error", text: `${err.name}: ${err.message}`, usage: delta() });
      }
    } finally {
      clearInterval(guard);
      setSink(null);
      // Bounded resident history: a budget stop, or a turn whose prompt tokens
      // crossed the reset bound, rebuilds fresh history next turn.
      if (turnIn > CONTEXT_RESET_TOKENS) this.needsReset = true;
      this.currentAbort = null;
      this.activeSource = null;
      this.busy = false;
    }
  }
}

// ── WS server ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  loadEnv();
  const port = Number(process.env.SINAIN_CHAT_WS_PORT || "9610");
  const agent = new ChatAgent();

  console.log(`[sinain-chat] warming (js/ai-sdk)…`);
  try {
    await agent.setup();
    agent.state = "running";
    console.log(`[sinain-chat] ready · ws://127.0.0.1:${port}`);
  } catch (e) {
    // config/warmup failures must not take down the WS — serve degraded
    agent.state = "degraded";
    agent.error = e instanceof Error ? e.message : String(e);
    console.error(`[sinain-chat] degraded: ${agent.error}`);
  }

  // Re-read env every 60s while degraded so adding a key heals without restart.
  setInterval(async () => {
    if (agent.state === "running") return;
    loadEnv();
    try {
      await agent.setup();
      agent.state = "running";
      agent.error = null;
      console.log("[sinain-chat] configuration healed · ready");
    } catch (e) {
      agent.state = "degraded";
      agent.error = e instanceof Error ? e.message : String(e);
    }
  }, 60_000).unref();

  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  // core's liveness probe opens a bare TCP socket and closes it — never let
  // that (or any half-handshake) surface as a crash or log spam.
  wss.on("error", (e) => console.error(`[sinain-chat] ws server error: ${e.message}`));

  wss.on("connection", (ws: WebSocket) => {
    ws.on("error", () => { /* client went away mid-turn — turn loop handles it */ });
    ws.on("message", (raw) => {
      let req: Record<string, unknown>;
      try {
        req = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        ws.send(JSON.stringify({ type: "error", text: "bad JSON" }));
        return;
      }
      if (req.type === "status") {
        ws.send(JSON.stringify({ type: "status", state: agent.state, error: agent.error }));
        return;
      }
      if (req.cancel) {
        agent.cancel();
        return;
      }
      if (agent.state !== "running") {
        ws.send(JSON.stringify({ type: "error", text: agent.error || "sinain chat is starting" }));
        return;
      }
      const emit: Emit = (ev) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev));
      };
      void agent
        .run(String(req.message || ""), (req.context as Record<string, unknown>) || {}, emit)
        .catch((e) => emit({ type: "error", text: e instanceof Error ? e.message : String(e) }));
    });
  });
}

void main();
