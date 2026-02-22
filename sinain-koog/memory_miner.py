#!/usr/bin/env python3
"""Phase 3 Step 1 (idle): Memory Miner — deep-mine daily memory files.

Reads mining index from playbook to find unmined files, reads 2 daily memory
files + devmatrix-summary.md, uses LLM to find patterns and cross-references.
Updates the mining index in the playbook.

Usage:
    python3 memory_miner.py --memory-dir memory/
"""

import argparse
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from common import (
    call_llm,
    list_daily_memory_files,
    output_json,
    parse_mining_index,
    read_file_safe,
    read_playbook,
)

SYSTEM_PROMPT = """\
You are a memory mining agent for a personal AI assistant (sinain).
Your job: read daily memory files and extract patterns, preferences, and insights
that should be added to the evolving playbook.

You receive daily memory files (markdown with session notes, decisions, research)
and the current playbook. Cross-reference to find:

1. Patterns that appear across multiple days but aren't in the playbook
2. User preferences (tools, workflows, topics) that are consistent
3. Multi-day trends: recurring errors, evolving interests, productivity rhythms
4. Contradictions: daily notes that conflict with playbook entries
5. Architectural decisions or technical insights worth preserving

Respond with ONLY a JSON object:
{
  "findings": "2-3 sentence summary of what was discovered",
  "newPatterns": ["pattern description", ...],
  "contradictions": ["playbook entry X contradicts observation Y", ...],
  "preferences": ["user preference observed", ...]
}"""


def get_unmined_files(memory_dir: str, mined_dates: list[str]) -> list[str]:
    """Find daily memory files not yet mined (not in index)."""
    all_files = list_daily_memory_files(memory_dir)
    unmined = []
    for f in all_files:
        # Extract date from filename (YYYY-MM-DD.md)
        stem = Path(f).stem  # "2026-02-17"
        if stem not in mined_dates:
            unmined.append(f)
    return unmined


def update_mining_index(memory_dir: str, playbook: str, new_dates: list[str]) -> None:
    """Update mining-index comment in playbook, removing dates older than 7 days."""
    current_index = parse_mining_index(playbook)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")

    # Merge and filter
    all_dates = set(current_index + new_dates)
    valid_dates = sorted([d for d in all_dates if d >= cutoff], reverse=True)
    new_index_str = ",".join(valid_dates)
    new_comment = f"<!-- mining-index: {new_index_str} -->"

    # Replace or insert
    playbook_path = Path(memory_dir) / "sinain-playbook.md"
    if not playbook_path.exists():
        playbook_path.write_text(new_comment + "\n", encoding="utf-8")
        return

    text = playbook_path.read_text(encoding="utf-8")
    if re.search(r"<!--\s*mining-index:", text):
        text = re.sub(r"<!--\s*mining-index:\s*[^>]*-->", new_comment, text)
    else:
        text = new_comment + "\n" + text

    playbook_path.write_text(text, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Phase 3: Memory mining (idle)")
    parser.add_argument("--memory-dir", required=True, help="Path to memory/ directory")
    args = parser.parse_args()

    playbook = read_playbook(args.memory_dir)
    mined_dates = parse_mining_index(playbook)
    unmined = get_unmined_files(args.memory_dir, mined_dates)

    if not unmined:
        output_json({
            "findings": "All daily memory files have been mined",
            "newPatterns": [],
            "minedSources": [],
        })
        return

    # Pick up to 2 unmined files
    to_mine = unmined[:2]
    mined_contents = {}
    for f in to_mine:
        content = read_file_safe(f)
        if content:
            mined_contents[Path(f).name] = content

    if not mined_contents:
        output_json({
            "findings": "Selected daily files were empty",
            "newPatterns": [],
            "minedSources": [Path(f).name for f in to_mine],
        })
        return

    # Also read devmatrix-summary.md for broader context
    devmatrix = read_file_safe(str(Path(args.memory_dir) / "devmatrix-summary.md"))

    # Build LLM prompt
    parts = [f"## Current Playbook\n{playbook}"]
    for name, content in mined_contents.items():
        # Truncate very large files
        if len(content) > 4000:
            content = content[:4000] + "\n... [truncated]"
        parts.append(f"## Daily Memory: {name}\n{content}")
    if devmatrix:
        if len(devmatrix) > 2000:
            devmatrix = devmatrix[:2000] + "\n... [truncated]"
        parts.append(f"## DevMatrix Summary\n{devmatrix}")

    user_prompt = "\n\n".join(parts)

    raw = call_llm(SYSTEM_PROMPT, user_prompt, max_tokens=1000)

    # Parse
    try:
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = "\n".join(cleaned.split("\n")[1:])
        if cleaned.endswith("```"):
            cleaned = "\n".join(cleaned.split("\n")[:-1])
        result = json.loads(cleaned)
    except json.JSONDecodeError:
        print(f"[warn] LLM returned non-JSON: {raw[:200]}", file=sys.stderr)
        result = {
            "findings": "Mining completed but LLM response was not parseable",
            "newPatterns": [],
        }

    # Update mining index
    new_dates = [Path(f).stem for f in to_mine]
    update_mining_index(args.memory_dir, playbook, new_dates)
    print(f"[info] Updated mining index with {new_dates}", file=sys.stderr)

    output_json({
        "findings": result.get("findings", ""),
        "newPatterns": result.get("newPatterns", []),
        "contradictions": result.get("contradictions", []),
        "preferences": result.get("preferences", []),
        "minedSources": [Path(f).name for f in to_mine],
    })


if __name__ == "__main__":
    main()
