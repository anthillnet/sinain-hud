"""Variance attribution orchestrator + report writer + baseline writer.

EVAL-02: produces single-ablation marginal-effect breakdown of LongMemEval-S
error budget by subsystem (3 subsystems x 2 modes = 6 ablation runs + 1
baseline = 7 total).

EVAL-04: baseline document writer for the milestone reference number.

Locked decisions encoded:
    D-02: Output dir = .planning/eval-internal/ (private, gitignored).
    D-03: Schema EXCLUDED from variance attribution (Phase 5 if needed).
    D-04: Single-ablation marginal effects only (not Shapley 2^N).
    D-07: Baseline doc footer documents DeepSeek-V4-Flash vs GPT-4o
          comparability tradeoff.
"""
from __future__ import annotations
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

_koog_dir = str(Path(__file__).resolve().parent.parent.parent.parent)
if _koog_dir not in sys.path:
    sys.path.insert(0, _koog_dir)


SUBSYSTEMS = ("distiller", "integrator", "retrieval")
MODES = ("passthrough", "oracle")

# D-07 comparability footer — emitted per-baseline based on actual judge model.
# Paper + Hindsight reference: openai/gpt-4o-2024-08-06. When the judge matches,
# comparison IS valid; when it diverges, the caveat applies.
PAPER_REFERENCE_JUDGE = "openai/gpt-4o-2024-08-06"


def _comparability_footer(judge_model: str) -> str:
    if judge_model == PAPER_REFERENCE_JUDGE:
        return (
            "Judge: gpt-4o-2024-08-06 — matches the LongMemEval paper and "
            "Hindsight reference judge. Cross-stack comparison IS valid."
        )
    return (
        f"Judge: {judge_model}. Hindsight + LongMemEval paper used "
        "openai/gpt-4o-2024-08-06. Direct numerical comparison NOT valid; "
        "trend-internal-consistency only."
    )


def _project_root() -> Path:
    return Path(__file__).resolve().parent.parent.parent.parent.parent


def _default_output_dir() -> Path:
    out = _project_root() / ".planning" / "eval-internal"
    out.mkdir(parents=True, exist_ok=True)
    return out


def _git_sha() -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=5,
            cwd=str(_project_root()),
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return "unknown"


def _git_branch() -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=5,
            cwd=str(_project_root()),
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return "unknown"


def _atomic_write(path: Path, content: str) -> None:
    # Pattern S4: tmp + rename atomic write.
    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def run_variance_attribution(
    *,
    subset: int | None = None,
    stratified: bool = True,
    output_dir: Path | None = None,
) -> dict:
    """Run baseline + 3 subsystems x 2 modes = 7 runs and produce a
    variance-attribution summary."""
    from eval.benchmarks.runner import run_benchmark
    from eval.benchmarks.evaluate import paired_bootstrap_delta_ci

    def _run(ablate: str, ablate_mode: str):
        prior_a = os.environ.get("SINAIN_ABLATE")
        prior_m = os.environ.get("SINAIN_ABLATE_MODE")
        os.environ["SINAIN_ABLATE"] = ablate
        os.environ["SINAIN_ABLATE_MODE"] = ablate_mode
        try:
            return run_benchmark(
                "longmemeval",
                conditions=["sinain-memory"],
                subset=subset,
                stratified=stratified,
                judge_mode="paper",
                ablate=ablate,
                ablate_mode=ablate_mode,
            )
        finally:
            if prior_a is None:
                os.environ.pop("SINAIN_ABLATE", None)
            else:
                os.environ["SINAIN_ABLATE"] = prior_a
            if prior_m is None:
                os.environ.pop("SINAIN_ABLATE_MODE", None)
            else:
                os.environ["SINAIN_ABLATE_MODE"] = prior_m

    baseline_summary, baseline_details = _run("none", "passthrough")
    baseline_overall = baseline_summary.get("overall", {})
    baseline_labels = [
        q.get("answers", {}).get("sinain-memory", {}).get("paper_label", 0)
        for q in baseline_details
    ]

    subsystem_results: dict[str, dict] = {}
    for subsystem in SUBSYSTEMS:
        subsystem_results[subsystem] = {}
        for mode in MODES:
            ab_summary, ab_details = _run(subsystem, mode)
            ab_overall = ab_summary.get("overall", {})
            ab_labels = [
                q.get("answers", {}).get("sinain-memory", {}).get("paper_label", 0)
                for q in ab_details
            ]
            if len(ab_labels) == len(baseline_labels) and baseline_labels:
                d_lo, d_hi = paired_bootstrap_delta_ci(baseline_labels, ab_labels)
            else:
                d_lo, d_hi = (0.0, 0.0)
            delta_pp = (ab_overall.get("accuracy", 0.0) - baseline_overall.get("accuracy", 0.0)) * 100.0
            subsystem_results[subsystem][mode] = {
                "accuracy": ab_overall.get("accuracy", 0.0),
                "ci_low": ab_overall.get("ci_low", 0.0),
                "ci_high": ab_overall.get("ci_high", 0.0),
                "n": ab_overall.get("n", 0),
                "delta_pp": round(delta_pp, 2),
                "delta_ci_low": round(d_lo * 100.0, 2),
                "delta_ci_high": round(d_hi * 100.0, 2),
            }

    summary = {
        "baseline": {
            "accuracy": baseline_overall.get("accuracy", 0.0),
            "ci_low": baseline_overall.get("ci_low", 0.0),
            "ci_high": baseline_overall.get("ci_high", 0.0),
            "n": baseline_overall.get("n", 0),
        },
        "subsystems": subsystem_results,
        "methodology": baseline_summary.get("methodology", {}),
        "commit": _git_sha(),
        "branch": _git_branch(),
        "date": datetime.utcnow().strftime("%Y-%m-%d"),
        "deferred": ["schema"],  # D-03
    }

    out_dir = output_dir or _default_output_dir()
    date_str = summary["date"]
    md_path = out_dir / f"variance-attribution-{date_str}.md"
    json_path = out_dir / f"variance-attribution-{date_str}.json"
    write_variance_report(summary, md_path, json_path)
    return summary


