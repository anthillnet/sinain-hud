#!/usr/bin/env python3
"""Phase 3 Step 2/2b: Feedback Analyzer — score feedback + compute effectiveness.

Fully mechanical: effectiveness, feedback scores, directive, and interpretation
are all computed from log data without an LLM call.  The previous gpt-5-nano
integration was removed after 60+ ticks of identical static output (avg 0.4,
directive 'stability') regardless of context.

Usage:
    python3 feedback_analyzer.py --memory-dir memory/ --session-summary "..."
"""

import argparse
import json
import sys

from common import (
    output_json,
    read_recent_logs,
)


def compute_effectiveness(logs: list[dict]) -> dict:
    """Mechanically compute effectiveness from playbook-log entries.

    - outputs: ticks where Step 5 produced output (not skipped)
    - positive: ticks where output was followed by avg compositeScore > 0.2
    - negative: ticks where output was followed by avg compositeScore < -0.1
    - neutral: remainder
    - rate: positive / outputs
    """
    output_ticks = [e for e in logs if not e.get("skipped", True)]
    outputs = len(output_ticks)

    if outputs == 0:
        return {"outputs": 0, "positive": 0, "negative": 0, "neutral": 0, "rate": 0.0}

    positive = 0
    negative = 0
    neutral = 0

    # Sort by timestamp for sequential analysis
    sorted_logs = sorted(logs, key=lambda e: e.get("ts", ""))

    for i, entry in enumerate(sorted_logs):
        if entry.get("skipped", True):
            continue
        # Look at next tick's feedback
        if i + 1 < len(sorted_logs):
            next_entry = sorted_logs[i + 1]
            feedback = next_entry.get("feedbackScores", {})
            avg = feedback.get("avg", 0)
            if avg > 0.2:
                positive += 1
            elif avg < -0.1:
                negative += 1
            else:
                neutral += 1
        else:
            neutral += 1  # No next tick yet

    rate = positive / outputs if outputs > 0 else 0.0
    return {
        "outputs": outputs,
        "positive": positive,
        "negative": negative,
        "neutral": neutral,
        "rate": round(rate, 2),
    }


def extract_feedback_scores(logs: list[dict]) -> dict:
    """Extract composite scores and correlate with patterns."""
    all_scores = []
    high_patterns = []
    low_patterns = []

    for entry in logs:
        feedback = entry.get("feedbackScores", {})
        avg = feedback.get("avg")
        if avg is not None:
            all_scores.append(avg)

        # Correlate with output
        output = entry.get("output", {})
        suggestion = output.get("suggestion", "") if output else ""

        for h in feedback.get("high", []):
            high_patterns.append(h)
        for lo in feedback.get("low", []):
            low_patterns.append(lo)

    avg_score = round(sum(all_scores) / len(all_scores), 2) if all_scores else 0
    return {
        "avg": avg_score,
        "high": high_patterns[:5],  # Top 5
        "low": low_patterns[:5],
    }


def determine_directive(effectiveness: dict) -> str:
    """Determine curate directive from effectiveness metrics."""
    if effectiveness["outputs"] < 5:
        return "insufficient_data"
    rate = effectiveness["rate"]
    if rate < 0.4:
        return "aggressive_prune"
    elif rate > 0.7:
        return "stability"
    return "normal"


def compute_score_trend(logs: list[dict]) -> str:
    """Detect score trend from recent logs: rising, falling, or flat."""
    scores = []
    for entry in sorted(logs, key=lambda e: e.get("ts", "")):
        fb = entry.get("feedbackScores", {})
        avg = fb.get("avg")
        if avg is not None:
            scores.append(avg)
    if len(scores) < 3:
        return "insufficient"
    # Compare first third vs last third
    third = max(1, len(scores) // 3)
    early_avg = sum(scores[:third]) / third
    late_avg = sum(scores[-third:]) / third
    delta = late_avg - early_avg
    if delta > 0.1:
        return "rising"
    elif delta < -0.1:
        return "falling"
    return "flat"


def generate_interpretation(
    feedback_scores: dict, effectiveness: dict, directive: str, logs: list[dict]
) -> str:
    """Heuristic interpretation from mechanical metrics — no LLM needed.

    Replaces the gpt-5-nano call that was returning static output (avg 0.4,
    directive 'stability') regardless of context across 60+ ticks.
    """
    parts = []

    trend = compute_score_trend(logs)
    avg = feedback_scores.get("avg", 0)
    rate = effectiveness.get("rate", 0)
    outputs = effectiveness.get("outputs", 0)

    # Score summary
    if trend == "rising":
        parts.append(f"Scores trending up (avg {avg})")
    elif trend == "falling":
        parts.append(f"Scores trending down (avg {avg}) — review recent patterns")
    elif trend == "flat":
        parts.append(f"Scores flat at avg {avg}")
    else:
        parts.append(f"Too few data points for trend (avg {avg})")

    # Effectiveness summary
    pos = effectiveness.get("positive", 0)
    neg = effectiveness.get("negative", 0)
    if outputs > 0:
        parts.append(f"Effectiveness {rate:.0%} ({pos} positive, {neg} negative of {outputs} outputs)")

    # Pattern highlights
    high = feedback_scores.get("high", [])
    low = feedback_scores.get("low", [])
    if high:
        parts.append(f"Working well: {', '.join(high[:3])}")
    if low:
        parts.append(f"Underperforming: {', '.join(low[:3])}")

    # Directive rationale
    rationale = {
        "aggressive_prune": "Low effectiveness — pruning weak patterns",
        "normal": "Balanced cycle — standard add/prune",
        "stability": "High effectiveness — preserving current patterns",
        "insufficient_data": "Not enough data for effectiveness tuning",
    }
    parts.append(rationale.get(directive, f"Directive: {directive}"))

    return ". ".join(parts)


def main():
    parser = argparse.ArgumentParser(description="Phase 3: Feedback analysis")
    parser.add_argument("--memory-dir", required=True, help="Path to memory/ directory")
    parser.add_argument("--session-summary", required=True, help="Brief session summary")
    args = parser.parse_args()

    logs = read_recent_logs(args.memory_dir, days=7)

    # Fully mechanical computation — no LLM call
    effectiveness = compute_effectiveness(logs)
    feedback_scores = extract_feedback_scores(logs)
    directive = determine_directive(effectiveness)
    interpretation = generate_interpretation(feedback_scores, effectiveness, directive, logs)

    output_json({
        "feedbackScores": feedback_scores,
        "effectiveness": effectiveness,
        "curateDirective": directive,
        "interpretation": interpretation,
    })


if __name__ == "__main__":
    main()
