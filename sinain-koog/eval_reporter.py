#!/usr/bin/env python3
"""Tier 2 Evaluation: Daily report generator — runs as server cron job (daily 03:00).

Aggregates 24h of eval-logs, computes quality metrics, detects regressions,
uses LLM to interpret trends and write a daily report to memory/eval-reports/.

Invocation (cron):
    uv run --with requests python3 sinain-koog/eval_reporter.py \
        --memory-dir memory/ [--days 1]
"""

import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

_koog_dir = str(Path(__file__).resolve().parent)
if _koog_dir not in sys.path:
    sys.path.insert(0, _koog_dir)

from common import LLMError, _load_config, _read_jsonl, call_llm, extract_json, read_recent_logs


# ---------------------------------------------------------------------------
# Config (duplicated from tick_evaluator to avoid circular import)
# ---------------------------------------------------------------------------

_EVAL_DEFAULTS = {
    "level": "mechanical",
    "sampleRate": 0.2,
    "judges": {"model": "smart", "maxTokens": 200, "timeout": 30},
    "dailyReport": True,
    "regressionThresholds": {
        "assertionPassRate": 0.85,
        "effectivenessRate": 0.4,
        "skipRate": 0.8,
    },
}


def load_eval_config(memory_dir: str) -> dict:
    """Load eval config with runtime overrides from memory/eval-config.json."""
    base = _load_config().get("eval", {})
    cfg = {**_EVAL_DEFAULTS, **base}

    override_path = Path(memory_dir) / "eval-config.json"
    if override_path.exists():
        try:
            override = json.loads(override_path.read_text(encoding="utf-8"))
            cfg.update(override)
        except (json.JSONDecodeError, OSError) as e:
            print(f"[warn] eval-config.json override failed: {e}", file=sys.stderr)

    return cfg


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

