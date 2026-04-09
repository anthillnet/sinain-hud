#!/usr/bin/env python3
"""Retrieval Quality Evaluator — Recall@k and NDCG@k for knowledge graph queries.

Inspired by mempalace's LongMemEval benchmark infrastructure. Measures whether the
right knowledge surfaces when the agent needs it, complementing sinain's existing
output quality evaluation (schemas + assertions + LLM judges).

Usage:
    python3 eval/retrieval_evaluator.py \
        --db memory/knowledge-graph.db \
        --benchmark eval/retrieval_benchmark.jsonl \
        [--k 1,3,5] [--format json|text]

Benchmark dataset format (JSONL):
    {"query": "OCR pipeline stalls on macOS 14", "expected_entities": ["fact:sck-capture-fix"], "category": "error-resolution"}
"""

import argparse
import json
import math
import sys
from collections import defaultdict
from pathlib import Path


def load_benchmark(path: str) -> list[dict]:
    """Load benchmark QA pairs from JSONL."""
    items = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                items.append(json.loads(line))
    return items


def extract_keywords(query: str) -> list[str]:
    """Extract search keywords from a natural language query."""
    import re
    words = re.findall(r"[a-zA-Z][a-zA-Z0-9-]+", query.lower())
    stopwords = {"the", "is", "in", "on", "for", "and", "or", "of", "to", "a", "an", "it", "was", "not", "how", "what", "when", "does"}
    return [w for w in words if len(w) > 2 and w not in stopwords]


def dcg_at_k(relevant_positions: list[int], k: int) -> float:
    """Compute Discounted Cumulative Gain at k."""
    score = 0.0
    for pos in relevant_positions:
        if pos < k:
            score += 1.0 / math.log2(pos + 2)  # +2 because position is 0-indexed
    return score


def ndcg_at_k(relevant_positions: list[int], num_relevant: int, k: int) -> float:
    """Compute Normalized DCG at k."""
    dcg = dcg_at_k(relevant_positions, k)
    # Ideal DCG: all relevant items at top positions
    ideal_positions = list(range(min(num_relevant, k)))
    idcg = dcg_at_k(ideal_positions, k)
    return dcg / idcg if idcg > 0 else 0.0


def evaluate_retrieval(
    benchmark_path: str,
    db_path: str,
    k_values: list[int] = [1, 3, 5],
) -> dict:
    """Run benchmark queries against graph_query.py, compute Recall@k and NDCG@k."""
    # Import graph_query from parent dir
    sys.path.insert(0, str(Path(__file__).parent.parent))
    from graph_query import query_facts_by_entities

    items = load_benchmark(benchmark_path)
    if not items:
        return {"error": "Empty benchmark dataset"}

    max_k = max(k_values)
    metrics: dict[str, list[float]] = defaultdict(list)
    category_metrics: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    details: list[dict] = []

    for item in items:
        query = item["query"]
        expected = set(item.get("expected_entities", []))
        category = item.get("category", "general")
        keywords = extract_keywords(query)

        if not keywords or not expected:
            continue

        results = query_facts_by_entities(db_path, keywords, max_facts=max_k)
        result_ids = [r["entityId"] for r in results]

        # Find positions of relevant results
        relevant_positions = []
        for i, rid in enumerate(result_ids):
            if rid in expected:
                relevant_positions.append(i)

        for k in k_values:
            hit = any(pos < k for pos in relevant_positions)
            recall = 1.0 if hit else 0.0
            ndcg = ndcg_at_k(relevant_positions, len(expected), k)

            metrics[f"recall@{k}"].append(recall)
            metrics[f"ndcg@{k}"].append(ndcg)
            category_metrics[category][f"recall@{k}"].append(recall)
            category_metrics[category][f"ndcg@{k}"].append(ndcg)

        details.append({
            "query": query,
            "category": category,
            "expected": list(expected),
            "retrieved": result_ids[:max_k],
            "hit@1": any(pos < 1 for pos in relevant_positions),
            "hit@5": any(pos < 5 for pos in relevant_positions),
        })

    # Aggregate
    summary = {
        "total_queries": len(items),
        "evaluated": len(details),
    }
    for metric_name, values in sorted(metrics.items()):
        summary[metric_name] = round(sum(values) / len(values), 4) if values else 0.0

    # Per-category breakdown
    categories = {}
    for cat, cat_metrics in sorted(category_metrics.items()):
        categories[cat] = {
            "count": len(next(iter(cat_metrics.values()))),
        }
        for metric_name, values in sorted(cat_metrics.items()):
            categories[cat][metric_name] = round(sum(values) / len(values), 4) if values else 0.0

    return {
        "summary": summary,
        "categories": categories,
        "details": details,
    }


def format_report_text(result: dict) -> str:
    """Format evaluation result as human-readable text for daily report injection."""
    lines = ["## Retrieval Quality"]
    s = result["summary"]
    for key in sorted(s):
        if key.startswith("recall@") or key.startswith("ndcg@"):
            lines.append(f"- {key}: {s[key]:.2%}")

    if result.get("categories"):
        lines.append("")
        lines.append("**By category:**")
        for cat, cm in sorted(result["categories"].items()):
            r5 = cm.get("recall@5", 0)
            lines.append(f"- {cat} (n={cm['count']}): recall@5={r5:.0%}")

    # Weakest category
    cats = result.get("categories", {})
    if cats:
        weakest = min(cats.items(), key=lambda x: x[1].get("recall@5", 1.0))
        if weakest[1].get("recall@5", 1.0) < 0.8:
            lines.append(f"\n**Weakest**: {weakest[0]} ({weakest[1].get('recall@5', 0):.0%})")

    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Retrieval Quality Evaluator")
    parser.add_argument("--db", required=True, help="Path to knowledge-graph.db")
    parser.add_argument("--benchmark", required=True, help="Path to retrieval_benchmark.jsonl")
    parser.add_argument("--k", default="1,3,5", help="Comma-separated k values for Recall@k")
    parser.add_argument("--format", choices=["json", "text"], default="json", help="Output format")
    args = parser.parse_args()

    k_values = [int(k) for k in args.k.split(",")]
    result = evaluate_retrieval(args.benchmark, args.db, k_values)

    if args.format == "text":
        print(format_report_text(result))
    else:
        print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
