#!/usr/bin/env python3
"""Phase 3 Step 5: Insight Synthesizer — produce suggestion + insight for Telegram.

Uses the "smart" model (configured in koog-config.json) for higher quality output.
Reads post-curation playbook + recent logs to generate one Telegram message
with a practical suggestion and a surprising insight.

Usage:
    python3 insight_synthesizer.py --memory-dir memory/ --session-summary "..." \
        [--curator-changes "TEXT"] [--idle]
"""

import argparse
import json
import sys

from common import (
    LLMError,
    call_llm,
    extract_json,
    output_json,
    read_effective_playbook,
    read_recent_logs,
)

SYSTEM_PROMPT = """\
You are the insight synthesizer for sinain, a personal AI assistant.
Your job: produce ONE high-quality Telegram message with two parts.

**Suggestion** (1-2 sentences): A practical, actionable recommendation.
- MUST reference a specific playbook pattern or concrete observation
- NOT generic advice — grounded in actual data
- Could be: workflow improvement, recurring problem to automate, successful pattern to replicate

**Insight** (1-2 sentences): A surprising, non-obvious connection from accumulated data.
- MUST connect 2+ distinct observations that aren't obviously related
- Cross-domain patterns, unexpected correlations, things the user hasn't noticed
- Cite specific observations from playbook or logs

Quality gate — you MUST skip if:
- You cannot produce BOTH a genuinely useful suggestion AND a genuinely surprising insight
- The suggestion would repeat something from recent heartbeat outputs
- The insight is obvious or doesn't connect distinct observations

Total message MUST be under 500 characters.

Respond with ONLY a JSON object. If producing output:
{
  "skip": false,
  "suggestion": "the suggestion text",
  "insight": "the insight text"
}

If skipping (be specific about WHY, citing what you read):
{
  "skip": true,
  "skipReason": "specific reason citing files/patterns examined — 'no new data' is NOT valid"
}"""


def build_user_prompt(
    playbook: str,
    recent_logs: list[dict],
    session_summary: str,
    curator_changes: str,
    idle: bool,
) -> str:
    parts = []

    parts.append(f"## Session Summary\n{session_summary}")

    if idle:
        parts.append("\n## Status: IDLE — focus on mined patterns and playbook evolution")

    if playbook:
        parts.append(f"\n## Current Playbook (post-curation)\n{playbook}")

    if curator_changes:
        parts.append(f"\n## Curator Changes This Tick\n{curator_changes}")

    # Recent outputs to avoid repetition
    if recent_logs:
        recent_outputs = []
        for entry in recent_logs[:5]:
            output = entry.get("output", {})
            if output and not entry.get("skipped", True):
                recent_outputs.append({
                    "ts": entry.get("ts", "?"),
                    "suggestion": output.get("suggestion", "")[:100],
                    "insight": output.get("insight", "")[:100],
                })
        if recent_outputs:
            parts.append(f"\n## Recent Outputs (DO NOT REPEAT)\n{json.dumps(recent_outputs, indent=2)}")

    return "\n".join(parts)


def main():
    parser = argparse.ArgumentParser(description="Phase 3: Insight synthesis")
    parser.add_argument("--memory-dir", required=True, help="Path to memory/ directory")
    parser.add_argument("--session-summary", required=True, help="Brief session summary")
    parser.add_argument("--curator-changes", default="", help="JSON string of curator changes")
    parser.add_argument("--idle", action="store_true", help="User is idle")
    args = parser.parse_args()

    playbook = read_effective_playbook(args.memory_dir)
    recent_logs = read_recent_logs(args.memory_dir, days=3)

    user_prompt = build_user_prompt(
        playbook=playbook,
        recent_logs=recent_logs,
        session_summary=args.session_summary,
        curator_changes=args.curator_changes,
        idle=args.idle,
    )

    try:
        raw = call_llm(SYSTEM_PROMPT, user_prompt, script="insight_synthesizer", json_mode=True)
        result = extract_json(raw)
    except (ValueError, LLMError) as e:
        print(f"[warn] {e}", file=sys.stderr)
        result = {
            "skip": True,
            "skipReason": "LLM response was not parseable JSON",
        }

    # Enforce character limit on non-skip output
    if not result.get("skip", False):
        suggestion = result.get("suggestion", "")
        insight = result.get("insight", "")
        total_chars = len(suggestion) + len(insight)

        if total_chars > 500:
            # Truncate insight to fit
            max_insight = 500 - len(suggestion) - 10  # buffer
            if max_insight > 50:
                insight = insight[:max_insight] + "..."
                result["insight"] = insight
                total_chars = len(suggestion) + len(insight)
            else:
                result["skip"] = True
                result["skipReason"] = f"Output exceeded 500 chars ({total_chars}) and could not be trimmed"

        result["totalChars"] = len(result.get("suggestion", "")) + len(result.get("insight", ""))

    output_json(result)


if __name__ == "__main__":
    main()
