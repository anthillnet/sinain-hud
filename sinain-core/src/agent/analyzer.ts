import type { AnalysisConfig, AgentResult, ContextWindow, RecorderStatus, RecordCommand, RawRegion } from "../types.js";
import { normalizeAppName } from "./context-window.js";
import { buildLineList, resolveLineRegions } from "./region-lines.js";
import { log, debug, warn } from "../log.js";
import { levelFor, applyLevel } from "../privacy/index.js";
import { redactChatPayload } from "../privacy/cloud-egress.js";

const TAG = "agent";
let missingProviderLogged = false;

export class AnalysisAuthError extends Error {
  constructor(readonly status: number, body: string) {
    super(`OpenRouter authentication failed (HTTP ${status}): ${body.slice(0, 200)}`);
    this.name = "AnalysisAuthError";
  }
}

/**
 * Model-specific timeouts in milliseconds.
 * Only increases timeouts for slow models to avoid false timeouts.
 * Default 15s is kept for fast models.
 */
const MODEL_TIMEOUTS: Record<string, number> = {
  'google/gemini-2.5-flash-lite': 15000,
  'google/gemini-2.5-flash': 15000,
  'google/gemini-2.0-flash': 15000,
  'anthropic/claude-3-opus': 60000,
  'anthropic/claude-3.5-sonnet': 30000,
  'anthropic/claude-3-haiku': 15000,
  'default': 15000,
};

/** Get timeout for a specific model. */
function getModelTimeout(model: string): number {
  return MODEL_TIMEOUTS[model] ?? MODEL_TIMEOUTS['default'];
}

/** Message part for multimodal API calls. */
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail: "low" } };

/**
 * Build recorder status section for the prompt.
 */
function buildRecorderSection(status: RecorderStatus | null): string {
  if (!status) return "";
  if (!status.recording) return "\nRecorder: idle (not recording)";

  const label = status.label ? ` "${status.label}"` : "";
  const durationSec = Math.round(status.durationMs / 1000);
  return `\nRecorder: RECORDING${label} (${durationSec}s, ${status.segments} segments)`;
}

/**
 * Static system prompt (cached as module constant).
 * Contains rules, output format, and behavioral instructions.
 * Previously allocated ~3KB per tick; now zero-allocation.
 */
const SYSTEM_PROMPT = `You are an AI monitoring a user's screen and audio in real-time.
You produce outputs as JSON.

Respond ONLY with valid JSON. No markdown, no code fences, no explanation.
Your entire response must be parseable by JSON.parse().

{"hud":"...","digest":"...","record":{"command":"start"|"stop","label":"..."}}

Output fields:
- "hud" (required): max 60 words describing what user is doing NOW
- "digest" (required): 5-8 sentences with detailed activity description
- "record" (optional): control recording — {"command":"start","label":"Meeting name"} or {"command":"stop"}

When to use "record":
- START when user begins a meeting, call, lecture, YouTube video, or important audio content
- STOP when the content ends or user navigates away
- Provide descriptive labels like "Team standup", "Client call", "YouTube: [video title from OCR]"
- For YouTube/video content: extract video title from screen OCR for the label

Audio sources: [\ud83d\udd0a]=system/speaker audio, [\ud83c\udf99]=microphone (user's voice).
Treat [\ud83c\udf99] as direct user speech. Treat [\ud83d\udd0a] as external audio.

Rules:
- "hud" is for a minimal overlay display. Example: "Editing hud-relay.mjs in IDEA"
- "digest" is for an AI assistant to understand the full situation and offer help.
- If nothing is happening, hud="Idle" and digest explains what was last seen.
- Include specific filenames, URLs, error messages, UI text from OCR in digest.
- Do NOT suggest actions in digest — just describe the situation factually.
- Only include "record" when genuinely appropriate — most responses won't have it.
- CRITICAL: Output ONLY the JSON object, nothing else.`;

/**
 * Regions section appended to the system prompt when Grammarly mode is on.
 * The "Actionable lines" block in the user prompt numbers OCR lines "[L<id>]";
 * the model picks a line id and writes a clean DESCRIPTION (not a quote) — core
 * anchors the eye to that line's exact box, so the label is free to be readable.
 */
