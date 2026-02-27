#!/usr/bin/env python3
"""Phase 3 Step 2/2b: Feedback Analyzer — score feedback + compute effectiveness.

Effectiveness is computed mechanically (Python math). LLM interprets patterns
in feedback scores to produce a curate directive for the playbook curator.

Usage:
    python3 feedback_analyzer.py --memory-dir memory/ --session-summary "..."
"""

import argparse
import json
import sys

from common import (
    call_llm,
    extract_json,
    output_json,
    parse_effectiveness,
    read_playbook,
    read_recent_logs,
)

SYSTEM_PROMPT = """\
You are a feedback analysis agent for a personal AI assistant (sinain).
Your job: interpret feedback patterns from heartbeat logs to guide playbook curation.

You receive:
1. Feedback scores from recent heartbeat ticks (compositeScore values)
2. Mechanically computed effectiveness metrics
3. A session summary for current context

Analyze which patterns correlate with high vs low scores. Determine a curate directive:
- "aggressive_prune": effectiveness rate < 0.4 — prune weak patterns, many outputs were unhelpful
- "normal": 0.4 <= rate <= 0.7 — balanced add/prune cycle
- "stability": rate > 0.7 — mostly working well, only add strong evidence (score > 0.5)
- "insufficient_data": fewer than 5 outputs in 7 days — skip effectiveness adjustments

Respond with ONLY a JSON object:
{
  "feedbackScores": {"avg": 0.45, "high": ["pattern that scored well", ...], "low": ["pattern that scored poorly", ...]},
  "interpretation": "brief analysis of what's working vs not",
  "curateDirective": "normal"
}"""


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


def main():
    parser = argparse.ArgumentParser(description="Phase 3: Feedback analysis")
    parser.add_argument("--memory-dir", required=True, help="Path to memory/ directory")
    parser.add_argument("--session-summary", required=True, help="Brief session summary")
    args = parser.parse_args()

    logs = read_recent_logs(args.memory_dir, days=7)
    playbook = read_playbook(args.memory_dir)

    # Mechanical computation
    effectiveness = compute_effectiveness(logs)
    feedback_scores = extract_feedback_scores(logs)
    directive = determine_directive(effectiveness)

    # LLM interprets patterns (only if we have enough data)
    interpretation = ""
    if logs:
        user_prompt = (
            f"## Session Summary\n{args.session_summary}\n\n"
            f"## Feedback Scores\n{json.dumps(feedback_scores, indent=2)}\n\n"
            f"## Effectiveness Metrics\n{json.dumps(effectiveness, indent=2)}\n\n"
            f"## Current Directive (mechanical): {directive}\n\n"
            f"Analyze which patterns are working and which aren't. Confirm or adjust the directive."
        )

        try:
            raw = call_llm(SYSTEM_PROMPT, user_prompt, script="feedback_analyzer", json_mode=True)
            llm_result = extract_json(raw)
            interpretation = llm_result.get("interpretation", "")
            # LLM can override directive if it has reasoning
            llm_directive = llm_result.get("curateDirective")
            if llm_directive in ("aggressive_prune", "normal", "stability", "insufficient_data"):
                directive = llm_directive
        except (ValueError, Exception) as e:
            print(f"[warn] LLM feedback interpretation failed: {e}", file=sys.stderr)
            interpretation = "LLM analysis unavailable"

    output_json({
        "feedbackScores": feedback_scores,
        "effectiveness": effectiveness,
        "curateDirective": directive,
        "interpretation": interpretation,
    })


if __name__ == "__main__":
    main()
