"""Tests for tick_evaluator.py + eval/schemas.py + eval/assertions.py + common retry."""

import json
from pathlib import Path
from unittest.mock import patch, call

from common import LLMError, call_llm_with_fallback
from eval.schemas import validate, SCHEMA_REGISTRY
from eval.assertions import (
    assert_playbook_under_limit,
    assert_curator_respected_directive,
    assert_no_repeat_action,
    assert_signal_confidence_threshold,
    assert_insight_char_limit,
    assert_skip_reason_specific,
    assert_miner_references_sources,
    assert_playbook_header_footer_intact,
    assert_schema_valid,
    run_tick_assertions,
)
from tick_evaluator import validate_tick_schemas, load_eval_config


# ═══════════════════════════════════════════════════════════════════════════
# Schema validation tests
# ═══════════════════════════════════════════════════════════════════════════

class TestSchemaValidation:
    def test_valid_signal_analyzer(self):
        data = {"signals": [{"description": "signal1", "priority": "high"}], "recommendedAction": None, "idle": False}
        errors = validate(data, SCHEMA_REGISTRY["signal_analyzer"])
        assert errors == []

    def test_valid_signal_with_action(self):
        data = {
            "signals": [{"description": "sig", "priority": "medium"}],
            "recommendedAction": {"action": "sessions_spawn", "task": "debug", "confidence": 0.8},
            "idle": False,
        }
        errors = validate(data, SCHEMA_REGISTRY["signal_analyzer"])
        assert errors == []

    def test_valid_signal_with_null_task(self):
        data = {
            "signals": [{"description": "idle detected", "priority": "low"}],
            "recommendedAction": {"action": "skip", "task": None, "confidence": 0.9},
            "idle": True,
        }
        errors = validate(data, SCHEMA_REGISTRY["signal_analyzer"])
        assert errors == []

    def test_invalid_signal_missing_required(self):
        data = {"signals": [{"description": "sig", "priority": "high"}]}  # missing idle, recommendedAction
        errors = validate(data, SCHEMA_REGISTRY["signal_analyzer"])
        assert any("idle" in e for e in errors)

    def test_valid_feedback_analyzer(self):
        data = {
            "feedbackScores": {"avg": 0.5, "high": ["a"], "low": ["b"]},
            "effectiveness": {"outputs": 10, "positive": 7, "negative": 1, "neutral": 2, "rate": 0.7},
            "curateDirective": "normal",
            "interpretation": "Good patterns",
        }
        errors = validate(data, SCHEMA_REGISTRY["feedback_analyzer"])
        assert errors == []

    def test_invalid_directive_value(self):
        data = {
            "feedbackScores": {"avg": 0.5},
            "effectiveness": {"outputs": 0, "positive": 0, "negative": 0, "neutral": 0, "rate": 0.0},
            "curateDirective": "invalid_value",
        }
        errors = validate(data, SCHEMA_REGISTRY["feedback_analyzer"])
        assert any("curateDirective" in e or "not in" in e for e in errors)

    def test_valid_memory_miner(self):
        data = {
            "findings": "Found patterns",
            "newPatterns": ["pattern1"],
            "minedSources": ["2026-02-21.md"],
        }
        errors = validate(data, SCHEMA_REGISTRY["memory_miner"])
        assert errors == []

    def test_valid_playbook_curator(self):
        data = {
            "changes": {"added": ["new"], "pruned": ["old"], "promoted": []},
            "staleItemActions": [],
            "playbookLines": 25,
        }
        errors = validate(data, SCHEMA_REGISTRY["playbook_curator"])
        assert errors == []

    def test_valid_insight_skip(self):
        data = {"skip": True, "skipReason": "No new patterns since last analysis"}
        errors = validate(data, SCHEMA_REGISTRY["insight_synthesizer"])
        assert errors == []

    def test_valid_insight_output(self):
        data = {
            "skip": False,
            "suggestion": "Try frame batching",
            "insight": "Evening correlates with exploration",
            "totalChars": 55,
        }
        errors = validate(data, SCHEMA_REGISTRY["insight_synthesizer"])
        assert errors == []

    def test_valid_insight_without_skip(self):
        data = {
            "suggestion": "Try frame batching",
            "insight": "Evening correlates with exploration",
            "totalChars": 55,
        }
        errors = validate(data, SCHEMA_REGISTRY["insight_synthesizer"])
        assert errors == []

    def test_confidence_out_of_range(self):
        data = {
            "signals": [],
            "recommendedAction": {"action": "sessions_spawn", "task": "x", "confidence": 1.5},
            "idle": False,
        }
        errors = validate(data, SCHEMA_REGISTRY["signal_analyzer"])
        # oneOf fails because the object variant rejects confidence > 1.0
        assert len(errors) > 0
        assert any("oneOf" in e or "maximum" in e for e in errors)

    def test_negative_playbook_lines(self):
        data = {
            "changes": {"added": [], "pruned": [], "promoted": []},
            "playbookLines": -1,
        }
        errors = validate(data, SCHEMA_REGISTRY["playbook_curator"])
        assert any("minimum" in e for e in errors)


