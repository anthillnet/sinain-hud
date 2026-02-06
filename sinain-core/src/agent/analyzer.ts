import type { AgentConfig, AgentResult, ContextWindow, RecorderStatus, RecordCommand } from "../types.js";
import { normalizeAppName } from "./context-window.js";
import { log, error } from "../log.js";

const TAG = "agent";

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
 * Build the LLM prompt from a context window.
 * Ported from relay's buildPrompt() — same prompt structure for consistency.
 */
function buildPrompt(ctx: ContextWindow, recorderStatus: RecorderStatus | null = null): string {
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

  const recorderSection = buildRecorderSection(recorderStatus);

  return `You are an AI monitoring a user's screen and audio in real-time.
You produce outputs as JSON.

Active app: ${normalizeAppName(ctx.currentApp)}
App history: ${appSwitches || "(none)"}${recorderSection}

Screen (OCR text, newest first):
${screenLines || "(no screen data)"}

Audio transcript (newest first):
${audioLines || "(silence)"}

Respond ONLY with valid JSON. No markdown, no code fences, no explanation.
Your entire response must be parseable by JSON.parse().

{"hud":"...","digest":"...","record":{"command":"start"|"stop","label":"..."},"task":"..."}

Output fields:
- "hud" (required): max 30 words describing what user is doing NOW
- "digest" (required): 3-5 sentences with detailed activity description
- "record" (optional): control recording — {"command":"start","label":"Meeting name"} or {"command":"stop"}
- "task" (optional): natural language instruction to spawn a background task

When to use "record":
- START when user begins a meeting, call, lecture, YouTube video, or important audio content
- STOP when the content ends or user navigates away
- Provide descriptive labels like "Team standup", "Client call", "YouTube: [video title from OCR]"
- For YouTube/video content: extract video title from screen OCR for the label

When to use "task":
- User explicitly asks for research, lookup, or action
- Something needs external search or processing that isn't a real-time response
- Example: "Search for React 19 migration guide", "Find docs for this API"

When to spawn "task" for video content:
- If user watches a YouTube video for 2+ minutes AND no task has been spawned for this video yet, spawn: "Summarize YouTube video: [title or URL from OCR]"
- ONLY spawn ONCE per video - do not repeat spawn for the same video in subsequent ticks
- Extract video title or URL from screen OCR to include in the task

Rules:
- "hud" is for a minimal overlay display. Example: "Editing hud-relay.mjs in IDEA"
- "digest" is for an AI assistant to understand the full situation and offer help.
- If nothing is happening, hud="Idle" and digest explains what was last seen.
- Include specific filenames, URLs, error messages, UI text from OCR in digest.
- Do NOT suggest actions in digest — just describe the situation factually.
- Only include "record" or "task" when genuinely appropriate — most responses won't have them.
- CRITICAL: Output ONLY the JSON object, nothing else.`;
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

/**
 * Call the LLM (OpenRouter) to analyze the context window.
 * Supports model chain: primary + fallbacks.
 */
export async function analyzeContext(
  contextWindow: ContextWindow,
  config: AgentConfig,
  recorderStatus: RecorderStatus | null = null,
): Promise<AgentResult> {
  const prompt = buildPrompt(contextWindow, recorderStatus);
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
        record: parseRecord(parsed),
        task: parseTask(parsed),
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
              record: parseRecord(parsed),
              task: parseTask(parsed),
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
        hud: raw.slice(0, 160) || "\u2014",
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
