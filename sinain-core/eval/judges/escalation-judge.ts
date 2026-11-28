/**
 * LLM-as-judge for escalation quality.
 * Uses a small/cheap model to rate whether the escalation decision was appropriate.
 *
 * Rubric: {1: Fail, 2: Partial, 3: Good, 4: Excellent}
 */

export interface JudgeResult {
  score: number;  // 1-4
  reasoning: string;
}

export async function judgeEscalation(
  digest: string,
  shouldHaveEscalated: boolean,
  didEscalate: boolean,
  escalationScore: number,
  context: string,
  apiKey: string,
  model = "anthropic/claude-3.5-haiku",
): Promise<JudgeResult> {
  const prompt = `You are evaluating an AI system's escalation decision.

## Context
${context}

## Agent's Digest
${digest}

## Decision
- Expected: ${shouldHaveEscalated ? "ESCALATE" : "DO NOT ESCALATE"}
- Actual: ${didEscalate ? "ESCALATED" : "DID NOT ESCALATE"}
- Escalation score: ${escalationScore}

## Rubric
Rate the escalation decision on a 1-4 scale:
1 = FAIL: Wrong decision that would harm user experience (missed critical error, or spammed irrelevant escalation)
2 = PARTIAL: Decision was borderline wrong but understandable
3 = GOOD: Correct decision with appropriate reasoning
4 = EXCELLENT: Perfect decision with nuanced understanding of context

Respond with JSON only: {"score": N, "reasoning": "..."}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    if (!response.ok) return { score: 0, reasoning: `HTTP ${response.status}` };

    const data = await response.json() as any;
    const raw = data.choices?.[0]?.message?.content?.trim() || "";

    try {
      const parsed = JSON.parse(raw.replace(/^```\w*\n?/, "").replace(/\n?```$/, ""));
      return { score: parsed.score || 0, reasoning: parsed.reasoning || "" };
    } catch {
      return { score: 0, reasoning: `Parse error: ${raw.slice(0, 100)}` };
    }
  } catch (err: any) {
    return { score: 0, reasoning: `Error: ${err.message}` };
  } finally {
    clearTimeout(timeout);
  }
}
