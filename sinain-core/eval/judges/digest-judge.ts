/**
 * LLM-as-judge for digest quality.
 * Evaluates whether the agent's digest accurately captures the user's activity.
 *
 * Rubric: {1: Fail, 2: Partial, 3: Good, 4: Excellent}
 */

export interface DigestJudgeResult {
  score: number;  // 1-4
  reasoning: string;
}

export async function judgeDigest(
  digest: string,
  context: string,
  rubric: string,
  apiKey: string,
  model = "anthropic/claude-3.5-haiku",
): Promise<DigestJudgeResult> {
  const prompt = `You are evaluating an AI agent's digest — a summary of what a user is currently doing, based on screen OCR and audio transcripts.

## Raw Context (screen + audio)
${context}

## Agent's Digest
${digest}

## Evaluation Rubric
${rubric}

## Scoring Scale
1 = FAIL: Digest is factually wrong, hallucinates details, or misses critical information
2 = PARTIAL: Digest captures some activity but misses key details or is too vague
3 = GOOD: Digest accurately describes the user's activity with relevant specifics
4 = EXCELLENT: Digest is precise, includes specific filenames/errors/URLs, and provides useful context

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
