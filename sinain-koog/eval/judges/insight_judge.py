"""LLM-as-Judge: Insight synthesis quality evaluator."""

from __future__ import annotations

from .base_judge import run_judge

SYSTEM_PROMPT = """\
You are an evaluator scoring the quality of an insight synthesizer's output.

The synthesizer produces two parts:
  - Suggestion: actionable recommendation grounded in playbook/data
  - Insight: surprising cross-domain connection from accumulated observations

Rate the output on a 1-4 scale:
  4: Suggestion is actionable with specific reference, insight connects 2+ distinct observations
  3: One component is excellent, the other adequate
  2: Generic suggestion or obvious insight
  1: Hallucinated content, not grounded in playbook/logs

If the output was skipped, rate the skip decision:
  4: Skip is well-justified with specific references to what was checked
  3: Skip is reasonable
  2: Should not have skipped — there was material to work with
  1: Skip reason is generic/lazy

Respond with ONLY a JSON object: {"score": <1-4>, "reasoning": "brief explanation"}"""


def judge_insight(
    synth_result: dict,
    playbook_excerpt: str = "",
    **kwargs,
) -> dict | None:
    """Evaluate insight synthesis quality. Returns {"score": 1-4, "reasoning": str} or None."""
    skipped = synth_result.get("skip", False)

    parts = []
    if skipped:
        parts.append(f"## Status: SKIPPED\nReason: {synth_result.get('skipReason', 'none given')}")
    else:
        parts.append(f"## Suggestion\n{synth_result.get('suggestion', '')}")
        parts.append(f"\n## Insight\n{synth_result.get('insight', '')}")
        parts.append(f"\n## Total Chars: {synth_result.get('totalChars', '?')}")

    if playbook_excerpt:
        parts.append(f"\n## Playbook Context (excerpt)\n{playbook_excerpt[:1000]}")

    return run_judge(SYSTEM_PROMPT, "\n".join(parts), **kwargs)