def write_variance_report(summary: dict, md_path: Path, json_path: Path) -> None:
    """Render markdown table + JSON sidecar (atomic writes)."""
    md = _render_variance_markdown(summary)
    _atomic_write(Path(md_path), md)
    _atomic_write(Path(json_path), json.dumps(summary, indent=2, ensure_ascii=False))


def _render_variance_markdown(summary: dict) -> str:
    lines: list[str] = []
    date = summary.get("date", "unknown")
    commit = summary.get("commit", "unknown")
    lines.append(f"# Variance Attribution — LongMemEval-S — {date}")
    lines.append("")
    lines.append(f"**Commit:** {commit}")
    lines.append(f"**Branch:** {summary.get('branch', 'unknown')}")
    lines.append("")
    lines.append("| Subsystem | Mode | Accuracy | 95% CI | Δ vs baseline (pp) | Δ 95% CI (pp) |")
    lines.append("|-----------|------|----------|--------|---------------------|---------------|")

    baseline = summary.get("baseline", {})
    bl_acc = baseline.get("accuracy", 0.0) * 100.0
    bl_lo = baseline.get("ci_low", 0.0) * 100.0
    bl_hi = baseline.get("ci_high", 0.0) * 100.0
    lines.append(f"| (baseline) | — | {bl_acc:.1f}% | [{bl_lo:.1f}%, {bl_hi:.1f}%] | — | — |")

    for subsystem in SUBSYSTEMS:
        rows = summary.get("subsystems", {}).get(subsystem, {})
        for mode in MODES:
            r = rows.get(mode)
            if not r:
                continue
            acc = r.get("accuracy", 0.0) * 100.0
            lo = r.get("ci_low", 0.0) * 100.0
            hi = r.get("ci_high", 0.0) * 100.0
            delta = r.get("delta_pp", 0.0)
            dlo = r.get("delta_ci_low", 0.0)
            dhi = r.get("delta_ci_high", 0.0)
            lines.append(
                f"| {subsystem} | {mode} | {acc:.1f}% | [{lo:.1f}%, {hi:.1f}%] | "
                f"{delta:+.1f} | [{dlo:+.1f}, {dhi:+.1f}] |"
            )

    lines.append("")
    lines.append("**Caveat (D-04):** Single-ablation marginal effects — subsystem contributions interact and do NOT sum to 100%. For order-independent Shapley-style decomposition, deferred to Phase 5.")
    lines.append("")
    lines.append("**Deferred:** schema ablation (D-03 — Phase 5 if bench identifies schema as dominant variance source).")
    lines.append("")
    methodology = summary.get("methodology", {})
    if methodology:
        lines.append("**Methodology:**")
        for k in sorted(methodology.keys()):
            lines.append(f"- {k}: {methodology[k]}")
        lines.append("")
    return "\n".join(lines)


def write_baseline(result: dict, md_path: Path, json_path: Path) -> None:
    """Write the milestone-reference baseline document (EVAL-04). Atomic write."""
    md = _render_baseline_markdown(result)
    _atomic_write(Path(md_path), md)
    _atomic_write(Path(json_path), json.dumps(result, indent=2, ensure_ascii=False))


