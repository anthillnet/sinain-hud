"""Report generation — markdown, JSON, and LaTeX output."""

from __future__ import annotations

import json
from datetime import datetime, timezone


def generate_markdown(benchmark_name: str, summary: dict, details: list[dict]) -> str:
    """Generate a publishable markdown report."""
    lines = [
        f"# Sinain Knowledge Graph — {benchmark_name} Results",
        f"\nGenerated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
        "",
    ]

    # Headline IPR
    ipr = summary.get("ipr")
    if ipr:
        lines.append(f"**Information Preservation Rate (IPR)**: {ipr:.1%}")
        lines.append("")

    # Condition scores table
    conditions = summary.get("conditions", {})
    if conditions:
        cond_names = sorted(conditions.keys())
        header = "| Condition | Mean Score (1-5) | Mean F1 | N |"
        sep = "|-----------|------------------|---------|---|"
        lines.extend([header, sep])
        for cond in cond_names:
            c = conditions[cond]
            lines.append(f"| {cond} | {c['mean_score']:.2f} | {c.get('mean_f1', 0):.2f} | {c['n']} |")
        lines.append("")

    # Retrieval metrics
    retrieval = summary.get("retrieval", {})
    if retrieval:
        lines.append("## Retrieval Quality")
        lines.append("| Metric | Score |")
        lines.append("|--------|-------|")
        for k, v in sorted(retrieval.items()):
            lines.append(f"| {k} | {v:.1%} |")
        lines.append("")

    # Category breakdown
    categories = summary.get("categories", {})
    if categories:
        lines.append("## By Category")
        cond_names = sorted(set(c for cat in categories.values() for c in cat))
        header = "| Category | " + " | ".join(cond_names) + " |"
        sep = "|----------|" + "|".join(["------"] * len(cond_names)) + "|"
        lines.extend([header, sep])
        for cat in sorted(categories):
            cells = []
            for cond in cond_names:
                if cond in categories[cat]:
                    cells.append(f"{categories[cat][cond]['mean_score']:.2f} (n={categories[cat][cond]['n']})")
                else:
                    cells.append("-")
            lines.append(f"| {cat} | " + " | ".join(cells) + " |")
        lines.append("")

    # Failures (worst questions)
    if details:
        sm_details = [d for d in details if d.get("answers", {}).get("sinain-memory", {}).get("score") is not None]
        sm_details.sort(key=lambda d: d["answers"]["sinain-memory"]["score"])
        if sm_details:
            lines.append("## Hardest Questions for sinain-memory (bottom 5)")
            for d in sm_details[:5]:
                sm = d["answers"]["sinain-memory"]
                fc = d["answers"].get("full-context", {})
                lines.append(f"- **{d['id']}** [{d['category']}]: score={sm['score']}/5 "
                             f"(full-context: {fc.get('score', '?')}/5)")
                lines.append(f"  Q: {d['question'][:100]}...")
            lines.append("")

    return "\n".join(lines)


def generate_json(benchmark_name: str, summary: dict, details: list[dict]) -> str:
    """Generate JSON report."""
    return json.dumps({
        "benchmark": benchmark_name,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "summary": summary,
        "details": details,
    }, indent=2, ensure_ascii=False)
