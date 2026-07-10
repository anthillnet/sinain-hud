import type { BurstConfig } from "../types.js";

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
  if (!config.apiKey) throw new BurstError("burst lane has no API key (set CEREBRAS_API_KEY)", 503);

  // Seed every call (env-overridable) — deterministic briefs run-to-run and
  // reproducible measurements; Cerebras accepts and honours `seed`.
  const envSeed = parseInt(process.env.SINAIN_BURST_SEED || "", 10);
  const seed = opts.seed ?? (Number.isFinite(envSeed) ? envSeed : 42);
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
      body: JSON.stringify(body),
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

/** Tolerant JSON extraction — grabs the outermost {...} from prose wrappers. */
export function parseBurstJson<T>(content: string): T {
  const i = content.indexOf("{");
  const j = content.lastIndexOf("}");
  if (i < 0 || j <= i) throw new BurstError("burst response was not JSON");
  return JSON.parse(content.slice(i, j + 1)) as T;
}