const REGIONS_SECTION = `

"regions" field — the user is almost always working on SOMETHING; identify that
task and offer concrete help to MOVE IT FORWARD. Pick from the numbered
"Actionable lines" in the user message:
{"hud":"...","digest":"...","regions":[{"line":5,"issue":"...","tip":"...","action":"fix"}]}

Look at what they're doing and offer to advance it:
- writing a slide/presentation/doc/email → sharpen the message, draft the next
  part, tighten the argument, suggest content
- code → fix a bug, explain it, refactor
- reading an article/topic → summarize, explain, find related info
- a form/command/error → fill it, run it, diagnose and fix
Each region:
- "line": the integer id from an "[L<id>]" actionable line (the thing in focus)
- "issue": SHORT, CLEAN, in your own words (≤10 words) — what the user is doing /
  what you'd help with. Don't quote raw OCR.
- "tip": the concrete thing you'd do to help advance their work
- "action": "fix" | "explain" | "research"
Be genuinely USEFUL, never a nitpicker: don't flag surface trivia (others'
grammar/formatting/timestamps) or just restate the screen — offer real help.
Usually emit 1-2 (the main thing in focus); [] only for a blank/idle screen.`;

const SYSTEM_PROMPT_WITH_REGIONS = SYSTEM_PROMPT + REGIONS_SECTION;

/**
 * Render privacy-gated screen and audio lines for a context window.
 */
export function renderContextLines(
  ctx: ContextWindow,
  { withSourceIds = false }: { withSourceIds?: boolean } = {},
): { screenLines: string; audioLines: string } {
  const now = Date.now();

  // [S<id>] prefix lets the LLM anchor regions to a sense event (Grammarly mode)
  const srcTag = (e: { id?: number }) => withSourceIds && e.id !== undefined ? `[S${e.id}] ` : "";

  // Privacy gating: check levels for openrouter destination
  let screenLines: string;
  try {
    const ocrLevel = levelFor("screen_ocr", "openrouter");
    const titlesLevel = levelFor("window_titles", "openrouter");
    screenLines = ctx.screen
      .map(e => {
        const app = normalizeAppName(e.meta.app);
        const ago = Math.round((now - (e.ts || now)) / 1000);
        const rawOcr = e.ocr ? e.ocr.replace(/\n/g, " ").slice(0, ctx.preset.maxOcrChars) : "(no text)";
        const ocr = e.ocr ? applyLevel(rawOcr, ocrLevel, "ocr") : "(no text)";
        const title = e.meta.windowTitle ? applyLevel(e.meta.windowTitle, titlesLevel, "titles") : "";
        const titlePart = title ? ` [${title}]` : "";
        return `${srcTag(e)}[${ago}s ago] [${app}]${titlePart} ${ocr || "(no text)"}`;
      })
      .join("\n");
  } catch {
    // SECURITY: privacy not yet initialized (startup race) — fail CLOSED.
    // This text would otherwise go to the OpenRouter cloud LLM. Suppress the
    // OCR content; keep only low-sensitivity app/timing metadata.
    screenLines = ctx.screen
      .map(e => {
        const app = normalizeAppName(e.meta.app);
        const ago = Math.round((now - (e.ts || now)) / 1000);
        return `${srcTag(e)}[${ago}s ago] [${app}] (suppressed: privacy uninitialized)`;
      })
      .join("\n");
  }

  let audioLines: string;
  try {
    const audioLevel = levelFor("audio_transcript", "openrouter");
    audioLines = ctx.audio
      .map(e => {
        const ago = Math.round((now - (e.ts || now)) / 1000);
        const text = applyLevel(e.text.slice(0, ctx.preset.maxTranscriptChars), audioLevel, "audio");
        return `[${ago}s ago] ${text}`;
      })
      .join("\n");
  } catch {
    // SECURITY: privacy not yet initialized — fail CLOSED (cloud-bound text).
    audioLines = ctx.audio
      .map(e => {
        const ago = Math.round((now - (e.ts || now)) / 1000);
        return `[${ago}s ago] (suppressed: privacy uninitialized)`;
      })
      .join("\n");
  }

  return { screenLines, audioLines };
}

/**
 * Build the dynamic user prompt (changes every tick).
 * Contains the current context data: screen OCR, audio transcripts, app state.
 */
