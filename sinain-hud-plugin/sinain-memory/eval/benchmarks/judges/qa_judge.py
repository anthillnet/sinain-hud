"""LLM-as-Judge: QA answer quality evaluator (LongMemEval-compatible, 1-5 scale).

Uses GPT-4o via OpenRouter for comparability with published results.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Add sinain-memory to path for common imports
_koog_dir = str(Path(__file__).resolve().parent.parent.parent.parent)
if _koog_dir not in sys.path:
    sys.path.insert(0, _koog_dir)

from common import LLMError, call_llm, extract_json  # noqa: E402

SYSTEM_PROMPT = """\
You are evaluating whether a predicted answer correctly answers a question.
The gold (reference) answer is provided.

Score on a scale of 1-5:
  5: Perfect — captures all key information from the gold answer, no errors
  4: Mostly correct — minor omissions or imprecision, main point is right
  3: Partially correct — captures some key points but misses important details
  2: Related but mostly wrong — touches the topic but answer is largely incorrect
  1: Completely wrong, contradicts the gold answer, or says "I don't know" when the answer exists

Special cases:
- If the gold answer indicates abstention is correct (e.g. "I don't know" or "not mentioned"),
  then a predicted "I don't know" scores 5.
- Numeric answers within 10% of gold = full credit.
- Getting the gist right but missing specifics = 3-4 depending on importance.

Respond with ONLY a JSON object: {"score": <1-5>, "reasoning": "brief explanation"}"""


def judge_qa(
    question: str,
    gold_answer: str,
    predicted_answer: str,
    *,
    condition: str = "",
    model: str | None = None,
) -> dict | None:
    """Score a QA answer. Returns {"score": 1-5, "reasoning": str} or None on failure."""
    user_parts = [
        f"## Question\n{question}",
        f"\n## Gold Answer\n{gold_answer}",
        f"\n## Predicted Answer\n{predicted_answer}",
    ]
    if condition:
        user_parts.append(f"\n## Context Condition: {condition}")

    try:
        kwargs: dict = {
            "system_prompt": SYSTEM_PROMPT,
            "user_prompt": "\n".join(user_parts),
            "max_tokens": 200,
            "json_mode": True,
        }
        if model:
            kwargs["model"] = model
        else:
            kwargs["script"] = "meeting_benchmark"

        raw = call_llm(**kwargs)
        result = extract_json(raw)

        score = result.get("score")
        reasoning = result.get("reasoning", "")

        if not isinstance(score, (int, float)) or not (1 <= score <= 5):
            print(f"[warn] qa_judge returned invalid score: {score}", file=sys.stderr)
            return None

        return {"score": int(score), "reasoning": str(reasoning)[:300]}

    except (ValueError, LLMError, KeyError) as e:
        print(f"[warn] qa_judge call failed: {e}", file=sys.stderr)
        return None
