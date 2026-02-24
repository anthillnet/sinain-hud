#!/usr/bin/env python3
"""Phase 2: Signal Analyzer — detect actionable signals from session context.

Reads playbook-logs (last 3 entries) + session summary, uses LLM to identify
signals and recommend actions (spawn subagent, send tip, or skip).

Usage:
    python3 signal_analyzer.py --memory-dir memory/ --session-summary "..." [--idle]
"""

import argparse
import json
import sys

from common import (
    call_llm,
    output_json,
    read_playbook,
    read_recent_logs,
)

SYSTEM_PROMPT = """\
You are a signal detection agent for a personal AI assistant system (sinain).
Your job: scan the user's recent session activity and detect actionable signals.

Signal types and recommended actions:
| Signal | Action |
|--------|--------|
| Error or issue repeated in context | sessions_spawn: "Find root cause for: [error]" |
| New tech/topic being explored | sessions_spawn: "Research [topic]: key findings, best practices, pitfalls" |
| Clear next action to suggest | telegram_tip: concise suggestion |
| User stuck (same search/error loop) | sessions_spawn: "Debug [issue]: investigate and propose fix" |
| No meaningful signal | skip |

Rules:
- Max 1 recommended action per analysis
- NEVER repeat an action that appears in recent log entries
- Prefer depth (spawn research) over breadth (generic tips)
- If idle (>30 min no activity), set idle=true and skip Phase 2 action
- Confidence: 0.0-1.0 (only recommend actions with confidence > 0.5)

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "signals": ["signal1 description", ...],
  "recommendedAction": {"action": "sessions_spawn|telegram_tip|skip", "task": "description if not skip", "confidence": 0.7} or null,
  "idle": false
}"""


def build_user_prompt(
    session_summary: str,
    recent_logs: list[dict],
    playbook: str,
    idle: bool,
) -> str:
    parts = []

    parts.append(f"## Session Summary\n{session_summary}")

    if idle:
        parts.append("\n## Status: IDLE (>30 min no activity)\nSkip Phase 2 action. Only report if any background signals exist.")

    if recent_logs:
        log_summary = []
        for entry in recent_logs[:3]:
            actions = entry.get("actionsConsidered", [])
            chosen = [a for a in actions if a.get("chosen")]
            skipped = entry.get("skipped", False)
            log_summary.append(
                f"- ts={entry.get('ts', '?')}, idle={entry.get('idle', '?')}, "
                f"actions_chosen={len(chosen)}, skipped={skipped}"
            )
            for a in chosen:
                log_summary.append(f"  -> {a.get('action', '?')}: {a.get('reason', '?')}")
        parts.append(f"\n## Recent Log Entries (last 3)\n" + "\n".join(log_summary))

    if playbook:
        # Truncate playbook to first 30 lines for context
        lines = playbook.splitlines()[:30]
        parts.append(f"\n## Current Playbook (first 30 lines)\n" + "\n".join(lines))

    return "\n".join(parts)


def main():
    parser = argparse.ArgumentParser(description="Phase 2: Signal detection")
    parser.add_argument("--memory-dir", required=True, help="Path to memory/ directory")
    parser.add_argument("--session-summary", required=True, help="Brief session summary from main agent")
    parser.add_argument("--idle", action="store_true", help="User is idle (>30 min)")
    args = parser.parse_args()

    playbook = read_playbook(args.memory_dir)
    recent_logs = read_recent_logs(args.memory_dir, days=3)

    user_prompt = build_user_prompt(
        session_summary=args.session_summary,
        recent_logs=recent_logs,
        playbook=playbook,
        idle=args.idle,
    )

    raw = call_llm(SYSTEM_PROMPT, user_prompt, script="signal_analyzer")

    # Parse LLM response — extract JSON from possible markdown wrapping
    try:
        # Strip markdown code fences if present
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = "\n".join(cleaned.split("\n")[1:])
        if cleaned.endswith("```"):
            cleaned = "\n".join(cleaned.split("\n")[:-1])
        result = json.loads(cleaned)
    except json.JSONDecodeError:
        print(f"[warn] LLM returned non-JSON, using fallback: {raw[:200]}", file=sys.stderr)
        result = {
            "signals": [],
            "recommendedAction": None,
            "idle": args.idle,
        }

    # Ensure idle flag matches CLI arg
    result["idle"] = args.idle
    output_json(result)


if __name__ == "__main__":
    main()
