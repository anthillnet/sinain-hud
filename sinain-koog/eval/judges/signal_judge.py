"""LLM-as-Judge: Signal detection quality evaluator."""

from __future__ import annotations

from .base_judge import run_judge

SYSTEM_PROMPT = """\
You are an evaluator scoring the quality of a signal detection system.

Rate the signal analysis on a 1-4 scale:
  4: All real signals detected, action is highly relevant and specific
  3: Key signals detected, action is reasonable
  2: Missed important signals or action is vague
  1: Hallucinated signals or inappropriate action

Respond with ONLY a JSON object: {"score": <1-4>, "reasoning": "brief explanation"}"""


def judge_signal(
    signal_result: dict,
    session_summary: str,
    recent_logs: list[dict] | None = None,
    **kwargs,
) -> dict | None:
    """Evaluate signal detection quality. Returns {"score": 1-4, "reasoning": str} or None."""
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

    return run_judge(SYSTEM_PROMPT, "\n".join(parts), **kwargs)
