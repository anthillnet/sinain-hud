import type { AgentConfig, AgentResult, ContextWindow } from "../types.js";
import { normalizeAppName } from "./context-window.js";
import { log, error } from "../log.js";

const TAG = "agent";

/**
 * Build the LLM prompt from a context window.
 * Ported from relay's buildPrompt() — same prompt structure for consistency.
 */
function buildPrompt(ctx: ContextWindow): string {
  const now = Date.now();
  const screenLines = ctx.screen
    .map(e => {
      const app = normalizeAppName(e.meta.app);
      const ago = Math.round((now - (e.ts || now)) / 1000);
      const ocr = e.ocr ? e.ocr.replace(/\n/g, " ").slice(0, ctx.preset.maxOcrChars) : "(no text)";
      return `[${ago}s ago] [${app}] ${ocr}`;
    })
    .join("\n");

  const audioLines = ctx.audio
    .map(e => {
      const ago = Math.round((now - (e.ts || now)) / 1000);
      return `[${ago}s ago] ${e.text.slice(0, ctx.preset.maxTranscriptChars)}`;
    })
    .join("\n");

  const appSwitches = ctx.appHistory
    .map(a => normalizeAppName(a.app))
    .join(" \u2192 ");

  return `You are an AI monitoring a user's screen and audio in real-time.
You produce TWO outputs as JSON.

Active app: ${normalizeAppName(ctx.currentApp)}
App history: ${appSwitches || "(none)"}

Screen (OCR text, newest first):
${screenLines || "(no screen data)"}

Audio transcript (newest first):
${audioLines || "(silence)"}

Respond ONLY with valid JSON. No markdown, no code fences, no explanation.
Your entire response must be parseable by JSON.parse().

{"hud":"<max 15 words: what user is doing NOW>","digest":"<3-5 sentences: detailed activity description>"}

Rules:
- "hud" is for a minimal overlay display. Example: "Editing hud-relay.mjs in IDEA"
- "digest" is for an AI assistant to understand the full situation and offer help.
- If nothing is happening, hud="Idle" and digest explains what was last seen.
- Include specific filenames, URLs, error messages, UI text from OCR in digest.
- Do NOT suggest actions in digest — just describe the situation factually.
- CRITICAL: Output ONLY the JSON object, nothing else.`;
}

/**
 * Call the LLM (OpenRouter) to analyze the context window.
 * Supports model chain: primary + fallbacks.
 */
export async function analyzeContext(
  contextWindow: ContextWindow,
  config: AgentConfig,
): Promise<AgentResult> {
  const prompt = buildPrompt(contextWindow);
  const models = [config.model, ...config.fallbackModels];
  let lastError: Error | null = null;

  for (const model of models) {
    try {
      return await callModel(prompt, model, config);
    } catch (err: any) {
      lastError = err;
      log(TAG, `model ${model} failed: ${err.message || err}, trying next...`);
    }
  }

  throw lastError || new Error("all models failed");
}

async function callModel(
  prompt: string,
  model: string,
  config: AgentConfig,
): Promise<AgentResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.openrouterApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: config.maxTokens,
        temperature: config.temperature,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - start;
    const raw = data.choices?.[0]?.message?.content?.trim() || "";

    // Parse JSON response — try direct parse, then extract embedded JSON, then fallback
    try {
      const jsonStr = raw.replace(/^```\w*\s*\n?/, "").replace(/\n?\s*```\s*$/, "").trim();
      const parsed = JSON.parse(jsonStr);
      return {
        hud: parsed.hud || "\u2014",
        digest: parsed.digest || "\u2014",
        latencyMs,
        tokensIn: data.usage?.prompt_tokens || 0,
        tokensOut: data.usage?.completion_tokens || 0,
        model,
        parsedOk: true,
      };
    } catch {
      // Second chance: extract embedded JSON object
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          if (parsed.hud) {
            return {
              hud: parsed.hud,
              digest: parsed.digest || "\u2014",
              latencyMs,
              tokensIn: data.usage?.prompt_tokens || 0,
              tokensOut: data.usage?.completion_tokens || 0,
              model,
              parsedOk: true,
            };
          }
        } catch { /* fall through */ }
      }

      // Final fallback: use raw text
      log(TAG, `JSON parse failed (model=${model}), raw: "${raw.slice(0, 120)}"`);
      return {
        hud: raw.slice(0, 80) || "\u2014",
        digest: raw || "\u2014",
        latencyMs,
        tokensIn: data.usage?.prompt_tokens || 0,
        tokensOut: data.usage?.completion_tokens || 0,
        model,
        parsedOk: false,
      };
    }
  } finally {
    clearTimeout(timeout);
  }
}
