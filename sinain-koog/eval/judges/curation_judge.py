"""LLM-as-Judge: Playbook curation quality evaluator."""

from __future__ import annotations

from .base_judge import run_judge

SYSTEM_PROMPT = """\
You are an evaluator scoring the quality of playbook curation changes.

The curator follows a directive and three laws:
  Law 1: Don't remove error-prevention patterns
  Law 2: Preserve high-scoring approaches
  Law 3: Then evolve

Rate the curation on a 1-4 scale:
  4: Changes perfectly match directive + evidence, three laws respected
  3: Good changes, minor alignment issues with directive
  2: Changes misaligned with directive or weak evidence
  1: Destructive changes, violated three laws, or ignored directive entirely

Respond with ONLY a JSON object: {"score": <1-4>, "reasoning": "brief explanation"}"""


def judge_curation(
    curator_result: dict,
    directive: str,
    playbook_before: str = "",
    **kwargs,
) -> dict | None:
    """Evaluate playbook curation quality. Returns {"score": 1-4, "reasoning": str} or None."""
    changes = curator_result.get("changes", {})
    stale_actions = curator_result.get("staleItemActions", [])
    lines = curator_result.get("playbookLines", "?")

    parts = [
        f"## Curate Directive\n{directive}",
        f"\n## Changes Made\nAdded: {changes.get('added', [])}\nPruned: {changes.get('pruned', [])}\nPromoted: {changes.get('promoted', [])}",
        f"\n## Stale Item Actions\n{stale_actions}",
        f"\n## Playbook Lines After: {lines}",
    ]

    if playbook_before:
        # Truncate to keep prompt manageable
        parts.append(f"\n## Playbook Before (excerpt)\n{playbook_before[:1500]}")

    return run_judge(SYSTEM_PROMPT, "\n".join(parts), **kwargs)