# ═══════════════════════════════════════════════════════════════════════════
# Assertion tests
# ═══════════════════════════════════════════════════════════════════════════

class TestPlaybookUnderLimit:
    def test_under_limit(self):
        r = assert_playbook_under_limit({"playbookLines": 30})
        assert r["passed"] is True

    def test_at_limit(self):
        r = assert_playbook_under_limit({"playbookLines": 50})
        assert r["passed"] is True

    def test_over_limit(self):
        r = assert_playbook_under_limit({"playbookLines": 55})
        assert r["passed"] is False

    def test_custom_limit(self):
        r = assert_playbook_under_limit({"playbookLines": 80}, limit=100)
        assert r["passed"] is True


class TestCuratorRespectedDirective:
    def test_aggressive_prune_with_pruning(self):
        r = assert_curator_respected_directive(
            {"changes": {"added": [], "pruned": ["x"], "promoted": []}},
            "aggressive_prune",
        )
        assert r["passed"] is True

    def test_aggressive_prune_without_pruning(self):
        r = assert_curator_respected_directive(
            {"changes": {"added": ["new"], "pruned": [], "promoted": []}},
            "aggressive_prune",
        )
        assert r["passed"] is False

    def test_stability_conservative(self):
        r = assert_curator_respected_directive(
            {"changes": {"added": ["a"], "pruned": [], "promoted": []}},
            "stability",
        )
        assert r["passed"] is True

    def test_stability_too_aggressive(self):
        r = assert_curator_respected_directive(
            {"changes": {"added": [], "pruned": ["a", "b", "c", "d"], "promoted": []}},
            "stability",
        )
        assert r["passed"] is False

    def test_normal_anything_goes(self):
        r = assert_curator_respected_directive(
            {"changes": {"added": ["a", "b"], "pruned": ["c"], "promoted": []}},
            "normal",
        )
        assert r["passed"] is True


class TestNoRepeatAction:
    def test_no_action(self):
        r = assert_no_repeat_action({"recommendedAction": None}, [])
        assert r["passed"] is True

    def test_skip_action(self):
        r = assert_no_repeat_action({"recommendedAction": {"action": "skip"}}, [])
        assert r["passed"] is True

    def test_distinct_action(self):
        recent = [{"actionsConsidered": [{"chosen": True, "reason": "Research Flutter overlays"}]}]
        r = assert_no_repeat_action(
            {"recommendedAction": {"action": "sessions_spawn", "task": "Debug OCR backpressure"}},
            recent,
        )
        assert r["passed"] is True

    def test_repeated_action(self):
        recent = [{"actionsConsidered": [{"chosen": True, "reason": "Debug OCR backpressure issue"}]}]
        r = assert_no_repeat_action(
            {"recommendedAction": {"action": "sessions_spawn", "task": "Debug OCR backpressure"}},
            recent,
        )
        assert r["passed"] is False