export function buildUserPrompt(ctx: ContextWindow, recorderStatus: RecorderStatus | null = null, withSourceIds = false): string {
  const { screenLines, audioLines } = renderContextLines(ctx, { withSourceIds });

  const appSwitches = ctx.appHistory
    .map(a => normalizeAppName(a.app))
    .join(" \u2192 ");

  const recorderSection = buildRecorderSection(recorderStatus);

  // Gate images based on privacy level
  let imagesForPrompt = ctx.images;
  try {
    const imgLevel = levelFor("screen_images", "openrouter");
    if (imgLevel === "none") {
      imagesForPrompt = [];
    }
  } catch { imagesForPrompt = []; /* SECURITY: fail CLOSED — drop cloud-bound images when privacy uninitialized */ }

  const hasImages = imagesForPrompt && imagesForPrompt.length > 0;
  const imageNote = hasImages ? `\n\nScreen screenshots (${imagesForPrompt!.length}) are attached below.` : "";

  const knowledgeSection = ctx.knowledgeFacts
    ? `\n\nRelevant background:\n${ctx.knowledgeFacts}`
    : "";

  return `Active app: ${normalizeAppName(ctx.currentApp)}
App history: ${appSwitches || "(none)"}${recorderSection}

Screen (OCR text, newest first):
${screenLines || "(no screen data)"}

Audio transcript (newest first, \ud83d\udd0a=system, \ud83c\udf99=mic):
${audioLines || "(silence)"}${knowledgeSection}${imageNote}`;
}

/**
 * Parse record command from LLM response.
 */
function parseRecord(parsed: any): RecordCommand | undefined {
  if (!parsed.record || typeof parsed.record !== "object") return undefined;
  const cmd = parsed.record.command;
  if (cmd !== "start" && cmd !== "stop") return undefined;
  return {
    command: cmd,
    label: typeof parsed.record.label === "string" ? parsed.record.label : undefined,
  };
}

/**
 * Parse task from LLM response.
 */
function parseTask(parsed: any): string | undefined {
  if (typeof parsed.task !== "string" || !parsed.task.trim()) return undefined;
  return parsed.task.trim();
}

/** Coerce an LLM response field to display text. Small local models
 *  occasionally emit objects/arrays for hud/digest — stringify rather than
 *  crash downstream consumers (digest.toLowerCase in the escalation scorer). */
function asText(v: unknown, fallback: string): string {
  if (typeof v === "string") return v.trim() ? v : fallback;
  if (v === undefined || v === null) return fallback;
  try {
    return JSON.stringify(v).slice(0, 2000);
  } catch {
    return fallback;
  }
}

const REGION_ACTIONS = new Set(["fix", "explain", "research"]);
const MAX_REGIONS = 3;

/**
 * Parse regions from LLM response (Grammarly mode).
 */
export function parseRegions(parsed: any): RawRegion[] | undefined {
  if (!Array.isArray(parsed.regions) || parsed.regions.length === 0) return undefined;
  const regions = parsed.regions
    .filter((r: any) => typeof r?.issue === "string" && r.issue.trim() &&
                        typeof r?.tip === "string" && r.tip.trim())
    .slice(0, MAX_REGIONS)
    .map((r: any): RawRegion => ({
      issue: r.issue.trim().slice(0, 200),
      tip: r.tip.trim().slice(0, 300),
      action: REGION_ACTIONS.has(r.action) ? r.action : undefined,
      sourceId: Number.isInteger(r.sourceId) ? r.sourceId : undefined,
    }));
  return regions.length > 0 ? regions : undefined;
}

/**
 * Call the LLM (OpenRouter) to analyze the context window.
 * Supports model chain: primary + fallbacks.
 * When images are present, auto-upgrades to the vision model.
 */
