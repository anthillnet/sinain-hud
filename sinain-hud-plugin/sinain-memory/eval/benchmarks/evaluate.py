"""Evaluation pipeline — score answers and compute aggregate metrics.

Combines:
- LLM-as-Judge (QA scoring, 1-5 scale)
- Retrieval metrics (Recall@k, NDCG@k)
- Token F1 overlap (mechanical, free)
"""

from __future__ import annotations

import math
import re
from collections import defaultdict

import numpy as np
from scipy.stats import binomtest, bootstrap

from .config import K_VALUES


# ── Confidence Interval helpers (EVAL-03) ────────────────────────────────────

def wilson_ci(correct: int, total: int, confidence: float = 0.95) -> tuple[float, float]:
    """95% Wilson confidence interval for a binomial proportion.

    Returns (lower, upper) bounds in [0, 1]. For total == 0, returns (0.0, 1.0)
    (uninformative — full range).

    Uses scipy.stats.binomtest(k, n).proportion_ci(method='wilson'), which is
    the standard reference for binomial-proportion CIs and handles small-N
    edge cases (e.g., k == 0 or k == n) without division-by-zero.
    """
    if total <= 0:
        return (0.0, 1.0)
    ci = binomtest(correct, total).proportion_ci(confidence_level=confidence, method="wilson")
    return (float(ci.low), float(ci.high))


def bootstrap_ci(
    labels: list[int],
    confidence: float = 0.95,
    n_resamples: int = 1000,
    seed: int = 42,
) -> tuple[float, float]:
    """Percentile bootstrap 95% CI for the mean of binary labels.

    Deterministic: fixed integer seed (default 42) → identical CIs across runs.
    Empty input returns (0.0, 1.0) — uninformative.
    """
    if not labels:
        return (0.0, 1.0)
    arr = np.asarray(labels)
    res = bootstrap(
        (arr,),
        np.mean,
        n_resamples=n_resamples,
        confidence_level=confidence,
        method="percentile",
        random_state=seed,
    )
    return (float(res.confidence_interval.low), float(res.confidence_interval.high))


def paired_bootstrap_delta_ci(
    labels_a: list[int],
    labels_b: list[int],
    confidence: float = 0.95,
    n_resamples: int = 1000,
    seed: int = 42,
) -> tuple[float, float]:
    """Paired bootstrap 95% CI on the per-position delta (b - a).

    Use this for ablation-vs-baseline deltas where labels_a and labels_b are
    scored on the same question set (paired). Requires len(a) == len(b).
    """
    assert len(labels_a) == len(labels_b), "paired_bootstrap requires same-length label lists"
    if not labels_a:
        return (0.0, 0.0)
    a = np.asarray(labels_a, dtype=float)
    b = np.asarray(labels_b, dtype=float)
    diff = b - a
    res = bootstrap(
        (diff,),
        np.mean,
        n_resamples=n_resamples,
        confidence_level=confidence,
        method="percentile",
        random_state=seed,
    )
    return (float(res.confidence_interval.low), float(res.confidence_interval.high))


def aggregate_paper_results(
    per_question: list[dict],
    *,
    paper_label_key: str = "paper_label",
    condition: str = "sinain-memory",
) -> dict:
    """LongMemEval paper-aligned aggregation.

    Returns:
        {
          "judge_mode": "paper",
          "per_task": {<question_type>: {accuracy, ci_low, ci_high, n}},
          "task_averaged": {accuracy, ci_low, ci_high},  # bootstrap mean-of-means
          "overall": {accuracy, ci_low, ci_high, n},     # Wilson
          "abstention": {accuracy, ci_low, ci_high, n},  # Wilson on '_abs' subset
        }

    paper_label_key: the per-question dict key holding the paper-judge binary
        label (0 or 1). Set by runner.py when judge_mode='paper'.
    condition: which condition column to aggregate. Default 'sinain-memory'.
    """
    by_type: dict[str, list[int]] = defaultdict(list)
    abstention: list[int] = []
    overall: list[int] = []

    for q in per_question:
        ans = q.get("answers", {}).get(condition, {})
        label = ans.get(paper_label_key)
        if label is None:
            continue
        label_int = 1 if label else 0
        cat = q.get("category") or q.get("question_type")
        if cat:
            by_type[cat].append(label_int)
        overall.append(label_int)
        qid = q.get("id") or q.get("question_id") or ""
        if "_abs" in qid:
            abstention.append(label_int)

    per_task: dict[str, dict] = {}
    for cat in sorted(by_type):
        labels = by_type[cat]
        n = len(labels)
        k = sum(labels)
        acc = k / n if n else 0.0
        lo, hi = wilson_ci(k, n)
        per_task[cat] = {
            "accuracy": round(acc, 4),
            "ci_low": round(lo, 4),
            "ci_high": round(hi, 4),
            "n": n,
        }

    # Task-averaged: bootstrap over the per-category accuracies (mean-of-means).
    # Each resample draws categories with replacement and averages their accuracies.
    cat_accuracies = [d["accuracy"] for d in per_task.values()]
    task_avg = sum(cat_accuracies) / len(cat_accuracies) if cat_accuracies else 0.0
    if len(cat_accuracies) >= 2:
        arr = np.asarray(cat_accuracies)
        res = bootstrap(
            (arr,),
            np.mean,
            n_resamples=1000,
            confidence_level=0.95,
            method="percentile",
            random_state=42,
        )
        ta_lo = float(res.confidence_interval.low)
        ta_hi = float(res.confidence_interval.high)
    else:
        ta_lo, ta_hi = (0.0, 1.0)

    n_overall = len(overall)
    k_overall = sum(overall)
    overall_acc = k_overall / n_overall if n_overall else 0.0
    o_lo, o_hi = wilson_ci(k_overall, n_overall)

    abs_n = len(abstention)
    abs_k = sum(abstention)
    abs_acc = abs_k / abs_n if abs_n else 0.0
    a_lo, a_hi = wilson_ci(abs_k, abs_n)

    return {
        "judge_mode": "paper",
        "per_task": per_task,
        "task_averaged": {
            "accuracy": round(task_avg, 4),
            "ci_low": round(ta_lo, 4),
            "ci_high": round(ta_hi, 4),
        },
        "overall": {
            "accuracy": round(overall_acc, 4),
            "ci_low": round(o_lo, 4),
            "ci_high": round(o_hi, 4),
            "n": n_overall,
        },
        "abstention": {
            "accuracy": round(abs_acc, 4),
            "ci_low": round(a_lo, 4),
            "ci_high": round(a_hi, 4),
            "n": abs_n,
        },
    }