class TestSignalConfidenceThreshold:
    def test_above_threshold(self):
        r = assert_signal_confidence_threshold(
            {"recommendedAction": {"action": "sessions_spawn", "confidence": 0.8}}
        )
        assert r["passed"] is True

    def test_below_threshold(self):
        r = assert_signal_confidence_threshold(
            {"recommendedAction": {"action": "sessions_spawn", "confidence": 0.3}}
        )
        assert r["passed"] is False

    def test_no_confidence(self):
        r = assert_signal_confidence_threshold(
            {"recommendedAction": {"action": "sessions_spawn"}}
        )
        assert r["passed"] is False

    def test_no_action(self):
        r = assert_signal_confidence_threshold({"recommendedAction": None})
        assert r["passed"] is True


class TestInsightCharLimit:
    def test_under_limit(self):
        r = assert_insight_char_limit({"suggestion": "short", "insight": "also short"})
        assert r["passed"] is True

    def test_over_limit(self):
        r = assert_insight_char_limit({"suggestion": "x" * 300, "insight": "y" * 300})
        assert r["passed"] is False

    def test_skipped_output(self):
        r = assert_insight_char_limit({"skip": True})
        assert r["passed"] is True


class TestSkipReasonSpecific:
    def test_specific_reason(self):
        r = assert_skip_reason_specific({
            "skip": True,
            "skipReason": "No new patterns detected in playbook since last tick; mining-index shows 2026-02-21 was already processed"
        })
        assert r["passed"] is True

    def test_generic_reason(self):
        r = assert_skip_reason_specific({"skip": True, "skipReason": "no new data"})
        assert r["passed"] is False

    def test_no_reason(self):
        r = assert_skip_reason_specific({"skip": True})
        assert r["passed"] is False

    def test_not_skipped(self):
        r = assert_skip_reason_specific({"skip": False})
        assert r["passed"] is True


class TestMinerReferencesSources:
    def test_valid_sources(self):
        r = assert_miner_references_sources(
            {"minedSources": ["2026-02-21.md"]},
            ["2026-02-21.md", "2026-02-20.md"],
        )
        assert r["passed"] is True

    def test_unknown_sources(self):
        r = assert_miner_references_sources(
            {"minedSources": ["2026-02-21.md", "fake-file.md"]},
            ["2026-02-21.md"],
        )
        assert r["passed"] is False

    def test_no_sources(self):
        r = assert_miner_references_sources({"minedSources": []}, [])
        assert r["passed"] is True


class TestPlaybookHeaderFooterIntact:
    def test_both_present(self):
        text = "<!-- mining-index: 2026-02-21 -->\nbody\n<!-- effectiveness: rate=0.5 -->"
        r = assert_playbook_header_footer_intact(text)
        assert r["passed"] is True

    def test_missing_header(self):
        r = assert_playbook_header_footer_intact("body\n<!-- effectiveness: rate=0.5 -->")
        assert r["passed"] is False
        assert "mining-index" in r["detail"]

    def test_missing_footer(self):
        r = assert_playbook_header_footer_intact("<!-- mining-index: 2026-02-21 -->\nbody")
        assert r["passed"] is False
        assert "effectiveness" in r["detail"]


# ═══════════════════════════════════════════════════════════════════════════
# Integration: validate_tick_schemas
# ═══════════════════════════════════════════════════════════════════════════

class TestValidateTickSchemas:
    def test_full_log_entry(self, sample_log_entry):
        result = validate_tick_schemas(sample_log_entry)
        assert result["total"] > 0
        assert result["valid"] == result["total"]
        assert result["failures"] == []

    def test_empty_log_entry(self):
        result = validate_tick_schemas({})
        assert result["total"] == 0


# ═══════════════════════════════════════════════════════════════════════════
# Integration: run_tick_assertions
# ═══════════════════════════════════════════════════════════════════════════

