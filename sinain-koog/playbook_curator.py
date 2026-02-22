#!/usr/bin/env python3
"""Phase 3 Step 3: Playbook Curator — archive and update sinain-playbook.md.

Archives current playbook, uses LLM to curate (add/prune/promote patterns),
writes the updated playbook back. Respects the curate directive from feedback_analyzer.

Usage:
    python3 playbook_curator.py --memory-dir memory/ --session-summary "..." \
        [--curate-directive normal] [--mining-findings "TEXT"]
"""

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

from common import (
    call_llm,
    output_json,
    read_playbook,
    read_recent_logs,
)

SYSTEM_PROMPT = """\
You are a playbook curator for a personal AI assistant (sinain).
Your job: maintain a concise, high-quality playbook of patterns and observations.

The playbook has these sections:
1. Header comments (mining-index) — DO NOT modify these
2. Patterns: "When [context], [approach] worked (score: X)" or failed patterns
3. User preference observations
4. Stale items with [since: YYYY-MM-DD] or [deferred: YYYY-MM-DD, reason: "..."] tags
5. Footer comments (effectiveness) — DO NOT modify these

Curate rules:
- ADD new successful patterns from recent sessions
- ADD failed patterns with reasons
- ADD user preference observations (recurring topics, tools, rhythms)
- PRUNE entries older than 7 days without reinforcement
- PROMOTE patterns seen 3+ times from "observed" to "established"
- Three Laws: (1) don't remove error-prevention patterns, (2) preserve high-scoring approaches, (3) then evolve
- Keep under 50 lines — density over completeness

Curate directive controls aggressiveness:
- "aggressive_prune": effectiveness is low — remove weak/unverified patterns aggressively
- "normal": balanced add/prune cycle
- "stability": effectiveness is high — only add patterns with strong evidence (score > 0.5)
- "insufficient_data": skip effectiveness adjustments, focus on gathering patterns

Stale item rules:
- New fixable patterns get [since: YYYY-MM-DD] tag
- 48h without change → mandatory Phase 2 action (not your concern, just keep the tag)
- After 3 actions without resolution → move to [deferred: YYYY-MM-DD, reason: "..."]
- Max 5 deferred items; if adding 6th, prune oldest deferred

Respond with ONLY a JSON object:
{
  "updatedPlaybook": "full text of updated playbook (body only, between header/footer comments)",
  "changes": {
    "added": ["pattern text", ...],
    "pruned": ["pattern text", ...],
    "promoted": ["pattern text", ...]
  },
  "staleItemActions": ["description of stale item handling", ...]
}"""


def archive_playbook(memory_dir: str) -> str | None:
    """Archive current playbook to playbook-archive/. Returns archive path or None."""
    src = Path(memory_dir) / "sinain-playbook.md"
    if not src.exists():
        return None

    archive_dir = Path(memory_dir) / "playbook-archive"
    archive_dir.mkdir(parents=True, exist_ok=True)

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M")
    dest = archive_dir / f"sinain-playbook-{ts}.md"
    shutil.copy2(src, dest)
    return str(dest)


def extract_header_footer(playbook: str) -> tuple[str, str, str]:
    """Split playbook into (header_comments, body, footer_comments).

    Header: lines starting with <!-- mining-index or other top comments
    Footer: lines starting with <!-- effectiveness
    Body: everything between
    """
    lines = playbook.splitlines()
    header_lines = []
    footer_lines = []
    body_lines = []

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("<!-- mining-index:"):
            header_lines.append(line)
        elif stripped.startswith("<!-- effectiveness:"):
            footer_lines.append(line)
        else:
            body_lines.append(line)

    return "\n".join(header_lines), "\n".join(body_lines), "\n".join(footer_lines)


def reassemble_playbook(header: str, body: str, footer: str) -> str:
    """Reassemble playbook from header + body + footer, ensuring under 50 lines."""
    parts = []
    if header.strip():
        parts.append(header.strip())
    if body.strip():
        parts.append(body.strip())
    if footer.strip():
        parts.append(footer.strip())

    text = "\n\n".join(parts)

    # Enforce 50-line limit on body (header/footer don't count)
    body_lines = body.strip().splitlines()
    if len(body_lines) > 50:
        body = "\n".join(body_lines[:50])
        text = "\n\n".join(filter(None, [header.strip(), body.strip(), footer.strip()]))

    return text + "\n"


def main():
    parser = argparse.ArgumentParser(description="Phase 3: Playbook curation")
    parser.add_argument("--memory-dir", required=True, help="Path to memory/ directory")
    parser.add_argument("--session-summary", required=True, help="Brief session summary")
    parser.add_argument("--curate-directive", default="normal",
                        choices=["aggressive_prune", "normal", "stability", "insufficient_data"],
                        help="Curation aggressiveness directive")
    parser.add_argument("--mining-findings", default="", help="Findings from memory_miner (if available)")
    args = parser.parse_args()

    playbook = read_playbook(args.memory_dir)
    logs = read_recent_logs(args.memory_dir, days=7)

    # Archive before modification
    archive_path = archive_playbook(args.memory_dir)
    if archive_path:
        print(f"[info] Archived playbook to {archive_path}", file=sys.stderr)

    header, body, footer = extract_header_footer(playbook)

    # Build LLM prompt
    log_summary = []
    for entry in logs[:10]:
        changes = entry.get("playbookChanges", {})
        output = entry.get("output", {})
        log_summary.append({
            "ts": entry.get("ts", "?"),
            "changes": changes,
            "suggestion": (output.get("suggestion", "") if output else "")[:100],
            "skipped": entry.get("skipped", False),
        })

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    user_prompt = (
        f"## Current Date\n{today}\n\n"
        f"## Curate Directive\n{args.curate_directive}\n\n"
        f"## Session Summary\n{args.session_summary}\n\n"
        f"## Current Playbook Body\n{body}\n\n"
        f"## Recent Log Entries (last 10)\n{json.dumps(log_summary, indent=2)}\n\n"
    )
    if args.mining_findings:
        user_prompt += f"## Mining Findings\n{args.mining_findings}\n\n"

    user_prompt += "Curate the playbook. Return the FULL updated body text and a summary of changes."

    raw = call_llm(SYSTEM_PROMPT, user_prompt, max_tokens=1500)

    # Parse response
    try:
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = "\n".join(cleaned.split("\n")[1:])
        if cleaned.endswith("```"):
            cleaned = "\n".join(cleaned.split("\n")[:-1])
        result = json.loads(cleaned)
    except json.JSONDecodeError:
        print(f"[warn] LLM returned non-JSON, keeping playbook unchanged: {raw[:200]}", file=sys.stderr)
        output_json({
            "changes": {"added": [], "pruned": [], "promoted": []},
            "staleItemActions": [],
            "playbookLines": len(body.splitlines()),
            "error": "LLM response parse failed",
        })
        return

    # Write updated playbook
    updated_body = result.get("updatedPlaybook", body)
    new_playbook = reassemble_playbook(header, updated_body, footer)

    playbook_path = Path(args.memory_dir) / "sinain-playbook.md"
    playbook_path.parent.mkdir(parents=True, exist_ok=True)
    playbook_path.write_text(new_playbook, encoding="utf-8")

    body_lines = updated_body.strip().splitlines()
    output_json({
        "changes": result.get("changes", {"added": [], "pruned": [], "promoted": []}),
        "staleItemActions": result.get("staleItemActions", []),
        "playbookLines": len(body_lines),
    })


if __name__ == "__main__":
    main()
