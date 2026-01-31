import type { TriggerConfig, TriggerResult, Priority } from "./types.js";
import { log, warn } from "./log.js";

const TAG = "trigger";

const CLASSIFICATION_PROMPT = `You are a conversation analysis classifier. Given a transcript excerpt, determine whether it should be escalated to a human operator for real-time assistance.

Evaluate these triggers:
1. QUESTION — a direct question is being asked that needs an answer
2. NEGOTIATION — pricing, terms, or deal discussion is happening
3. FACTUAL_CLAIM — a specific factual claim is made that may need verification
4. TOPIC_CHANGE — conversation topic has shifted significantly
5. PERIODIC — enough new context has accumulated for a routine update

If none apply, respond with SKIP.

Respond in JSON only:
{"shouldEscalate": true/false, "trigger": "QUESTION|NEGOTIATION|FACTUAL_CLAIM|TOPIC_CHANGE|PERIODIC|SKIP", "priority": "normal|high|urgent", "summary": "one-line summary"}`;

const NOISE_PATTERNS = [
  /^(um+|uh+|ah+|oh+|hmm+|huh|eh|mhm+|yeah+|ok+|okay)[\s.,!?]*$/i,
  /^can you hear me/i,
  /^(hello|hi|hey)[\s.,!?]*$/i,
  /^(testing|test)[\s.,!?]*$/i,
  /^\s*$/,
];

const MIN_MEANINGFUL_LENGTH = 12;

export class TriggerEngine {
  private config: TriggerConfig;

  constructor(config: TriggerConfig) {
    this.config = config;
  }

  /** Check if a text chunk is noise that should be filtered out. */
  isNoise(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length < MIN_MEANINGFUL_LENGTH) return true;
    return NOISE_PATTERNS.some((p) => p.test(trimmed));
  }

  /** Classify whether a context summary should be escalated. */
  async classify(contextSummary: string): Promise<TriggerResult> {
    if (!this.config.enabled) {
      return { shouldEscalate: true, trigger: "PERIODIC", priority: "normal", summary: "trigger disabled — pass-through" };
    }

    if (!this.config.apiKey) {
      warn(TAG, "no API key configured, defaulting to pass-through");
      return { shouldEscalate: true, trigger: "PERIODIC", priority: "normal", summary: "no API key — pass-through" };
    }

    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: "system", content: CLASSIFICATION_PROMPT },
            { role: "user", content: contextSummary },
          ],
          max_tokens: 200,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        warn(TAG, `API error: ${res.status} ${res.statusText}`);
        return { shouldEscalate: true, trigger: "PERIODIC", priority: "normal", summary: "API error — pass-through" };
      }

      const data = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
      };

      const raw = data.choices?.[0]?.message?.content?.trim();
      if (!raw) {
        warn(TAG, "empty response from classifier");
        return { shouldEscalate: true, trigger: "PERIODIC", priority: "normal", summary: "empty response — pass-through" };
      }

      // Extract JSON from response (may be wrapped in markdown code blocks)
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        warn(TAG, `unparseable response: ${raw.slice(0, 100)}`);
        return { shouldEscalate: true, trigger: "PERIODIC", priority: "normal", summary: "parse error — pass-through" };
      }

      const result = JSON.parse(jsonMatch[0]) as {
        shouldEscalate: boolean;
        trigger: string;
        priority: string;
        summary: string;
      };

      const priority = (["normal", "high", "urgent"].includes(result.priority)
        ? result.priority
        : "normal") as Priority;

      log(TAG, `classified: ${result.trigger} (escalate=${result.shouldEscalate}, priority=${priority}) — ${result.summary}`);

      return {
        shouldEscalate: result.shouldEscalate,
        trigger: result.trigger,
        priority,
        summary: result.summary,
      };
    } catch (err) {
      warn(TAG, `classification error:`, err instanceof Error ? err.message : err);
      return { shouldEscalate: true, trigger: "PERIODIC", priority: "normal", summary: "error — pass-through" };
    }
  }
}
