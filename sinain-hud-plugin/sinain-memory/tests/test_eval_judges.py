"""Wave 0 — failing tests for paper-binary judge (longmemeval_judge.py).
Implementation lands in Plan 02 (Wave 1)."""
from __future__ import annotations
import json
from pathlib import Path
import pytest

# These imports WILL FAIL until Plan 02 ships longmemeval_judge.py — that is intentional.
# Wave 0 = RED state.


class TestPaperJudgePrompts:
    """Verify per-question-type prompt branching matches upstream evaluate_qa.py verbatim."""

    def test_paper_judge_per_type_prompt(self, mock_llm_responses):
        from eval.benchmarks.judges.longmemeval_judge import _build_prompt
        mock_llm_responses.set([])

        # Standard
        p = _build_prompt("single-session-user", "qid-001", "Q?", "G", "R")
        assert "I will give you a question, a correct answer, and a response from a model." in p

        # Temporal-reasoning APPENDS
        p_temporal = _build_prompt("temporal-reasoning", "qid-002", "Q?", "G", "R")
        assert "off-by-one errors for the number of days" in p_temporal

        # Knowledge-update APPENDS
        p_ku = _build_prompt("knowledge-update", "qid-003", "Q?", "G", "R")
        assert "updated answer is the required answer" in p_ku

        # Single-session-preference REPLACES
        p_pref = _build_prompt("single-session-preference", "qid-004", "Q?", "G", "R")
        assert "recalls and utilizes the user's personal information" in p_pref

        # Abstention (any question_type, _abs in id)
        p_abs = _build_prompt("single-session-user", "qid-005_abs", "Q?", "G", "R")
        assert "Does the model correctly identify the question as unanswerable" in p_abs


class TestPaperJudgeParser:
    """Verify upstream parser semantics ('yes' in output.lower())."""

    @pytest.mark.parametrize("raw,expected", [
        ("yes", True),
        ("Yes.", True),
        ("YES", True),
        ("no", False),
        ("no, the response misses the gold answer", False),
        ("I think yes", True),  # 'yes' substring matches — paper protocol
        ("", False),
    ])
    def test_judge_yes_parser(self, mock_llm, raw, expected):
        mock_llm.set(raw)
        from eval.benchmarks.judges.longmemeval_judge import judge_paper
        result = judge_paper("single-session-user", "qid", "Q?", "G", "R")
        assert result is expected


class TestPaperJudgeModel:
    """D-01 SUPERSEDED 2026-05-27: judge model = openai/gpt-4o-2024-08-06
    (LongMemEval paper's exact judge; matches Hindsight reference; reasoning-
    model max_tokens accounting on DeepSeek-V4-Flash broke verbatim port)."""

    def test_judge_uses_gpt_4o_by_default(self, mock_llm_responses):
        mock_llm_responses.set(["yes"])
        from eval.benchmarks.judges.longmemeval_judge import judge_paper
        judge_paper("single-session-user", "qid", "Q?", "G", "R")
        assert len(mock_llm_responses.calls) == 1
        kwargs = mock_llm_responses.calls[0]["kwargs"]
        assert kwargs.get("model") == "openai/gpt-4o-2024-08-06"
        assert kwargs.get("temperature") == 0.0
        assert kwargs.get("max_tokens") == 10


class TestQuestionTypeCount:
    """D-05: dataset has exactly 6 distinct question_type values (not 9 per stale comment)."""

    def test_dataset_has_six_question_types(self):
        # Locate the dataset file. Per longmemeval_adapter.py:31 it ships from HF
        # cached path. Test is skipped if local copy unavailable.
        candidate_paths = [
            Path(__file__).resolve().parent.parent / "eval" / "benchmarks" / "data" / "longmemeval_s_cleaned.json",
            Path.home() / ".cache" / "sinain" / "longmemeval_s_cleaned.json",
        ]
        dataset_path = next((p for p in candidate_paths if p.exists()), None)
        if dataset_path is None:
            pytest.skip("longmemeval_s_cleaned.json not cached locally — run "
                        "`python3 -m eval.benchmarks.longmemeval_adapter` to download.")
        data = json.loads(dataset_path.read_text())
        types = sorted({q["question_type"] for q in data})
        expected = sorted([
            "single-session-user",
            "single-session-assistant",
            "single-session-preference",
            "multi-session",
            "temporal-reasoning",
            "knowledge-update",
        ])
        assert types == expected, (
            f"Expected 6 question_types ({expected}), got {len(types)}: {types}. "
            f"Stale comment in bench_longmemeval.py:103 says '9 categories' — update it."
        )
