"""LLM-as-Judge: Playbook curation quality evaluator."""

from __future__ import annotations

from .base_judge import run_judge, run_multi_judge

_DIMENSIONS = ["directive_alignment", "evidence_quality"]

SYSTEM_PROMPT = """\
You are an evaluator scoring the quality of playbook curation changes.

The curator follows a directive and three laws:
  Law 1: Don't remove error-prevention patterns
  Law 2: Preserve high-scoring approaches
  Law 3: Then evolve

Rate on TWO dimensions (1-4 each):
  directive_alignment: Do the changes match the curate directive and respect the three laws?
    4=perfect match + laws respected, 3=good with minor issues, 2=misaligned, 1=destructive/ignored
  evidence_quality: Are the changes backed by concrete evidence from logs/metrics?
    4=strong evidence cited, 3=reasonable evidence, 2=weak/missing evidence, 1=no evidence

Respond with ONLY a JSON object:
{"scores": {"directive_alignment": <1-4>, "evidence_quality": <1-4>}, "reasoning": "brief explanation"}"""


def judge_curation(
    curator_result: dict,
    directive: str,
    playbook_before: str = "",
    **kwargs,
) -> dict | None:
    """Evaluate playbook curation quality.

    Returns {"scores": {"directive_alignment": int, "evidence_quality": int}, "score": int, "reasoning": str}
    or None.
    """
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
        parts.append(f"\n## Playbook Before (excerpt)\n{playbook_before[:1500]}")

    return run_multi_judge(SYSTEM_PROMPT, "\n".join(parts), _DIMENSIONS, **kwargs)