def _render_baseline_markdown(result: dict) -> str:
    methodology = result.get("methodology", {}) or {}
    judge_model = result.get("judge_model") or methodology.get("judge_model", PAPER_REFERENCE_JUDGE)
    qa_model = result.get("qa_model") or methodology.get("qa_model", "google/gemini-2.5-flash")
    judge_temp = result.get("judge_temperature", 0.0)
    qa_temp = result.get("qa_temperature", 0.0)
    judge_max_tokens = result.get("judge_max_tokens", 10)
    n_questions = result.get("n_questions") or result.get("overall", {}).get("n", "?")
    dataset_version = result.get(
        "dataset_version",
        "longmemeval_s_cleaned.json (xiaowu0162/longmemeval-cleaned)",
    )
    sinain_commit = result.get("sinain_commit") or _git_sha()
    sinain_branch = result.get("sinain_branch") or _git_branch()
    date_run = result.get("date_run") or datetime.utcnow().strftime("%Y-%m-%d")
    ablation = result.get("ablation") or methodology.get("ablate", "none")
    profile = result.get("profile") or methodology.get("profile") or "eval"

    front_matter = [
        "---",
        "benchmark: LongMemEval-S",
        f"dataset_version: {dataset_version}",
        f"sinain_commit: {sinain_commit}",
        f"sinain_branch: {sinain_branch}",
        f"date_run: {date_run}",
        "scoring_protocol: paper-standard (binary, per-question-type, evaluate_qa.py port)",
        f"judge_model: {judge_model}",
        f"judge_temperature: {judge_temp}",
        f"judge_max_tokens: {judge_max_tokens}",
        f"qa_model: {qa_model}",
        f"qa_temperature: {qa_temp}",
        f"n_questions: {n_questions}",
        f"ablation: {ablation}",
        f"profile: {profile}",
        "---",
        "",
    ]

    body: list[str] = []
    body.append("# LongMemEval-S Baseline — sinain memory v2.0 starting state")
    body.append("")
    body.append("## Headline")
    body.append("")
    ta = result.get("task_averaged", {})
    ov = result.get("overall", {})
    ab = result.get("abstention", {})
    if ta:
        body.append(
            f"- **Task-averaged accuracy:** {ta.get('accuracy', 0)*100:.1f}% "
            f"[95% CI: {ta.get('ci_low', 0)*100:.1f}%, {ta.get('ci_high', 0)*100:.1f}%]"
        )
    if ov:
        body.append(
            f"- **Overall accuracy:** {ov.get('accuracy', 0)*100:.1f}% "
            f"[95% CI: {ov.get('ci_low', 0)*100:.1f}%, {ov.get('ci_high', 0)*100:.1f}%] "
            f"(n={ov.get('n', '?')})"
        )
    if ab and ab.get("n", 0) > 0:
        body.append(
            f"- **Abstention accuracy:** {ab.get('accuracy', 0)*100:.1f}% "
            f"[95% CI: {ab.get('ci_low', 0)*100:.1f}%, {ab.get('ci_high', 0)*100:.1f}%] "
            f"(n={ab.get('n', '?')})"
        )
    body.append("")
    body.append("## Per-category breakdown")
    body.append("")
    body.append("| Category | N | Accuracy | 95% CI |")
    body.append("|----------|---|----------|--------|")
    per_task = result.get("per_task", {}) or {}
    for cat in sorted(per_task):
        row = per_task[cat]
        body.append(
            f"| {cat} | {row.get('n', '?')} | "
            f"{row.get('accuracy', 0)*100:.1f}% | "
            f"[{row.get('ci_low', 0)*100:.1f}%, {row.get('ci_high', 0)*100:.1f}%] |"
        )
    body.append("")
    body.append("## Methodology provenance")
    body.append("")
    body.append("- Paper: Wu et al., \"LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory\", ICLR 2025, arxiv 2410.10813")
    body.append("- Judge prompt: ported verbatim from `xiaowu0162/LongMemEval/src/evaluation/evaluate_qa.py`")
    body.append("- Sinain port: `sinain-hud-plugin/sinain-memory/eval/benchmarks/judges/longmemeval_judge.py`")
    body.append("- IPR (\"82.8%\") from prior STATE.md is NOT comparable to this number — different metric.")
    body.append("")
    body.append("## Replication")
    body.append("")
    body.append("```bash")
    body.append("cd sinain-hud-plugin/sinain-memory")
    body.append("python3 -m eval.benchmarks.runner --benchmarks longmemeval \\")
    body.append("    --conditions sinain-memory --judge-mode paper --stratified --write-baseline")
    body.append("```")
    body.append("")
    body.append("## Comparability (D-07)")
    body.append("")
    body.append(f"> {_comparability_footer(judge_model)}")
    body.append("")
    if judge_model == PAPER_REFERENCE_JUDGE:
        body.append("D-01 superseded 2026-05-27: paper-mode pins judge to gpt-4o-2024-08-06 (the LongMemEval paper's exact judge). Prior decision to use DeepSeek-V4-Flash for cost was rolled back after subset n=20 returned 0.0% due to reasoning-token max_tokens accounting on the verbatim paper port.")
    else:
        body.append("Rationale: judge diverges from the paper reference. The headline number does NOT support cross-stack comparison against Hindsight or other paper-row entries; use trend-internal-consistency only.")
    body.append("")

    return "\n".join(front_matter + body)
