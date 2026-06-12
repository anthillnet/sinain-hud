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
You are evaluating whether a predicted answer correctly answers a question \
by comparing it against the GOLD (reference) answer ONLY.

STEP 1: Classify the GOLD answer:
  - "informative": gold answer provides specific information (e.g. "Target", "25 minutes", "Business Administration")
  - "abstention": gold answer itself indicates the info is unknown/unavailable \
(e.g. gold = "I don't know" or "not mentioned" or "no information available")

STEP 2: Classify the PREDICTED answer:
  - "informative": predicted answer attempts a specific claim
  - "abstention": predicted answer says "I don't know" / "not mentioned" / "I cannot recall" / similar

STEP 3: Score using the matrix:

  Gold=informative, Predicted=informative:
    5: Perfect — captures all key info from gold, no errors
    4: Mostly correct — minor omissions, main point right
    3: Partial — captures some key points, misses important details
    2: Related but mostly wrong
    1: Contradicts gold

  Gold=informative, Predicted=abstention:
    1 (ALWAYS). The information exists in the source per the gold answer, \
but the predicted answer failed to find it. Score 1 regardless of how politely \
the prediction abstains.

  Gold=abstention, Predicted=abstention:
    5. Both correctly indicate no info available.

  Gold=abstention, Predicted=informative:
    1. The prediction hallucinated information.

Other rules:
- Numeric answers within 10% of gold = full credit.
- Surface form differences with same meaning = full credit ("two weeks" = "14 days").

You ONLY see the question, gold, and predicted. Do NOT reason about what was or \
wasn't "in the conversation history" — you don't have access to the conversation. \
If the gold says X and the prediction says "I don't know", that's a 1.

Respond with ONLY a JSON object: {"score": <1-5>, "reasoning": "brief explanation"}"""


def judge_qa(
    question: str,
    gold_answer: str,
    predicted_answer: str,
    *,
    condition: str = "",
    model: str | None = None,
) -> dict | None:
    """Score a QA answer. Returns {"score": 1-5, "reasoning": str} or None on failure.

    Deterministic — uses temperature=0 so identical inputs produce identical
    outputs. Without this, OpenRouter's default temperature of 1.0 produces
    ~20% score variance on the same call.
    """
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
            "temperature": 0.0,
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
