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

    # Judge score distribution
    judge_scores: dict[str, list[int]] = {}
    for e in eval_entries:
        judges = e.get("judges")
        if not judges:
            continue
        for judge_name, result in judges.items():
            if isinstance(result, dict) and "score" in result:
                judge_scores.setdefault(judge_name, []).append(result["score"])

    judge_avg = None
    if judge_scores:
        all_scores = [s for scores in judge_scores.values() for s in scores]
        judge_avg = round(sum(all_scores) / len(all_scores), 2) if all_scores else None

    # Pass rate trend
    pass_rates = [e.get("passRate", 1.0) for e in eval_entries]
    avg_pass_rate = round(sum(pass_rates) / len(pass_rates), 3)

    return {
        "tickCount": len(eval_entries),
        "schemaValidity": {"total": schema_total, "valid": schema_valid, "rate": schema_rate},
        "assertionPassRate": {"total": assert_total, "passed": assert_passed, "rate": assert_rate},
        "failureHistogram": dict(failure_counter.most_common(10)),
        "judgeScores": {k: {"count": len(v), "avg": round(sum(v) / len(v), 2), "dist": dict(Counter(v))}
                        for k, v in judge_scores.items()},
        "judgeAvg": judge_avg,
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

    # Playbook Health
    lines.append("## Playbook Health")
    lines.append(f"- Line count trend: {playbook_health.get('lineCountTrend', [])}")
    lines.append(f"- Avg churn/tick: {playbook_health.get('avgChurnPerTick', 0)} changes")
    lines.append(f"- Total added: {playbook_health.get('totalAdded', 0)}, pruned: {playbook_health.get('totalPruned', 0)}")
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


def get_llm_interpretation(aggregates: dict, regressions: list[str], playbook_health: dict) -> str:
    """Use LLM to interpret trends and write recommendations."""
    system_prompt = (
        "You are an evaluation analyst for a personal AI assistant pipeline. "
        "Given daily evaluation metrics, write 3-5 bullet points of actionable recommendations. "
        "Be specific — reference assertion names, score values, and trends. "
        "Respond with ONLY a JSON object: {\"recommendations\": [\"bullet 1\", ...]}"
    )

    user_prompt = (
        f"## Aggregates\n{json.dumps(aggregates, indent=2)}\n\n"
        f"## Regressions\n{regressions}\n\n"
        f"## Playbook Health\n{json.dumps(playbook_health, indent=2)}"
    )

    try:
        raw = call_llm(system_prompt, user_prompt, script="eval_reporter", json_mode=True)
        result = extract_json(raw)
        recs = result.get("recommendations", [])
        if recs:
            return "\n".join(f"- {r}" for r in recs)
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
    eval_entries = load_eval_logs(memory_dir, days=args.days)
    if not eval_entries:
        print("[eval-reporter] no eval-log entries found", file=sys.stderr)
        return

    # Load playbook logs for health metrics
    playbook_logs = read_recent_logs(memory_dir, days=args.days)

    # Compute metrics
    aggregates = compute_aggregates(eval_entries)
    playbook_health = compute_playbook_health(playbook_logs)
    skip_rate = compute_skip_rate(playbook_logs)
    regressions = detect_regressions(aggregates, thresholds, skip_rate)

    print(f"[eval-reporter] {aggregates['tickCount']} ticks, "
          f"schema={aggregates.get('schemaValidity', {}).get('rate', '?')}, "
          f"assertions={aggregates.get('assertionPassRate', {}).get('rate', '?')}, "
          f"regressions={len(regressions)}", file=sys.stderr)

    # LLM interpretation (if report feature is on and we have enough data)
    llm_interpretation = ""
    if eval_config.get("dailyReport", True) and aggregates["tickCount"] >= 2:
        llm_interpretation = get_llm_interpretation(aggregates, regressions, playbook_health)

    # Generate report
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    report = generate_report_markdown(
        today, aggregates, playbook_health, skip_rate, regressions, llm_interpretation,
    )

    # Write report
    report_dir = Path(memory_dir) / "eval-reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    report_file = report_dir / f"{today}.md"
    report_file.write_text(report, encoding="utf-8")

    print(f"[eval-reporter] report written to {report_file}", file=sys.stderr)


if __name__ == "__main__":
    main()
