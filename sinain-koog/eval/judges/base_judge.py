"""Shared infrastructure for LLM-as-Judge evaluators.

Provides ``run_judge()`` which calls the LLM with a rubric prompt and
extracts a ``{"score": 1-4, "reasoning": "..."}`` response.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Add parent dirs so ``common`` is importable when running from anywhere.
_koog_dir = str(Path(__file__).resolve().parent.parent.parent)
if _koog_dir not in sys.path:
    sys.path.insert(0, _koog_dir)

from common import LLMError, call_llm, extract_json  # noqa: E402


def run_judge(
    system_prompt: str,
    user_prompt: str,
    *,
    model: str | None = None,
    max_tokens: int = 200,
    timeout: int = 30,
) -> dict | None:
    """Call LLM with a judge prompt and return ``{"score": int, "reasoning": str}`` or None.

    *model* defaults to the ``eval.judges.model`` setting resolved externally.
    When None, falls back to ``common.call_llm`` defaults (which reads koog-config).
    """
    try:
        kwargs: dict = {
            "system_prompt": system_prompt,
            "user_prompt": user_prompt,
            "max_tokens": max_tokens,
            "json_mode": True,
        }
        # Use script-based config resolution if no explicit model
        if model:
            kwargs["model"] = model
        else:
            kwargs["script"] = "tick_evaluator"

        raw = call_llm(**kwargs)
        result = extract_json(raw)

        score = result.get("score")
        reasoning = result.get("reasoning", "")

        if not isinstance(score, (int, float)) or not (1 <= score <= 4):
            print(f"[warn] judge returned invalid score: {score}", file=sys.stderr)
            return None

        return {"score": int(score), "reasoning": str(reasoning)[:300]}

    except (ValueError, LLMError, KeyError) as e:
        print(f"[warn] judge call failed: {e}", file=sys.stderr)
        return None


def run_multi_judge(
    system_prompt: str,
    user_prompt: str,
    dimensions: list[str],
    *,
    model: str | None = None,
    max_tokens: int = 300,
    timeout: int = 30,
) -> dict | None:
    """Call LLM with a multi-dimension rubric and return structured scores.

    Returns {"scores": {"dim": int, ...}, "score": int, "reasoning": str} or None.
    The composite ``score`` is server-side recomputed as round(mean(dim_scores))
    to guard against LLM arithmetic errors.
    """
    try:
        kwargs: dict = {
            "system_prompt": system_prompt,
            "user_prompt": user_prompt,
            "max_tokens": max_tokens,
            "json_mode": True,
        }
        if model:
            kwargs["model"] = model
        else:
            kwargs["script"] = "tick_evaluator"

        raw = call_llm(**kwargs)
        result = extract_json(raw)

        scores = result.get("scores", {})
        reasoning = str(result.get("reasoning", ""))[:300]

        # Validate that all requested dimensions are present and valid
        dim_scores: dict[str, int] = {}
        for dim in dimensions:
            val = scores.get(dim)
            if not isinstance(val, (int, float)) or not (1 <= val <= 4):
                # Fall back to single-score mode if dimensions missing
                return run_judge(system_prompt, user_prompt, model=model,
                                 max_tokens=max_tokens, timeout=timeout)
            dim_scores[dim] = int(val)

        # Server-side composite: round(mean(sub-scores))
        composite = round(sum(dim_scores.values()) / len(dim_scores))

        return {
            "scores": dim_scores,
            "score": composite,
            "reasoning": reasoning,
        }

    except (ValueError, LLMError, KeyError) as e:
        print(f"[warn] multi-judge call failed: {e}", file=sys.stderr)
        return None
