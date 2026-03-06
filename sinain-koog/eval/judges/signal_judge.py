"""LLM-as-Judge: Signal detection quality evaluator."""

from __future__ import annotations

from .base_judge import run_judge, run_multi_judge

_DIMENSIONS = ["detection_accuracy", "action_relevance"]

SYSTEM_PROMPT = """\
You are an evaluator scoring the quality of a signal detection system.

Rate on TWO dimensions (1-4 each):
  detection_accuracy: Were the right signals detected from the session context?
    4=all real signals found, 3=key signals found, 2=missed important ones, 1=hallucinated
  action_relevance: Is the recommended action appropriate and specific?
    4=highly relevant + specific, 3=reasonable, 2=vague/generic, 1=inappropriate

Respond with ONLY a JSON object:
{"scores": {"detection_accuracy": <1-4>, "action_relevance": <1-4>}, "reasoning": "brief explanation"}"""


def judge_signal(
    signal_result: dict,
    session_summary: str,
    recent_logs: list[dict] | None = None,
    **kwargs,
) -> dict | None:
    """Evaluate signal detection quality.

    Returns {"scores": {"detection_accuracy": int, "action_relevance": int}, "score": int, "reasoning": str}
    or None.
    """
    parts = [f"## Session Summary\n{session_summary}"]

    signals = signal_result.get("signals", [])
    action = signal_result.get("recommendedAction")
    idle = signal_result.get("idle", False)

    parts.append(f"\n## Detected Signals\n{signals}")
    parts.append(f"\n## Recommended Action\n{action}")
    parts.append(f"\n## Idle: {idle}")

    if recent_logs:
        recent_actions = []
        for log in recent_logs[:3]:
            for a in log.get("actionsConsidered", []):
                if a.get("chosen"):
                    recent_actions.append(a)
        if recent_actions:
            parts.append(f"\n## Recent Actions (should not repeat)\n{recent_actions}")

    return run_multi_judge(SYSTEM_PROMPT, "\n".join(parts), _DIMENSIONS, **kwargs)
