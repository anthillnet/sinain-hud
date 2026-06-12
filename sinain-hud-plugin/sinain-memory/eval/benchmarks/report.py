"""Report generation — markdown, JSON, and LaTeX output."""

from __future__ import annotations

import json
from datetime import datetime, timezone


def _fmt_pct_ci(acc: float, lo: float, hi: float) -> str:
    """Format an accuracy + CI as 'XX.X% [YY.Y%, ZZ.Z%]'."""
    return f"{acc * 100:.1f}% [{lo * 100:.1f}%, {hi * 100:.1f}%]"


def generate_markdown(
    benchmark_name_or_summary,
    summary: dict | None = None,
    details: list[dict] | None = None,
) -> str:
    """Generate a publishable markdown report.

    Can be called in two ways:

    1. Legacy 3-argument form (backward compat):
       generate_markdown(benchmark_name: str, summary: dict, details: list[dict])

    2. Paper-mode 1-argument form (EVAL-03):
       generate_markdown(summary: dict)

    Detection: if the first argument is a dict, treat it as the summary (paper-mode call).
    Legacy callers pass benchmark_name as a str.
    """
    # ---- Signature normalization -----------------------------------------
    if isinstance(benchmark_name_or_summary, dict):
        # New single-arg form: generate_markdown(summary)
        _summary = benchmark_name_or_summary
        _benchmark_name = _summary.get("benchmark", "")
        _details: list[dict] = details or []
    else:
        # Legacy 3-arg form: generate_markdown(name, summary, details)
        _benchmark_name = benchmark_name_or_summary
        _summary = summary or {}
        _details = details or []

    lines = [
        f"# Sinain Knowledge Graph — {_benchmark_name} Results" if _benchmark_name
        else "# Sinain Knowledge Graph — Evaluation Results",
        f"\nGenerated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
        "",
    ]

    # Headline IPR (legacy path)
    ipr = _summary.get("ipr")
    if ipr:
        lines.append(f"**Information Preservation Rate (IPR)**: {ipr:.1%}")
        lines.append("")

    # ---- Paper-mode aggregation (EVAL-03/04) -----------------------------
    # Paper-mode summaries have either judge_mode="paper" or per_task populated.
    # Legacy summaries (acme IPR tracking) lack both — the existing
    # conditions/Mean Score table below remains the canonical render for them.
    is_paper = (
        _summary.get("judge_mode") == "paper"
        or "per_task" in _summary
        or "task_averaged" in _summary
    )
    if is_paper:
        ta = _summary.get("task_averaged")
        ov = _summary.get("overall")
        ab = _summary.get("abstention")
        lines.append("## Paper-Standard Scoring")
        lines.append("")
        if ta is not None:
            lines.append(
                f"- **Task-averaged accuracy:** {_fmt_pct_ci(ta['accuracy'], ta['ci_low'], ta['ci_high'])}"
            )
        if ov is not None:
            lines.append(
                f"- **Overall accuracy:** {_fmt_pct_ci(ov['accuracy'], ov['ci_low'], ov['ci_high'])}  (n={ov.get('n', '?')})"
            )
        if ab is not None and ab.get("n", 0) > 0:
            lines.append(
                f"- **Abstention accuracy:** {_fmt_pct_ci(ab['accuracy'], ab['ci_low'], ab['ci_high'])}  (n={ab['n']})"
            )
        lines.append("")
        per_task = _summary.get("per_task") or {}
        if per_task:
            lines.append("| Category | N | Accuracy | 95% CI |")
            lines.append("|----------|---|----------|--------|")
            for cat in sorted(per_task):
                row = per_task[cat]
                lines.append(
                    f"| {cat} | {row.get('n', '?')} | "
                    f"{row['accuracy'] * 100:.1f}% | "
                    f"[{row['ci_low'] * 100:.1f}%, {row['ci_high'] * 100:.1f}%] |"
                )
            lines.append("")

    # ---- Legacy: Condition scores table (1-5 Mean Score, acme IPR) ---
    # Preserved unchanged — acme IPR/GATE-02 regression tracking depends
    # on this exact "Mean Score (1-5)" header.
    conditions = _summary.get("conditions", {})
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
    retrieval = _summary.get("retrieval", {})
    if retrieval:
        lines.append("## Retrieval Quality")
        lines.append("| Metric | Score |")
        lines.append("|--------|-------|")
        for k, v in sorted(retrieval.items()):
            lines.append(f"| {k} | {v:.1%} |")
        lines.append("")

    # Category breakdown
    categories = _summary.get("categories", {})
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
    if _details:
        sm_details = [d for d in _details if d.get("answers", {}).get("sinain-memory", {}).get("score") is not None]
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