def load_eval_logs(memory_dir: str, days: int = 1) -> list[dict]:
    """Load eval-log entries from the last N days."""
    log_dir = Path(memory_dir) / "eval-logs"
    if not log_dir.is_dir():
        return []

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    entries: list[dict] = []

    for jsonl_file in sorted(log_dir.glob("*.jsonl"), reverse=True):
        try:
            file_date = datetime.strptime(jsonl_file.stem, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if file_date < cutoff - timedelta(days=1):
            break
        entries.extend(_read_jsonl(jsonl_file))

    return entries


def extract_run_summaries(eval_entries: list[dict]) -> tuple[list[dict], list[dict]]:
    """Separate run_summary metadata entries from tick eval results.

    Returns (tick_entries, run_summaries).
    """
    ticks = []
    summaries = []
    for e in eval_entries:
        if e.get("_type") == "run_summary":
            summaries.append(e)
        else:
            ticks.append(e)
    return ticks, summaries


def compute_aggregates(eval_entries: list[dict]) -> dict:
    """Compute daily aggregate metrics from eval-log entries."""
    if not eval_entries:
        return {"tickCount": 0}

    # Schema validity
    schema_total = sum(e.get("schema", {}).get("total", 0) for e in eval_entries)
    schema_valid = sum(e.get("schema", {}).get("valid", 0) for e in eval_entries)
    schema_rate = round(schema_valid / schema_total, 3) if schema_total > 0 else 1.0

    # Assertion pass rate
    assert_total = sum(e.get("assertions", {}).get("total", 0) for e in eval_entries)
    assert_passed = sum(e.get("assertions", {}).get("passed", 0) for e in eval_entries)
    assert_rate = round(assert_passed / assert_total, 3) if assert_total > 0 else 1.0

    # Assertion failure histogram
    failure_counter: Counter = Counter()
    for e in eval_entries:
        for f in e.get("assertions", {}).get("failures", []):
            failure_counter[f.get("name", "unknown")] += 1

    # Judge score distribution + sub-score aggregation
    judge_scores: dict[str, list[int]] = {}
    sub_scores: dict[str, dict[str, list[int]]] = {}  # {judge: {dim: [scores]}}
    for e in eval_entries:
        judges = e.get("judges")
        if not judges:
            continue
        for judge_name, result in judges.items():
            if isinstance(result, dict) and "score" in result:
                judge_scores.setdefault(judge_name, []).append(result["score"])
                # Collect multi-dimensional sub-scores if present
                scores_dict = result.get("scores")
                if isinstance(scores_dict, dict):
                    judge_subs = sub_scores.setdefault(judge_name, {})
                    for dim, val in scores_dict.items():
                        if isinstance(val, (int, float)):
                            judge_subs.setdefault(dim, []).append(int(val))

    judge_avg = None
    if judge_scores:
        all_scores = [s for scores in judge_scores.values() for s in scores]
        judge_avg = round(sum(all_scores) / len(all_scores), 2) if all_scores else None

    # Pass rate trend
    pass_rates = [e.get("passRate", 1.0) for e in eval_entries]
    avg_pass_rate = round(sum(pass_rates) / len(pass_rates), 3)

    # Build sub-score summary: {judge: {dim: {count, avg}}}
    sub_score_summary: dict[str, dict[str, dict]] = {}
    for judge_name, dims in sub_scores.items():
        sub_score_summary[judge_name] = {
            dim: {"count": len(vals), "avg": round(sum(vals) / len(vals), 2)}
            for dim, vals in dims.items()
        }

    return {
        "tickCount": len(eval_entries),
        "schemaValidity": {"total": schema_total, "valid": schema_valid, "rate": schema_rate},
        "assertionPassRate": {"total": assert_total, "passed": assert_passed, "rate": assert_rate},
        "failureHistogram": dict(failure_counter.most_common(10)),
        "judgeScores": {k: {"count": len(v), "avg": round(sum(v) / len(v), 2), "dist": dict(Counter(v))}
                        for k, v in judge_scores.items()},
        "judgeAvg": judge_avg,
        "subScores": sub_score_summary,
        "avgPassRate": avg_pass_rate,
    }


def compute_playbook_health(playbook_logs: list[dict]) -> dict:
    """Compute playbook health metrics from heartbeat logs."""
    line_counts: list[int] = []
    total_added = 0
    total_pruned = 0

    for entry in playbook_logs:
        changes = entry.get("playbookChanges", {})
        if isinstance(changes, dict):
            pl = changes.get("playbookLines")
            if isinstance(pl, int):
                line_counts.append(pl)
            added = changes.get("changes", {})
            if isinstance(added, dict):
                total_added += len(added.get("added", []))
                total_pruned += len(added.get("pruned", []))

    tick_count = len(playbook_logs) or 1
    return {
        "lineCountTrend": line_counts[-5:] if line_counts else [],
        "avgChurnPerTick": round((total_added + total_pruned) / tick_count, 1),
        "totalAdded": total_added,
        "totalPruned": total_pruned,
    }


def _percentile(sorted_vals: list[float], p: float) -> float:
    """Compute the p-th percentile (0-100) from a pre-sorted list."""
    if not sorted_vals:
        return 0.0
    k = (len(sorted_vals) - 1) * p / 100.0
    f = int(k)
    c = f + 1 if f + 1 < len(sorted_vals) else f
    return round(sorted_vals[f] + (k - f) * (sorted_vals[c] - sorted_vals[f]), 1)


def compute_latency_stats(playbook_logs: list[dict]) -> dict[str, dict]:
    """Aggregate per-script latency statistics from playbook-log entries.

    Returns {scriptName: {count, avg, p50, p95}} for each script key found
    in the latencyMs field, plus a "total" entry for totalLatencyMs.
    """
    buckets: dict[str, list[float]] = {}
    for entry in playbook_logs:
        lat = entry.get("latencyMs")
        if isinstance(lat, dict):
            for script, ms in lat.items():
                if isinstance(ms, (int, float)):
                    buckets.setdefault(script, []).append(float(ms))
        total = entry.get("totalLatencyMs")
        if isinstance(total, (int, float)):
            buckets.setdefault("total", []).append(float(total))

    stats: dict[str, dict] = {}
    for name, vals in buckets.items():
        vals.sort()
        stats[name] = {
            "count": len(vals),
            "avg": round(sum(vals) / len(vals), 1),
            "p50": _percentile(vals, 50),
            "p95": _percentile(vals, 95),
        }
    return stats


def compute_skip_rate(playbook_logs: list[dict]) -> float:
    """Compute the insight synthesizer skip rate."""
    total = 0
    skipped = 0
    for entry in playbook_logs:
        output = entry.get("output")
        if output is not None:
            total += 1
            if output.get("skip", False):
                skipped += 1
    return round(skipped / total, 2) if total > 0 else 0.0


# ---------------------------------------------------------------------------
# Regression detection
# ---------------------------------------------------------------------------

def detect_regressions(aggregates: dict, thresholds: dict, skip_rate: float) -> list[str]:
    """Detect regressions based on thresholds."""
    regressions: list[str] = []

    assert_rate = aggregates.get("assertionPassRate", {}).get("rate", 1.0)
    if assert_rate < thresholds.get("assertionPassRate", 0.85):
        regressions.append(
            f"Assertion pass rate {assert_rate:.1%} below threshold {thresholds['assertionPassRate']:.0%}"
        )

    if skip_rate > thresholds.get("skipRate", 0.8):
        regressions.append(
            f"Skip rate {skip_rate:.0%} above threshold {thresholds['skipRate']:.0%} — synthesizer rarely producing output"
        )

    # Repeated failures
    histogram = aggregates.get("failureHistogram", {})
    for name, count in histogram.items():
        if count >= 3:
            regressions.append(f"Assertion '{name}' failed {count} times (systemic issue)")

    return regressions


# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------

def generate_report_markdown(
    date_str: str,
    aggregates: dict,
    playbook_health: dict,
    skip_rate: float,
    regressions: list[str],
    llm_interpretation: str = "",
    run_summaries: list[dict] | None = None,
    latency_stats: dict[str, dict] | None = None,
) -> str:
    """Generate the daily eval report as markdown."""
    lines: list[str] = []
    lines.append(f"# Eval Report — {date_str}\n")

    # Quality Gates
    lines.append("## Quality Gates")
    schema = aggregates.get("schemaValidity", {})
    s_rate = schema.get("rate", 1.0)
    s_icon = "✓" if s_rate >= 0.95 else "⚠"
    lines.append(f"- {s_icon} Schema validity: {s_rate:.0%} ({schema.get('valid', 0)}/{schema.get('total', 0)} checks)")

    a = aggregates.get("assertionPassRate", {})
    a_rate = a.get("rate", 1.0)
    a_icon = "✓" if a_rate >= 0.85 else "⚠"
    lines.append(f"- {a_icon} Assertion pass rate: {a_rate:.0%} ({a.get('passed', 0)}/{a.get('total', 0)} checks)")

    j_avg = aggregates.get("judgeAvg")
    if j_avg is not None:
        j_icon = "✓" if j_avg >= 3.0 else "⚠"
        judge_count = sum(v.get("count", 0) for v in aggregates.get("judgeScores", {}).values())
        lines.append(f"- {j_icon} Mean judge score: {j_avg}/4.0 ({judge_count} evaluations)")

    skip_icon = "✓" if skip_rate < 0.8 else "⚠"
    lines.append(f"- {skip_icon} Skip rate: {skip_rate:.0%}")
    lines.append(f"- Ticks evaluated: {aggregates.get('tickCount', 0)}")

    # Partial run warning
    if run_summaries:
        partial_runs = [s for s in run_summaries if s.get("isPartial")]
        if partial_runs:
            total_failed = sum(s.get("failed", 0) for s in partial_runs)
            total_attempted = sum(s.get("attempted", 0) for s in partial_runs)
            lines.append(f"- ⚠ PARTIAL: {total_failed}/{total_attempted} tick evaluations "
                         f"failed across {len(partial_runs)} run(s)")
    lines.append("")

    # Assertion Failures
    histogram = aggregates.get("failureHistogram", {})
    if histogram:
        lines.append("## Assertion Failures (top failures)")
        for i, (name, count) in enumerate(sorted(histogram.items(), key=lambda x: -x[1])[:5], 1):
            lines.append(f"{i}. {name} — {count} failures")
        lines.append("")

    # Judge Score Breakdown
    judge_scores = aggregates.get("judgeScores", {})
    if judge_scores:
        lines.append("## Judge Scores")
        for judge_name, info in judge_scores.items():
            dist = info.get("dist", {})
            dist_str = ", ".join(f"{k}★={v}" for k, v in sorted(dist.items()))
            lines.append(f"- {judge_name}: avg {info.get('avg', '?')}/4.0 ({dist_str})")
        lines.append("")

    # Sub-Score Breakdown (multi-dimensional rubrics)
    sub_scores = aggregates.get("subScores", {})
    if sub_scores:
        lines.append("## Sub-Scores (per dimension)")
        for judge_name, dims in sorted(sub_scores.items()):
            dim_parts = []
            for dim, info in sorted(dims.items()):
                dim_parts.append(f"{dim}={info['avg']}/4.0")
            lines.append(f"- {judge_name}: {', '.join(dim_parts)}")
        lines.append("")

    # Playbook Health
    lines.append("## Playbook Health")
    lines.append(f"- Line count trend: {playbook_health.get('lineCountTrend', [])}")
    lines.append(f"- Avg churn/tick: {playbook_health.get('avgChurnPerTick', 0)} changes")
    lines.append(f"- Total added: {playbook_health.get('totalAdded', 0)}, pruned: {playbook_health.get('totalPruned', 0)}")
    lines.append("")

    # Latency
    if latency_stats:
        lines.append("## Latency")
        for script, info in sorted(latency_stats.items()):
            lines.append(f"- {script}: avg {info['avg']}ms, p50 {info['p50']}ms, "
                         f"p95 {info['p95']}ms ({info['count']} samples)")
        lines.append("")

    # Regressions
    if regressions:
        lines.append("## ⚠ Regressions Detected")
        for r in regressions:
            lines.append(f"- {r}")
        lines.append("")

    # LLM Interpretation
    if llm_interpretation:
        lines.append("## Analysis & Recommendations")
        lines.append(llm_interpretation)
        lines.append("")

    return "\n".join(lines) + "\n"


def build_snapshot(aggregates: dict, skip_rate: float, regressions: list[str]) -> dict:
    """Build a compact snapshot of key metrics for delta comparison."""
    judge_scores = aggregates.get("judgeScores", {})
    per_judge = {name: info.get("avg") for name, info in judge_scores.items() if info.get("avg") is not None}

    # Top 3 assertion failures
    histogram = aggregates.get("failureHistogram", {})
    top_failures = [name for name, _ in sorted(histogram.items(), key=lambda x: -x[1])[:3]]

    return {
        "assertionPassRate": aggregates.get("assertionPassRate", {}).get("rate"),
        "schemaRate": aggregates.get("schemaValidity", {}).get("rate"),
        "judgeAvg": aggregates.get("judgeAvg"),
        "skipRate": skip_rate,
        "perJudgeAvg": per_judge,
        "topFailures": top_failures,
        "regressionCount": len(regressions),
        "tickCount": aggregates.get("tickCount", 0),
    }


def load_previous_snapshot(report_dir: Path, current_date: str) -> tuple[str | None, dict | None]:
    """Find the most recent snapshot before current_date.

    Returns (date_str, snapshot_dict) or (None, None).
    """
    snapshots = sorted(report_dir.glob("*.snapshot.json"), reverse=True)
    for snap_path in snapshots:
        date_str = snap_path.stem.replace(".snapshot", "")
        if date_str < current_date:
            try:
                return date_str, json.loads(snap_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
    return None, None


def compute_delta(before: dict, after: dict) -> dict[str, dict]:
    """Compute per-metric deltas between two snapshots.

    Returns {metric: {before, after, delta, status}} where status is
    IMPROVED, REGRESSED, or SAME.
    """
    # Metrics where higher is better
    higher_better = {"assertionPassRate", "schemaRate", "judgeAvg"}
    # Metrics where lower is better
    lower_better = {"skipRate", "regressionCount"}

    result: dict[str, dict] = {}
    for key in higher_better | lower_better:
        b = before.get(key)
        a = after.get(key)
        if b is None or a is None:
            continue
        delta = round(a - b, 4) if isinstance(a, float) else a - b
        if key in higher_better:
            status = "IMPROVED" if delta > 0.001 else ("REGRESSED" if delta < -0.001 else "SAME")
        else:
            status = "IMPROVED" if delta < -0.001 else ("REGRESSED" if delta > 0.001 else "SAME")
        result[key] = {"before": b, "after": a, "delta": delta, "status": status}

    # Per-judge deltas
    before_judges = before.get("perJudgeAvg", {})
    after_judges = after.get("perJudgeAvg", {})
    for judge in set(before_judges) | set(after_judges):
        b = before_judges.get(judge)
        a = after_judges.get(judge)
        if b is None or a is None:
            continue
        delta = round(a - b, 2)
        status = "IMPROVED" if delta > 0.05 else ("REGRESSED" if delta < -0.05 else "SAME")
        result[f"judge:{judge}"] = {"before": b, "after": a, "delta": delta, "status": status}

    return result


def format_delta_section(prev_date: str, delta: dict[str, dict]) -> str:
    """Format delta comparison as a markdown section."""
    lines = [f"## Delta vs Previous ({prev_date})"]
    for metric, info in sorted(delta.items()):
        marker = {"IMPROVED": "↑", "REGRESSED": "↓", "SAME": "→"}.get(info["status"], "?")
        sign = "+" if info["delta"] > 0 else ""
        lines.append(f"- {marker} {metric}: {info['before']} → {info['after']} ({sign}{info['delta']}) [{info['status']}]")
    lines.append("")
    return "\n".join(lines)


def _sample_judge_details(eval_entries: list[dict], max_entries: int = 8) -> str:
    """Extract sampled judge reasonings + assertion failures for cross-tick synthesis."""
    # Sample evenly across the day
    step = max(1, len(eval_entries) // max_entries)
    sampled = eval_entries[::step][:max_entries]

    parts: list[str] = []
    for i, entry in enumerate(sampled):
        tick_ts = entry.get("tickTs", "?")
        section = [f"### Tick {i+1} ({tick_ts})"]

        # Judge reasonings (truncated)
        judges = entry.get("judges")
        if judges:
            for judge_name, result in judges.items():
                if isinstance(result, dict) and "reasoning" in result:
                    reasoning = str(result["reasoning"])[:150]
                    score = result.get("score", "?")
                    section.append(f"  {judge_name} ({score}/4): {reasoning}")

        # Assertion failures
        failures = entry.get("assertions", {}).get("failures", [])
        if failures:
            for f in failures[:3]:
                section.append(f"  FAIL: {f.get('name', '?')} — {str(f.get('detail', ''))[:100]}")

        parts.append("\n".join(section))

    return "\n\n".join(parts)


def get_llm_interpretation(
    aggregates: dict,
    regressions: list[str],
    playbook_health: dict,
    eval_entries: list[dict] | None = None,
) -> str:
    """Use LLM to interpret trends and write recommendations.

    When eval_entries is provided, includes sampled judge reasonings for
    cross-tick pattern synthesis.
    """
    system_prompt = (
        "You are an evaluation analyst for a personal AI assistant pipeline. "
        "Analyze the metrics AND individual tick evaluations to identify cross-cutting patterns. "
        "Respond with ONLY a JSON object:\n"
        '{"patterns": ["pattern 1", ...], '
        '"bottleneck": "detection|generation|both|none", '
        '"recommendations": ["rec 1", ...]}\n\n'
        "- patterns: 2-4 recurring themes across individual ticks (reference specific judges/assertions)\n"
        "- bottleneck: whether issues stem from signal detection (input), insight generation (output), both, or none\n"
        "- recommendations: 3-5 actionable next steps"
    )

    user_prompt = (
        f"## Aggregates\n{json.dumps(aggregates, indent=2)}\n\n"
        f"## Regressions\n{regressions}\n\n"
        f"## Playbook Health\n{json.dumps(playbook_health, indent=2)}"
    )

    if eval_entries:
        details = _sample_judge_details(eval_entries)
        user_prompt += f"\n\n## Individual Tick Evaluations (sampled)\n{details}"

    try:
        raw = call_llm(system_prompt, user_prompt, script="eval_reporter", json_mode=True)
        result = extract_json(raw)

        sections: list[str] = []

        # Bottleneck
        bottleneck = result.get("bottleneck", "none")
        if bottleneck != "none":
            sections.append(f"**Bottleneck**: {bottleneck}")

        # Patterns
        patterns = result.get("patterns", [])
        if patterns:
            sections.append("**Patterns**:")
            sections.extend(f"- {p}" for p in patterns)

        # Recommendations
        recs = result.get("recommendations", [])
        if recs:
            sections.append("\n**Recommendations**:")
            sections.extend(f"- {r}" for r in recs)

        return "\n".join(sections) if sections else ""
    except (ValueError, LLMError) as e:
        print(f"[eval-reporter] LLM interpretation failed: {e}", file=sys.stderr)

    return ""


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Sinain Koog Daily Eval Reporter (Tier 2)")
    parser.add_argument("--memory-dir", required=True, help="Path to memory/ directory")
    parser.add_argument("--days", type=int, default=1, help="Number of days to aggregate (default: 1)")
    args = parser.parse_args()

    memory_dir = args.memory_dir
    eval_config = load_eval_config(memory_dir)
    thresholds = eval_config.get("regressionThresholds", _EVAL_DEFAULTS["regressionThresholds"])

    # Load eval logs
    raw_eval_entries = load_eval_logs(memory_dir, days=args.days)
    if not raw_eval_entries:
        print("[eval-reporter] no eval-log entries found", file=sys.stderr)
        return

    # Separate tick results from run summary metadata
    eval_entries, run_summaries = extract_run_summaries(raw_eval_entries)
    if not eval_entries:
        print("[eval-reporter] no tick eval entries (only run summaries)", file=sys.stderr)
        return

    # Load playbook logs for health metrics
    playbook_logs = read_recent_logs(memory_dir, days=args.days)

    # Compute metrics
    aggregates = compute_aggregates(eval_entries)
    playbook_health = compute_playbook_health(playbook_logs)
    skip_rate = compute_skip_rate(playbook_logs)
    latency_stats = compute_latency_stats(playbook_logs)
    regressions = detect_regressions(aggregates, thresholds, skip_rate)

    print(f"[eval-reporter] {aggregates['tickCount']} ticks, "
          f"schema={aggregates.get('schemaValidity', {}).get('rate', '?')}, "
          f"assertions={aggregates.get('assertionPassRate', {}).get('rate', '?')}, "
          f"regressions={len(regressions)}", file=sys.stderr)

    # LLM interpretation (if report feature is on and we have enough data)
    llm_interpretation = ""
    if eval_config.get("dailyReport", True) and aggregates["tickCount"] >= 2:
        llm_interpretation = get_llm_interpretation(
            aggregates, regressions, playbook_health, eval_entries=eval_entries,
        )

    # Generate report
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    report = generate_report_markdown(
        today, aggregates, playbook_health, skip_rate, regressions, llm_interpretation,
        run_summaries=run_summaries,
        latency_stats=latency_stats,
    )

    # Write report
    report_dir = Path(memory_dir) / "eval-reports"
    report_dir.mkdir(parents=True, exist_ok=True)

    # Write snapshot for delta comparison
    snapshot = build_snapshot(aggregates, skip_rate, regressions)
    snapshot_file = report_dir / f"{today}.snapshot.json"
    snapshot_file.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    # Compute delta vs previous snapshot and append to report
    prev_date, prev_snapshot = load_previous_snapshot(report_dir, today)
    if prev_snapshot:
        delta = compute_delta(prev_snapshot, snapshot)
        if delta:
            report += "\n" + format_delta_section(prev_date, delta) + "\n"

    report_file = report_dir / f"{today}.md"
    report_file.write_text(report, encoding="utf-8")

    print(f"[eval-reporter] report + snapshot written to {report_dir}", file=sys.stderr)


if __name__ == "__main__":
    main()
