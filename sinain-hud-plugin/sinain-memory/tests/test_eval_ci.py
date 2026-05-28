"""Wave 0 — failing tests for Wilson + bootstrap CI helpers in evaluate.py.
Implementation lands in Plan 03 (Wave 1)."""
from __future__ import annotations
import pytest


class TestWilsonCi:
    def test_wilson_matches_reference(self):
        from eval.benchmarks.evaluate import wilson_ci
        lo, hi = wilson_ci(82, 100)
        # scipy.stats.binomtest(82, 100).proportion_ci(method='wilson') reference
        assert 0.73 < lo < 0.74
        assert 0.88 < hi < 0.89
        assert lo < 0.82 < hi

    def test_wilson_extreme_zero(self):
        from eval.benchmarks.evaluate import wilson_ci
        lo, hi = wilson_ci(0, 100)
        assert lo >= 0.0
        assert hi > 0.0  # upper bound non-trivial — no division by zero

    def test_wilson_extreme_full(self):
        from eval.benchmarks.evaluate import wilson_ci
        lo, hi = wilson_ci(100, 100)
        assert lo < 1.0
        assert hi <= 1.0

    def test_wilson_zero_total(self):
        from eval.benchmarks.evaluate import wilson_ci
        lo, hi = wilson_ci(0, 0)
        assert (lo, hi) == (0.0, 1.0)  # uninformative — full range


class TestBootstrapCi:
    def test_bootstrap_deterministic(self):
        """Fixed seed=42 → identical CIs across runs (RESEARCH.md § Pitfall 4)."""
        from eval.benchmarks.evaluate import bootstrap_ci
        labels = [1, 0, 1, 1, 0, 1, 0, 1, 1, 0] * 10
        lo1, hi1 = bootstrap_ci(labels, n_resamples=1000)
        lo2, hi2 = bootstrap_ci(labels, n_resamples=1000)
        assert lo1 == lo2
        assert hi1 == hi2

    def test_bootstrap_brackets_mean(self):
        from eval.benchmarks.evaluate import bootstrap_ci
        labels = [1, 0, 1, 1, 0, 1, 0, 1, 1, 0] * 10  # mean = 0.6
        lo, hi = bootstrap_ci(labels, n_resamples=1000)
        assert lo < 0.6 < hi

    def test_bootstrap_empty(self):
        from eval.benchmarks.evaluate import bootstrap_ci
        lo, hi = bootstrap_ci([], n_resamples=1000)
        assert (lo, hi) == (0.0, 1.0)


class TestPairedBootstrapDeltaCi:
    def test_paired_bootstrap_delta_zero_when_identical(self):
        from eval.benchmarks.evaluate import paired_bootstrap_delta_ci
        labels = [1, 0, 1, 1, 0] * 20
        lo, hi = paired_bootstrap_delta_ci(labels, labels, n_resamples=1000)
        # Identical inputs → diff is exactly zero → CI brackets 0
        assert lo <= 0.0 <= hi

    def test_paired_bootstrap_delta_positive(self):
        from eval.benchmarks.evaluate import paired_bootstrap_delta_ci
        # b strictly dominates a per-position
        a = [0] * 100
        b = [1] * 100
        lo, hi = paired_bootstrap_delta_ci(a, b, n_resamples=1000)
        assert lo > 0.5  # confident positive delta

    def test_paired_bootstrap_requires_same_length(self):
        from eval.benchmarks.evaluate import paired_bootstrap_delta_ci
        with pytest.raises(AssertionError):
            paired_bootstrap_delta_ci([1, 0], [1, 0, 1])
