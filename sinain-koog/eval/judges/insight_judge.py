"""LLM-as-Judge: Insight synthesis quality evaluator."""

from __future__ import annotations

from .base_judge import run_judge, run_multi_judge

_DIMENSIONS = ["actionability", "novelty"]

SYSTEM_PROMPT = """\
You are an evaluator scoring the quality of an insight synthesizer's output.

The synthesizer produces two parts:
  - Suggestion: actionable recommendation grounded in playbook/data
  - Insight: surprising cross-domain connection from accumulated observations

Rate on TWO dimensions (1-4 each):
  actionability: Is the suggestion grounded in specific data and actionable?
    4=specific reference + clear next step, 3=reasonable, 2=generic, 1=hallucinated
  novelty: Does the insight connect 2+ distinct observations in a non-obvious way?
    4=cross-domain connection, 3=valid but expected, 2=surface-level, 1=not grounded

If the output was skipped, rate the skip decision:
  actionability: quality of the skip justification (4=specific refs, 1=lazy)
  novelty: N/A for skips — rate as 3 (neutral)

Respond with ONLY a JSON object:
{"scores": {"actionability": <1-4>, "novelty": <1-4>}, "reasoning": "brief explanation"}"""


def judge_insight(
    synth_result: dict,
    playbook_excerpt: str = "",
    **kwargs,
) -> dict | None:
    """Evaluate insight synthesis quality.

    Returns {"scores": {"actionability": int, "novelty": int}, "score": int, "reasoning": str}
    or None.
    """
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

    return run_multi_judge(SYSTEM_PROMPT, "\n".join(parts), _DIMENSIONS, **kwargs)
