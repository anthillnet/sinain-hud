import type { BurstConfig } from "../types.js";
import { redactChatPayload } from "../privacy/cloud-egress.js";

/**
 * Minimal OpenAI-compatible client for the deliberate-capture burst lane.
 * Cerebras specifics (all optional for other providers): `prompt_cache_key`
 * for prefix caching across gestures, native JSON mode, and a real User-Agent
 * (Cerebras sits behind Cloudflare, which 403s the default node UA).
 */

export interface BurstCallResult {
  content: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  /** True when served from a memo (identical seeded input) — tokens were
   *  already billed and recorded on the original call; callers must skip
   *  cost/metrics recording for cached results. */
  cached?: boolean;
}

export class BurstError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export async function burstCall(
  config: BurstConfig,
  opts: {
    system: string;
    user: string;
    maxTokens?: number;
    cacheKey?: string;
    jsonMode?: boolean;
    seed?: number;
  },
): Promise<BurstCallResult> {
  // Seed every call (env-overridable) — deterministic briefs run-to-run and
  // reproducible measurements; Cerebras accepts and honours `seed`.
  const envSeed = parseInt(process.env.SINAIN_BURST_SEED || "", 10);
  const seed = opts.seed ?? (Number.isFinite(envSeed) ? envSeed : 42);

  if (config.provider === "ollama") return burstCallOllama(config, opts, seed);
  if (!config.apiKey) throw new BurstError("burst lane has no API key (set CEREBRAS_API_KEY)", 503);
  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    max_tokens: opts.maxTokens ?? config.maxTokens,
    temperature: 0,
    seed,
  };
  if (config.provider === "cerebras") {
    if (opts.cacheKey) body.prompt_cache_key = opts.cacheKey;
    if (opts.jsonMode) body.response_format = { type: "json_object" };
  } else if (opts.jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "sinain-core-burst/0.1",
      },
      body: JSON.stringify(redactChatPayload(body)),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BurstError(`burst ${config.provider} ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    if (!content) throw new BurstError("burst response had no content");
    return {
      content,
      tokensIn: data.usage?.prompt_tokens ?? 0,
      tokensOut: data.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    if (err instanceof BurstError) throw err;
    const aborted = (err as Error).name === "AbortError";
    throw new BurstError(aborted ? `burst timed out after ${config.timeoutMs}ms` : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** Local burst via Ollama's native /api/chat. The OpenAI-compat /v1 endpoint
 * has no way to disable thinking, so reasoning models (e.g. Bonsai-27B) put
 * their output in `reasoning` and return empty content there; the native API
 * takes `think: false`, which non-thinking models ignore. No API key needed. */
async function burstCallOllama(
  config: BurstConfig,
  opts: { system: string; user: string; maxTokens?: number; jsonMode?: boolean },
  seed: number,
): Promise<BurstCallResult> {
  // Tolerate an OpenAI-style endpoint value left over from a cloud profile.
  const base = config.endpoint.replace(/\/v1\/chat\/completions\/?$/, "").replace(/\/$/, "");
  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    stream: false,
    think: false,
    options: { num_predict: opts.maxTokens ?? config.maxTokens, temperature: 0, seed },
  };
  if (opts.jsonMode) body.format = "json";

  // Local prefill is ~200 tok/s (measured, Bonsai-27B on M4 Max) — a 30-min
  // window brief can take 60s+. The cloud default (BURST_TIMEOUT_MS=20s,
  // sized for Cerebras) would abort every large local summon, so floor it.
  const timeoutMs = Math.max(config.timeoutMs, 180_000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BurstError(`burst ollama ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
    const data = (await res.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const content = data.message?.content?.trim() ?? "";
    if (!content) throw new BurstError("burst response had no content");
    return {
      content,
      tokensIn: data.prompt_eval_count ?? 0,
      tokensOut: data.eval_count ?? 0,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    if (err instanceof BurstError) throw err;
    const aborted = (err as Error).name === "AbortError";
    throw new BurstError(aborted ? `burst timed out after ${timeoutMs}ms` : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** Tolerant JSON extraction — grabs the outermost {...} from prose wrappers. */
export function parseBurstJson<T>(content: string): T {
  const i = content.indexOf("{");
  const j = content.lastIndexOf("}");
  if (i < 0 || j <= i) throw new BurstError("burst response was not JSON");
  return JSON.parse(content.slice(i, j + 1)) as T;
}
