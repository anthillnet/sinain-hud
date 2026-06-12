"""Wave 0 — failing tests for CI-bracket markdown formatting in report.py.
Implementation lands in Plan 03 (Wave 1)."""
from __future__ import annotations
import re


class TestPaperModeMarkdown:
    def test_markdown_shows_ci(self):
        """Paper-mode report must format accuracy with CI brackets: 'XX.X% [YY.Y%, ZZ.Z%]'."""
        from eval.benchmarks.report import generate_markdown
        summary = {
            "judge_mode": "paper",
            "per_task": {
                "single-session-user": {"accuracy": 0.245, "ci_low": 0.213, "ci_high": 0.279, "n": 90},
            },
            "overall": {"accuracy": 0.245, "ci_low": 0.213, "ci_high": 0.279, "n": 500},
            "task_averaged": {"accuracy": 0.245, "ci_low": 0.213, "ci_high": 0.279},
        }
        md = generate_markdown(summary)
        # Format: "24.5% [21.3%, 27.9%]" — number then bracketed CI
        assert re.search(r"\d+\.\d%\s*\[\d+\.\d%,\s*\d+\.\d%\]", md)

    def test_paper_mode_headers(self):
        from eval.benchmarks.report import generate_markdown
        summary = {
            "judge_mode": "paper",
            "per_task": {"single-session-user": {"accuracy": 0.5, "ci_low": 0.4, "ci_high": 0.6, "n": 90}},
            "overall": {"accuracy": 0.5, "ci_low": 0.4, "ci_high": 0.6, "n": 500},
            "task_averaged": {"accuracy": 0.5, "ci_low": 0.4, "ci_high": 0.6},
        }
        md = generate_markdown(summary)
        assert "Accuracy" in md
        assert "95% CI" in md or "CI" in md


class TestLegacyModeMarkdown:
    def test_legacy_mode_unchanged(self):
        """Legacy summary (no judge_mode field or judge_mode='legacy') must still render 1-5 'Mean Score' table — backward compat for acme IPR runs."""
        from eval.benchmarks.report import generate_markdown
        legacy_summary = {
            "conditions": {
                "sinain-memory": {"mean_score": 3.4, "mean_f1": 0.65, "n": 30},
                "full-context":  {"mean_score": 4.2, "mean_f1": 0.78, "n": 30},
            },
        }
        md = generate_markdown(legacy_summary)
        assert "Mean Score (1-5)" in md or "mean_score" in md.lower()
