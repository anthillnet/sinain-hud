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

from .base_adapter import BenchmarkQuestion
from .config import K_VALUES


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