class TestRunTickAssertions:
    def test_all_pass_on_good_entry(self, sample_log_entry):
        playbook = "<!-- mining-index: 2026-02-21 -->\nbody\n<!-- effectiveness: rate=0.5 -->"
        results = run_tick_assertions(sample_log_entry, [], playbook, ["2026-02-21.md"])
        assert all(r["passed"] for r in results), [r for r in results if not r["passed"]]

    def test_detects_failures(self):
        bad_entry = {
            "signals": [],
            "recommendedAction": {"action": "sessions_spawn", "task": "x", "confidence": 0.2},
            "playbookChanges": {
                "changes": {"added": ["a", "b"], "pruned": [], "promoted": []},
                "playbookLines": 55,
            },
            "curateDirective": "aggressive_prune",
            "output": {"skip": True, "skipReason": "no new data"},
        }
        results = run_tick_assertions(bad_entry, [], "", [])
        failed = [r for r in results if not r["passed"]]
        failed_names = {r["name"] for r in failed}
        assert "signal_confidence_threshold" in failed_names
        assert "playbook_under_limit" in failed_names
        assert "curator_respected_directive" in failed_names
        assert "skip_reason_specific" in failed_names


# ═══════════════════════════════════════════════════════════════════════════
# Config
# ═══════════════════════════════════════════════════════════════════════════

class TestLoadEvalConfig:
    def test_defaults(self, tmp_path):
        memory_dir = str(tmp_path)
        config = load_eval_config(memory_dir)
        assert config["level"] == "mechanical"
        assert config["sampleRate"] == 0.2

    def test_runtime_override(self, tmp_path):
        override = {"level": "full", "changedAt": "2026-02-28T10:00:00Z"}
        (tmp_path / "eval-config.json").write_text(json.dumps(override))
        config = load_eval_config(str(tmp_path))
        assert config["level"] == "full"


# ═══════════════════════════════════════════════════════════════════════════
# call_llm_with_fallback retry logic
# ═══════════════════════════════════════════════════════════════════════════

class TestCallLlmWithFallback:
    @patch("common.time.sleep")
    @patch("common.call_llm")
    def test_succeeds_on_retry(self, mock_call, mock_sleep):
        """First attempt fails with LLMError, second succeeds."""
        mock_call.side_effect = [
            LLMError("timeout"),
            '{"changes": {"added": ["x"], "pruned": [], "promoted": []}}',
        ]
        result = call_llm_with_fallback("sys", "usr", script="playbook_curator", json_mode=True)
        assert '"added": ["x"]' in result
        assert mock_call.call_count == 2
        mock_sleep.assert_called_once_with(1)  # 2^0 = 1s backoff

    @patch("common.time.sleep")
    @patch("common.call_llm")
    def test_raises_after_all_retries_exhausted(self, mock_call, mock_sleep):
        """Both attempts fail → raises the last LLMError."""
        mock_call.side_effect = LLMError("persistent failure")
        import pytest
        with pytest.raises(LLMError, match="persistent failure"):
            call_llm_with_fallback("sys", "usr", retries=1)
        assert mock_call.call_count == 2

    @patch("common.call_llm")
    def test_succeeds_first_try_no_retry(self, mock_call):
        """If first attempt succeeds, no retry or sleep happens."""
        mock_call.return_value = '{"ok": true}'
        result = call_llm_with_fallback("sys", "usr")
        assert result == '{"ok": true}'
        assert mock_call.call_count == 1

    @patch("common.time.sleep")
    @patch("common.call_llm")
    def test_exponential_backoff(self, mock_call, mock_sleep):
        """With retries=2, backoff should be 1s then 2s."""
        mock_call.side_effect = [
            LLMError("fail1"),
            LLMError("fail2"),
            "success",
        ]
        result = call_llm_with_fallback("sys", "usr", retries=2)
        assert result == "success"
        assert mock_sleep.call_args_list == [call(1), call(2)]