export async function analyzeContext(
  contextWindow: ContextWindow,
  config: AnalysisConfig,
  recorderStatus: RecorderStatus | null = null,
): Promise<AgentResult> {
  if (config.provider !== "ollama" && !config.apiKey) {
    if (!missingProviderLogged) {
      warn("privacy", "analysis disabled: no provider configured");
      missingProviderLogged = true;
    }
    throw new Error("analysis provider not configured");
  }

  let userPrompt = buildUserPrompt(contextWindow, recorderStatus, config.regionsEnabled);
  const systemPrompt = config.regionsEnabled ? SYSTEM_PROMPT_WITH_REGIONS : SYSTEM_PROMPT;

  // Region anchoring: offer numbered OCR lines; the model picks line ids and we
  // resolve them to exact boxes after the call (same path as the SLM lane, so a
  // region maps to the same eye regardless of which lane found it).
  const lineList = config.regionsEnabled ? buildLineList(contextWindow) : null;
  if (lineList && lineList.lines.length) {
    userPrompt += `\n\nActionable lines (use the [L<id>] number for region "line"):\n${lineList.prompt}`;
  }
  const resolveRegions = (result: AgentResult): AgentResult => {
    result.regions = lineList
      ? resolveLineRegions(result.regions as any, lineList.lines, { maxRegions: 3 })
      : undefined;
    return result;
  };

  // Apply privacy gating for images based on provider
  let images = contextWindow.images || [];
  const privacyDest = config.provider === "ollama" ? "local_llm" : "openrouter";
  try {
    if (levelFor("screen_images", privacyDest) === "none") images = [];
  } catch { images = []; /* SECURITY: fail CLOSED — drop images when privacy uninitialized */ }
  // Single-vision-pass (local mode default): the agent doesn't re-run the vision
  // model — sense_client owns vision and feeds its scene caption in as text, so
  // the agent reasons text-only on the fast model. Dropping images here makes
  // callOllama pick config.model (text) instead of config.visionModel.
  if (config.agentVision === false) images = [];

  if (config.provider === "ollama") {
    return resolveRegions(await callOllama(systemPrompt, userPrompt, images, config));
  }

  // OpenRouter path: model chain with fallbacks
  const models = [config.model, ...config.fallbackModels];
  // Auto-upgrade to vision model when images are present
  if (images.length > 0 && config.visionModel && !models.includes(config.visionModel)) {
    models.unshift(config.visionModel);
  }

  let lastError: Error | null = null;
  for (const model of models) {
    try {
      return resolveRegions(await callOpenRouter(systemPrompt, userPrompt, images, model, config));
    } catch (err: any) {
      if (err instanceof AnalysisAuthError) throw err;
      lastError = err;
      log(TAG, `model ${model} failed: ${err.message || err}, trying next...`);
    }
  }
  throw lastError || new Error("all models failed");
}

async function callOpenRouter(
  systemPrompt: string,
  userPrompt: string,
  images: ContextWindow["images"],
  model: string,
  config: AnalysisConfig,
): Promise<AgentResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timeoutMs = getModelTimeout(model);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Build user message content: text + optional images
    let userContent: string | ContentPart[];
    if (images && images.length > 0) {
      const parts: ContentPart[] = [{ type: "text", text: userPrompt }];
      for (const img of images) {
        parts.push({
          type: "image_url",
          image_url: {
            url: `data:image/jpeg;base64,${img.data}`,
            detail: "low",
          },
        });
      }
      userContent = parts;
    } else {
      userContent = userPrompt;
    }

    const imageCount = images?.length || 0;

    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(redactChatPayload({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        max_tokens: config.maxTokens,
        temperature: config.temperature,
      })),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (response.status === 401) {
        throw new AnalysisAuthError(response.status, body);
      }
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;
    const raw = data.choices?.[0]?.message?.content?.trim() || "";

    if (imageCount > 0) {
      log(TAG, `multimodal call: model=${model}, images=${imageCount}`);
    }
    debug(TAG, `raw response (${raw.length} chars): ${raw.slice(0, 800)}`);

    // Parse JSON response — try direct parse, then extract embedded JSON, then fallback
    try {
      const jsonStr = raw.replace(/^```\w*\s*\n?/, "").replace(/\n?\s*```\s*$/, "").trim();
      const parsed = JSON.parse(jsonStr);
      const apiCost = typeof data.usage?.cost === "number" ? data.usage.cost : undefined;
      return {
        hud: asText(parsed.hud, "\u2014"),
        digest: asText(parsed.digest, "\u2014"),
        record: parseRecord(parsed),
        task: parseTask(parsed),
        // Raw {line,...} array; analyzeContext resolves it against the line list.
        regions: (Array.isArray(parsed.regions) && parsed.regions.length ? parsed.regions : undefined),
        latencyMs,
        tokensIn: data.usage?.prompt_tokens || 0,
        tokensOut: data.usage?.completion_tokens || 0,
        model,
        parsedOk: true,
        cost: apiCost,
      };
    } catch {
      // Second chance: extract embedded JSON object
      const match = raw.match(/\{[\s\S]*\}/);
      const apiCost = typeof data.usage?.cost === "number" ? data.usage.cost : undefined;
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          if (parsed.hud) {
            return {
              hud: asText(parsed.hud, "\u2014"),
              digest: asText(parsed.digest, "\u2014"),
              record: parseRecord(parsed),
              task: parseTask(parsed),
              // Raw {line,...} array; analyzeContext resolves it against the line list.
        regions: (Array.isArray(parsed.regions) && parsed.regions.length ? parsed.regions : undefined),
              latencyMs,
              tokensIn: data.usage?.prompt_tokens || 0,
              tokensOut: data.usage?.completion_tokens || 0,
              model,
              parsedOk: true,
              cost: apiCost,
            };
          }
        } catch { /* fall through */ }
      }

      // Final fallback: use raw text
      log(TAG, `JSON parse failed (model=${model}), raw: "${raw.slice(0, 120)}"`);
      return {
        hud: raw.slice(0, 160) || "\u2014",
        digest: raw || "\u2014",
        latencyMs,
        tokensIn: data.usage?.prompt_tokens || 0,
        tokensOut: data.usage?.completion_tokens || 0,
        model,
        parsedOk: false,
        cost: apiCost,
      };
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Call Ollama local model for context analysis.
 * Uses the /api/chat endpoint with optional base64 images.
 */
