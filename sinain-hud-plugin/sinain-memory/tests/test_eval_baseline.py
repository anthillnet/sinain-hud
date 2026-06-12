"""Wave 0 — failing tests for baseline document writer.
Implementation lands in Plan 06 (Wave 4)."""
from __future__ import annotations
import json
import re
from pathlib import Path
import pytest


SAMPLE_RESULT = {
    "task_averaged": {"accuracy": 0.42, "ci_low": 0.38, "ci_high": 0.46},
    "overall": {"accuracy": 0.45, "ci_low": 0.41, "ci_high": 0.49, "n": 500},
    "abstention": {"accuracy": 0.30, "ci_low": 0.18, "ci_high": 0.45, "n": 40},
    "per_task": {
        "single-session-user": {"accuracy": 0.50, "ci_low": 0.40, "ci_high": 0.60, "n": 90},
        "single-session-assistant": {"accuracy": 0.45, "ci_low": 0.35, "ci_high": 0.55, "n": 80},
        "single-session-preference": {"accuracy": 0.40, "ci_low": 0.22, "ci_high": 0.60, "n": 30},
        "multi-session": {"accuracy": 0.35, "ci_low": 0.27, "ci_high": 0.44, "n": 110},
        "temporal-reasoning": {"accuracy": 0.30, "ci_low": 0.22, "ci_high": 0.40, "n": 95},
        "knowledge-update": {"accuracy": 0.50, "ci_low": 0.40, "ci_high": 0.60, "n": 95},
    },
    "judge_model": "deepseek/deepseek-v4-flash",
    "judge_temperature": 0.0,
    "judge_max_tokens": 10,
    "qa_model": "google/gemini-2.5-flash",
    "qa_temperature": 0.0,
    "n_questions": 500,
    "dataset_version": "longmemeval_s_cleaned.json (xiaowu0162/longmemeval-cleaned, 2025-01 release)",
    "sinain_commit": "abc1234",
    "sinain_branch": "feat/memory-profile-adoption",
    "date_run": "2026-05-26",
    "ablation": "none",
    "profile": "eval",
}


class TestBaselineDocSchema:
    def test_baseline_doc_schema(self, tmp_path):
        from eval.benchmarks.ablation.variance_attribution import write_baseline
        md_path = tmp_path / "BASELINE-2026-05-26.md"
        json_path = tmp_path / "BASELINE-2026-05-26.json"
        write_baseline(SAMPLE_RESULT, md_path, json_path)
        md = md_path.read_text()
        # YAML front-matter delimiters
        assert md.startswith("---\n")
        assert "\n---\n" in md[4:]
        # Required front-matter keys
        for key in ["benchmark:", "dataset_version:", "sinain_commit:", "sinain_branch:",
                    "date_run:", "scoring_protocol:", "judge_model:", "judge_temperature:",
                    "judge_max_tokens:", "qa_model:", "qa_temperature:",
                    "n_questions:", "ablation:", "profile:"]:
            assert key in md, f"Missing required front-matter key: {key}"

    def test_baseline_json_sidecar_present(self, tmp_path):
        from eval.benchmarks.ablation.variance_attribution import write_baseline
        md_path = tmp_path / "BASELINE-2026-05-26.md"
        json_path = tmp_path / "BASELINE-2026-05-26.json"
        write_baseline(SAMPLE_RESULT, md_path, json_path)
        assert json_path.exists()
        data = json.loads(json_path.read_text())
        assert data["overall"]["accuracy"] == 0.45
        assert data["judge_model"] == "deepseek/deepseek-v4-flash"

    def test_baseline_documents_judge_tradeoff_footer(self, tmp_path):
        """D-07: comparability footer documents DeepSeek-V4-Flash != GPT-4o paper choice."""
        from eval.benchmarks.ablation.variance_attribution import write_baseline
        md_path = tmp_path / "BASELINE-2026-05-26.md"
        json_path = tmp_path / "BASELINE-2026-05-26.json"
        write_baseline(SAMPLE_RESULT, md_path, json_path)
        md = md_path.read_text().lower()
        # The footer MUST surface the trade-off
        assert "deepseek" in md
        assert "gpt-4o" in md or "gpt4o" in md
        assert "comparable" in md or "comparability" in md or "trend" in md

    def test_baseline_atomic_write(self, tmp_path, monkeypatch):
        """Tmp+rename pattern — no partial file ever visible at target path."""
        from eval.benchmarks.ablation.variance_attribution import write_baseline
        md_path = tmp_path / "BASELINE-2026-05-26.md"
        json_path = tmp_path / "BASELINE-2026-05-26.json"

        seen_paths = []
        from pathlib import Path as _P
        original_replace = _P.replace
        def _spy_replace(self, target):
            seen_paths.append((str(self), str(target)))
            return original_replace(self, target)
        monkeypatch.setattr(_P, "replace", _spy_replace)

        write_baseline(SAMPLE_RESULT, md_path, json_path)
        # At least one tmp+rename observed for the .md write
        assert any(".tmp" in src for src, _ in seen_paths)
