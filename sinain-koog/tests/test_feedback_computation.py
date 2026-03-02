"""Tests for feedback_analyzer.py: compute_effectiveness() and determine_directive()."""

from feedback_analyzer import compute_effectiveness, determine_directive, extract_feedback_scores


class TestComputeEffectiveness:
    def test_no_logs(self):
        result = compute_effectiveness([])
        assert result == {"outputs": 0, "positive": 0, "negative": 0, "neutral": 0, "rate": 0.0}

    def test_all_skipped(self):
        logs = [{"ts": "2026-02-28T10:00:00Z", "skipped": True}] * 5
        result = compute_effectiveness(logs)
        assert result["outputs"] == 0

    def test_positive_outcomes(self):
        logs = [
            {"ts": "2026-02-28T10:00:00Z", "skipped": False},
            {"ts": "2026-02-28T10:30:00Z", "skipped": True, "feedbackScores": {"avg": 0.5}},
            {"ts": "2026-02-28T11:00:00Z", "skipped": False},
            {"ts": "2026-02-28T11:30:00Z", "skipped": True, "feedbackScores": {"avg": 0.6}},
        ]
        result = compute_effectiveness(logs)
        assert result["outputs"] == 2
        assert result["positive"] == 2
        assert result["rate"] == 1.0

    def test_negative_outcomes(self):
        logs = [
            {"ts": "2026-02-28T10:00:00Z", "skipped": False},
            {"ts": "2026-02-28T10:30:00Z", "skipped": True, "feedbackScores": {"avg": -0.5}},
        ]
        result = compute_effectiveness(logs)
        assert result["negative"] == 1

    def test_neutral_for_last_tick(self):
        """Last tick with output has no next tick for feedback — counted as neutral."""
        logs = [{"ts": "2026-02-28T10:00:00Z", "skipped": False}]
        result = compute_effectiveness(logs)
        assert result["neutral"] == 1

    def test_mixed_outcomes(self):
        logs = [
            {"ts": "2026-02-28T10:00:00Z", "skipped": False},
            {"ts": "2026-02-28T10:30:00Z", "feedbackScores": {"avg": 0.5}},  # positive
            {"ts": "2026-02-28T11:00:00Z", "skipped": False},
            {"ts": "2026-02-28T11:30:00Z", "feedbackScores": {"avg": -0.3}},  # negative
            {"ts": "2026-02-28T12:00:00Z", "skipped": False},
            {"ts": "2026-02-28T12:30:00Z", "feedbackScores": {"avg": 0.05}},  # neutral
        ]
        result = compute_effectiveness(logs)
        assert result["outputs"] == 3
        assert result["positive"] == 1
        assert result["negative"] == 1
        assert result["neutral"] == 1
        assert result["rate"] == round(1 / 3, 2)

    def test_rate_is_rounded(self):
        logs = [
            {"ts": f"2026-02-28T1{i}:00:00Z", "skipped": False}
            for i in range(3)
        ] + [
            {"ts": f"2026-02-28T1{i}:30:00Z", "feedbackScores": {"avg": 0.5}}
            for i in range(3)
        ]
        result = compute_effectiveness(logs)
        assert isinstance(result["rate"], float)


class TestDetermineDirective:
    def test_insufficient_data(self):
        assert determine_directive({"outputs": 3, "rate": 0.8}) == "insufficient_data"
        assert determine_directive({"outputs": 0, "rate": 0.0}) == "insufficient_data"
        assert determine_directive({"outputs": 4, "rate": 0.5}) == "insufficient_data"

    def test_aggressive_prune(self):
        assert determine_directive({"outputs": 10, "rate": 0.2}) == "aggressive_prune"
        assert determine_directive({"outputs": 5, "rate": 0.39}) == "aggressive_prune"

    def test_stability(self):
        assert determine_directive({"outputs": 10, "rate": 0.8}) == "stability"
        assert determine_directive({"outputs": 5, "rate": 0.71}) == "stability"

    def test_normal(self):
        assert determine_directive({"outputs": 10, "rate": 0.5}) == "normal"
        assert determine_directive({"outputs": 5, "rate": 0.4}) == "normal"
        assert determine_directive({"outputs": 5, "rate": 0.7}) == "normal"

    def test_boundary_values(self):
        # Exactly 5 outputs is enough data
        assert determine_directive({"outputs": 5, "rate": 0.5}) != "insufficient_data"
        # rate=0.4 is normal (not aggressive_prune)
        assert determine_directive({"outputs": 5, "rate": 0.4}) == "normal"
        # rate=0.7 is normal (not stability)
        assert determine_directive({"outputs": 5, "rate": 0.7}) == "normal"


class TestExtractFeedbackScores:
    def test_empty_logs(self):
        result = extract_feedback_scores([])
        assert result["avg"] == 0
        assert result["high"] == []
        assert result["low"] == []

    def test_with_scores(self):
        logs = [
            {"feedbackScores": {"avg": 0.5, "high": ["good A"], "low": ["bad A"]}},
            {"feedbackScores": {"avg": 0.3, "high": ["good B"], "low": []}},
        ]
        result = extract_feedback_scores(logs)
        assert result["avg"] == 0.4
        assert "good A" in result["high"]
        assert "good B" in result["high"]

    def test_limits_to_5_patterns(self):
        logs = [
            {"feedbackScores": {"avg": 0.1, "high": [f"pattern {i}"], "low": []}}
            for i in range(10)
        ]
        result = extract_feedback_scores(logs)
        assert len(result["high"]) <= 5
