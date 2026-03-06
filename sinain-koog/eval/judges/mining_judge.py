"""LLM-as-Judge: Memory mining quality evaluator."""

from __future__ import annotations

from .base_judge import run_judge, run_multi_judge

_DIMENSIONS = ["groundedness", "depth"]

SYSTEM_PROMPT = """\
You are an evaluator scoring the quality of a memory mining agent's findings.

The miner reads daily memory files and extracts patterns, preferences, and insights
that should be added to the evolving playbook.

Rate on TWO dimensions (1-4 each):
  groundedness: Are all findings traceable to specific source files?
    4=all grounded with specific references, 3=mostly grounded, 2=vague references, 1=hallucinated
  depth: Do the findings surface non-obvious cross-day patterns?
    4=cross-day patterns, 3=valid single-day patterns, 2=surface-level, 1=trivial/obvious

Respond with ONLY a JSON object:
{"scores": {"groundedness": <1-4>, "depth": <1-4>}, "reasoning": "brief explanation"}"""


def judge_mining(
    miner_result: dict,
    mined_file_excerpts: dict[str, str] | None = None,
    **kwargs,
) -> dict | None:
    """Evaluate memory mining quality.

    Returns {"scores": {"groundedness": int, "depth": int}, "score": int, "reasoning": str}
    or None.
    """
    parts = [
        f"## Findings\n{miner_result.get('findings', '')}",
        f"\n## New Patterns\n{miner_result.get('newPatterns', [])}",
        f"\n## Contradictions\n{miner_result.get('contradictions', [])}",
        f"\n## Preferences\n{miner_result.get('preferences', [])}",
        f"\n## Mined Sources\n{miner_result.get('minedSources', [])}",
    ]

    if mined_file_excerpts:
        for name, content in mined_file_excerpts.items():
            excerpt = content[:1500] if len(content) > 1500 else content
            parts.append(f"\n## Source File: {name}\n{excerpt}")

    return run_multi_judge(SYSTEM_PROMPT, "\n".join(parts), _DIMENSIONS, **kwargs)