async function callOllama(
  systemPrompt: string,
  userPrompt: string,
  images: ContextWindow["images"],
  config: AnalysisConfig,
): Promise<AgentResult> {
  const start = Date.now();
  const controller = new AbortController();
  const imageB64List = (images || []).map((img) => img.data);
  // Route image ticks to the vision-capable model (e.g. qwen2.5vl), mirroring
  // the OpenRouter auto-upgrade above. config.model (e.g. phi4-mini) is
  // text-only — handing it images yields blind, hallucinated analysis.
  const hasImages = imageB64List.length > 0;
  const model = (hasImages && config.visionModel) ? config.visionModel : config.model;
  // Local models are slow (cold start + generation), and a vision model under
  // GPU contention (region-SLM + sense-vision share the same Ollama) is slower
  // still. Floor generously per call type so a busy GPU doesn't abort a healthy
  // tick and trip a false "analysis unreachable" outage.
  const timeoutMs = Math.max(config.timeout, hasImages ? 120_000 : 60_000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {

    const response = await fetch(`${config.endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt, images: imageB64List },
        ],
        stream: false,
        // Reasoning models (e.g. Bonsai-27B) stream tokens into `thinking` and
        // leave `content` empty until the reasoning budget is spent — this lane
        // needs strict JSON in `content`, so thinking is disabled. Non-thinking
        // models ignore the flag.
        think: false,
        options: { num_predict: config.maxTokens },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as {
      message?: { content?: string };
      eval_count?: number;
      prompt_eval_count?: number;
    };

    const content = data.message?.content?.trim() || "";
    const latencyMs = Date.now() - start;
    const tokensIn = data.prompt_eval_count || 0;
    const tokensOut = data.eval_count || 0;

    log(TAG, `ollama ${hasImages ? "vision" : "text"}: model=${model} latency=${latencyMs}ms tokens=${tokensIn}+${tokensOut}`);

    // Parse the response (same format as OpenRouter)
    // Parse JSON response (same logic as callModel)
    try {
      const jsonStr = content.replace(/^```\w*\s*\n?/, "").replace(/\n?\s*```\s*$/, "").trim();
      const parsed = JSON.parse(jsonStr);
      return {
        hud: asText(parsed.hud, "\u2014"),
        digest: asText(parsed.digest, "\u2014"),
        record: parseRecord(parsed),
        task: parseTask(parsed),
        // Raw {line,...} array; analyzeContext resolves it against the line list.
        regions: (Array.isArray(parsed.regions) && parsed.regions.length ? parsed.regions : undefined),
        latencyMs,
        tokensIn, tokensOut,
        model,
        parsedOk: true,
      };
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          if (parsed.hud) {
            return {
              hud: asText(parsed.hud, "\u2014"),
              digest: asText(parsed.digest, "\u2014"),
              record: parseRecord(parsed),
              task: parseTask(parsed),
              // Raw {line,...} array; analyzeContext resolves it against the line list.
        regions: (Array.isArray(parsed.regions) && parsed.regions.length ? parsed.regions : undefined),
              latencyMs,
              tokensIn, tokensOut,
              model,
              parsedOk: true,
            };
          }
        } catch {}
      }
      return {
        hud: content.slice(0, 160) || "\u2014",
        digest: content || "\u2014",
        latencyMs,
        tokensIn, tokensOut,
        model,
        parsedOk: false,
      };
    }
  } finally {
    clearTimeout(timeout);
  }
}
