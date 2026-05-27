"""Wave 0 — failing tests for variance_attribution.py report writer.
Implementation lands in Plan 05 (Wave 3).
NOTE: schema ablation deferred (D-03) → variance report has 3 subsystems × 2 modes = 6 rows + baseline = 7 total."""
from __future__ import annotations
import json
from pathlib import Path
import pytest


SAMPLE_SUMMARY = {
    "baseline": {"accuracy": 0.245, "ci_low": 0.213, "ci_high": 0.279, "n": 500},
    "subsystems": {
        "distiller": {
            "passthrough": {"accuracy": 0.182, "ci_low": 0.153, "ci_high": 0.214, "delta_pp": -6.3,
                            "delta_ci_low": -8.1, "delta_ci_high": -4.5},
            "oracle":      {"accuracy": 0.384, "ci_low": 0.347, "ci_high": 0.423, "delta_pp": 13.9,
                            "delta_ci_low": 11.2, "delta_ci_high": 16.4},
        },
        "integrator": {
            "passthrough": {"accuracy": 0.216, "ci_low": 0.186, "ci_high": 0.249, "delta_pp": -2.9,
                            "delta_ci_low": -4.6, "delta_ci_high": -1.2},
            "oracle":      {"accuracy": 0.287, "ci_low": 0.252, "ci_high": 0.325, "delta_pp": 4.2,
                            "delta_ci_low": 2.1, "delta_ci_high": 6.3},
        },
        "retrieval": {
            "passthrough": {"accuracy": 0.158, "ci_low": 0.131, "ci_high": 0.188, "delta_pp": -8.7,
                            "delta_ci_low": -10.4, "delta_ci_high": -7.0},
            "oracle":      {"accuracy": 0.472, "ci_low": 0.434, "ci_high": 0.510, "delta_pp": 22.7,
                            "delta_ci_low": 19.5, "delta_ci_high": 25.8},
        },
    },
    "methodology": {
        "judge_model": "deepseek/deepseek-v4-flash",
        "judge_temperature": 0.0,
        "judge_max_tokens": 10,
        "qa_model": "google/gemini-2.5-flash",
        "n_questions": 500,
        "bootstrap_seed": 42,
        "n_resamples": 1000,
    },
    "commit": "abc1234",
    "date": "2026-05-26",
}


class TestVarianceReportFormat:
    def test_report_format(self, tmp_path):
        from eval.benchmarks.ablation.variance_attribution import write_variance_report
        md_path = tmp_path / "variance.md"
        json_path = tmp_path / "variance.json"
        write_variance_report(SAMPLE_SUMMARY, md_path, json_path)
        md = md_path.read_text()
        # Required table column headers
        assert "Subsystem" in md
        assert "Mode" in md
        assert "Accuracy" in md
        assert "95% CI" in md or "CI" in md
        assert "Δ" in md or "delta" in md.lower() or "Marginal" in md.lower()

    def test_full_table_rows_excluding_schema(self, tmp_path):
        """D-03: schema deferred → 3 subsystems × 2 modes = 6 rows + baseline = 7 total."""
        from eval.benchmarks.ablation.variance_attribution import write_variance_report
        md_path = tmp_path / "variance.md"
        json_path = tmp_path / "variance.json"
        write_variance_report(SAMPLE_SUMMARY, md_path, json_path)
        md = md_path.read_text()
        # Each subsystem-mode pair contributes a row mentioning the subsystem name
        # (case-insensitive containment check is robust to formatting variation)
        for subsystem in ["distiller", "integrator", "retrieval"]:
            assert md.lower().count(subsystem) >= 2  # passthrough + oracle row each
        # Schema should NOT appear (deferred)
        assert "schema" not in md.lower() or "deferred" in md.lower()

    def test_json_sidecar_matches_md(self, tmp_path):
        from eval.benchmarks.ablation.variance_attribution import write_variance_report
        md_path = tmp_path / "variance.md"
        json_path = tmp_path / "variance.json"
        write_variance_report(SAMPLE_SUMMARY, md_path, json_path)
        data = json.loads(json_path.read_text())
        assert data["commit"] == SAMPLE_SUMMARY["commit"]
        assert data["methodology"]["judge_model"] == "deepseek/deepseek-v4-flash"
        assert data["baseline"]["accuracy"] == 0.245
        assert "retrieval" in data["subsystems"]

    def test_report_documents_non_additive_caveat(self, tmp_path):
        """Single-ablation marginal effects don't sum to 100% — must be documented (RESEARCH.md § Variance caveat)."""
        from eval.benchmarks.ablation.variance_attribution import write_variance_report
        md_path = tmp_path / "variance.md"
        json_path = tmp_path / "variance.json"
        write_variance_report(SAMPLE_SUMMARY, md_path, json_path)
        md = md_path.read_text().lower()
        assert "additive" in md or "interact" in md or "do not sum" in md or "marginal" in md
