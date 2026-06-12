"""LLM-as-Judge: LongMemEval paper-standard binary judge.

Verbatim port of upstream src/evaluation/evaluate_qa.py from
github.com/xiaowu0162/LongMemEval (ICLR 2025).

DO NOT EDIT the prompt strings — they ARE the protocol. Any local change
invalidates paper-comparability.

Locked decision D-01 (2026-05-26): judge model = deepseek/deepseek-v4-flash.
SUPERSEDED 2026-05-27 → openai/gpt-4o-2024-08-06. Reason: deepseek-v4-flash
is a reasoning model; the verbatim paper port uses max_tokens=10 which is
consumed entirely by hidden reasoning → empty completions → uniform
paper_label=0 (subset n=20 on 2026-05-27 returned 0.0% with 12/18 empty
responses). gpt-4o-2024-08-06 matches the paper + Hindsight reference
exactly at comparable per-call cost for this binary-judge workload (~$0.20
for n=500). The Plan 06 baseline-doc D-07 comparability footer is now
emitted dynamically by variance_attribution._comparability_footer(judge).

This module is ADDITIVE — it sits alongside qa_judge.py (1-5 graded judge
that backs acme IPR tracking / GATE-02). Both judges remain operational;
runner.py selects via --judge-mode {paper, legacy}.
"""
from __future__ import annotations
import sys
from pathlib import Path

# Bootstrap sinain-memory imports — same pattern as qa_judge.py L8-13
_koog_dir = str(Path(__file__).resolve().parent.parent.parent.parent)
if _koog_dir not in sys.path:
    sys.path.insert(0, _koog_dir)

import common  # noqa: E402
from common import LLMError  # noqa: E402

# Default judge model — D-01 (deepseek/deepseek-v4-flash) SUPERSEDED 2026-05-27.
# See module docstring for rationale: reasoning-model token accounting breaks the
# verbatim max_tokens=10 paper port. gpt-4o-2024-08-06 is the paper's exact judge,
# eliminates the D-07 comparability caveat, and lands at comparable per-call cost
# for binary yes/no judging on this workload.
DEFAULT_JUDGE_MODEL = "openai/gpt-4o-2024-08-06"

# ===========================================================================
# VERBATIM upstream prompts — see evaluate_qa.py in xiaowu0162/LongMemEval.
# DO NOT modify these strings.
# ===========================================================================

STANDARD_PROMPT = (
    "I will give you a question, a correct answer, and a response from a model. "
    "Please answer yes if the response contains the correct answer. Otherwise, "
    "answer no. If the response is equivalent to the correct answer or contains "
    "all the intermediate steps to get the correct answer, you should also "
    "answer yes. If the response only contains a subset of the information "
    "required by the answer, answer no."
)

TEMPORAL_SUFFIX = " In addition, do not penalize off-by-one errors for the number of days."

KNOWLEDGE_UPDATE_SUFFIX = (
    " If the response contains some previous information along with an updated "
    "answer, the response should be considered as correct as long as the "
    "updated answer is the required answer."
)

PREFERENCE_PROMPT = (
    "I will give you a question, a rubric for desired personalized response, and a "
    "response from a model. Please answer yes if the response satisfies the desired "
    "response. Otherwise, answer no. The model does not need to reflect all the "
    "points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly."
)

ABSTENTION_PROMPT = "Does the model correctly identify the question as unanswerable?"


def _build_prompt(
    question_type: str,
    question_id: str,
    question: str,
    gold: str,
    response: str,
) -> str:
    """Build the per-question-type judge prompt.

    Branching order matches upstream evaluate_qa.py:
      1. '_abs' in question_id  -> abstention (overrides question_type)
      2. question_type == 'temporal-reasoning' -> STANDARD + temporal suffix
      3. question_type == 'knowledge-update' -> STANDARD + knowledge-update suffix
      4. question_type == 'single-session-preference' -> preference prompt (replaces standard)
      5. anything else -> STANDARD
    """
    if "_abs" in question_id:
        intro = ABSTENTION_PROMPT
    elif question_type == "temporal-reasoning":
        intro = STANDARD_PROMPT + TEMPORAL_SUFFIX
    elif question_type == "knowledge-update":
        intro = STANDARD_PROMPT + KNOWLEDGE_UPDATE_SUFFIX
    elif question_type == "single-session-preference":
        intro = PREFERENCE_PROMPT
    else:
        intro = STANDARD_PROMPT
    return (
        f"{intro}\n\n"
        f"Question: {question}\n"
        f"Correct Answer: {gold}\n"
        f"Model Response: {response}"
    )


def judge_paper(
    question_type: str,
    question_id: str,
    question: str,
    gold: str,
    response: str,
    *,
    model: str = DEFAULT_JUDGE_MODEL,
) -> bool:
    """Binary paper-standard judge. Returns True if model response is judged correct.

    Parsing: 'yes' in raw.lower() -- verbatim upstream behavior.
    On LLM failure (after common.call_llm's retry_on_empty=5 exhausted): returns False.

    Args:
        question_type: one of single-session-user, single-session-assistant,
            single-session-preference, multi-session, temporal-reasoning,
            knowledge-update.
        question_id: question identifier; '_abs' substring -> abstention prompt.
        question: question text.
        gold: gold/reference answer (or rubric for preference questions).
        response: model-generated response being evaluated.
        model: judge model id (default: deepseek/deepseek-v4-flash per D-01).
    """
    prompt = _build_prompt(question_type, question_id, question, gold, response)
    try:
        raw = common.call_llm(
            "",
            prompt,
            model=model,
            temperature=0.0,
            max_tokens=10,
            json_mode=False,
            seed=12345,  # reproducible binary verdict (see common.call_llm seed)
        )
    except LLMError as e:
        print(f"[warn] longmemeval_judge call_llm failed for {question_id}: {e}", file=sys.stderr)
        return False
    if not raw:
        print(f"[warn] longmemeval_judge empty response for {question_id}", file=sys.stderr)
        return False
    lowered = raw.lower()
    # Diagnostic: log mixed-signal responses (RESEARCH.md § Pitfall 6). Does
    # NOT change the return value — match upstream parser exactly.
    if "yes" in lowered and "no" in lowered:
        print(
            f"[warn] longmemeval_judge mixed-signal output for {question_id}: {raw!r}",
            file=sys.stderr,
        )
    return "yes" in lowered