# ── Token F1 (mechanical, no LLM needed) ─────────────────────────────────────

def _tokenize(text: str) -> list[str]:
    """Simple whitespace + punctuation tokenizer."""
    return re.findall(r"\w+", text.lower())


def token_f1(predicted: str, gold: str | int) -> float:
    """Compute token-level F1 between predicted and gold answers."""
    pred_tokens = set(_tokenize(str(predicted)))
    gold_tokens = set(_tokenize(str(gold)))
    if not gold_tokens or not pred_tokens:
        return 0.0
    overlap = pred_tokens & gold_tokens
    if not overlap:
        return 0.0
    precision = len(overlap) / len(pred_tokens)
    recall = len(overlap) / len(gold_tokens)
    return 2 * precision * recall / (precision + recall)


# ── Retrieval metrics (reuse logic from retrieval_evaluator.py) ───────────────

def dcg_at_k(relevant_positions: list[int], k: int) -> float:
    """Discounted Cumulative Gain at k."""
    score = 0.0
    for pos in relevant_positions:
        if pos < k:
            score += 1.0 / math.log2(pos + 2)
    return score


def ndcg_at_k(relevant_positions: list[int], num_relevant: int, k: int) -> float:
    """Normalized DCG at k."""
    dcg = dcg_at_k(relevant_positions, k)
    ideal_positions = list(range(min(num_relevant, k)))
    idcg = dcg_at_k(ideal_positions, k)
    return dcg / idcg if idcg > 0 else 0.0


def compute_retrieval_metrics(
    retrieved_ids: list[str],
    expected_ids: list[str],
    k_values: list[int] | None = None,
) -> dict:
    """Compute Recall@k and NDCG@k for a single question."""
    ks = k_values or K_VALUES
    expected_set = set(expected_ids)
    relevant_positions = [i for i, rid in enumerate(retrieved_ids) if rid in expected_set]

    result = {}
    for k in ks:
        hit = any(pos < k for pos in relevant_positions)
        result[f"recall@{k}"] = 1.0 if hit else 0.0
        result[f"ndcg@{k}"] = ndcg_at_k(relevant_positions, len(expected_set), k)
    return result


# ── Aggregate metrics ─────────────────────────────────────────────────────────

def aggregate_results(per_question: list[dict]) -> dict:
    """Compute aggregate metrics from per-question results.

    Each per_question entry has:
      {id, category, retrieval: {recall@k, ndcg@k}, answers: {condition: {score, f1}}}
    """
    if not per_question:
        return {"error": "no results"}

    # Per-condition scores
    condition_scores: dict[str, list[float]] = defaultdict(list)
    condition_f1s: dict[str, list[float]] = defaultdict(list)
    # Per-category per-condition
    cat_scores: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    # Retrieval
    retrieval_metrics: dict[str, list[float]] = defaultdict(list)

    for q in per_question:
        cat = q.get("category", "unknown")

        for cond, data in q.get("answers", {}).items():
            if data.get("score") is not None:
                condition_scores[cond].append(data["score"])
                cat_scores[cat][cond].append(data["score"])
            if data.get("f1") is not None:
                condition_f1s[cond].append(data["f1"])

        for metric, val in q.get("retrieval", {}).items():
            if isinstance(val, (int, float)):
                retrieval_metrics[metric].append(val)

    def _mean(lst: list[float]) -> float:
        return round(sum(lst) / len(lst), 4) if lst else 0.0

    # Build summary
    conditions = {}
    for cond in sorted(condition_scores):
        conditions[cond] = {
            "mean_score": _mean(condition_scores[cond]),
            "mean_f1": _mean(condition_f1s.get(cond, [])),
            "n": len(condition_scores[cond]),
        }

    # IPR: sinain-memory vs full-context
    sm_scores = condition_scores.get("sinain-memory", [])
    fc_scores = condition_scores.get("full-context", [])
    ipr = _mean(sm_scores) / _mean(fc_scores) if fc_scores and _mean(fc_scores) > 0 else None

    # Category breakdown
    categories = {}
    for cat in sorted(cat_scores):
        categories[cat] = {}
        for cond in sorted(cat_scores[cat]):
            categories[cat][cond] = {
                "mean_score": _mean(cat_scores[cat][cond]),
                "n": len(cat_scores[cat][cond]),
            }

    # Retrieval summary
    retrieval = {k: _mean(v) for k, v in sorted(retrieval_metrics.items())}

    return {
        "total_questions": len(per_question),
        "conditions": conditions,
        "ipr": round(ipr, 4) if ipr else None,
        "categories": categories,
        "retrieval": retrieval,
    }
