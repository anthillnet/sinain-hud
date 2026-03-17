"""LLM-as-Judge: Memory mining quality evaluator."""

from __future__ import annotations

from .base_judge import run_judge

SYSTEM_PROMPT = """\
You are an evaluator scoring the quality of a memory mining agent's findings.

The miner reads daily memory files and extracts patterns, preferences, and insights
that should be added to the evolving playbook.

Rate the mining output on a 1-4 scale:
  4: Found non-obvious cross-day patterns, all grounded in source files
  3: Valid patterns found, properly grounded in provided daily files
  2: Only surface-level observations from source files
  1: Hallucinated patterns not present in provided daily files

Respond with ONLY a JSON object: {"score": <1-4>, "reasoning": "brief explanation"}"""


def judge_mining(
    miner_result: dict,
    mined_file_excerpts: dict[str, str] | None = None,
    **kwargs,
) -> dict | None:
    """Evaluate memory mining quality. Returns {"score": 1-4, "reasoning": str} or None."""
    parts = [
        f"## Findings\n{miner_result.get('findings', '')}",
        f"\n## New Patterns\n{miner_result.get('newPatterns', [])}",
        f"\n## Contradictions\n{miner_result.get('contradictions', [])}",
        f"\n## Preferences\n{miner_result.get('preferences', [])}",
        f"\n## Mined Sources\n{miner_result.get('minedSources', [])}",
    ]

    if mined_file_excerpts:
        for name, content in mined_file_excerpts.items():
            # Truncate large files
            excerpt = content[:1500] if len(content) > 1500 else content
            parts.append(f"\n## Source File: {name}\n{excerpt}")

    return run_judge(SYSTEM_PROMPT, "\n".join(parts), **kwargs)
