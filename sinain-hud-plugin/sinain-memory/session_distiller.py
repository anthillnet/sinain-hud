#!/usr/bin/env python3
"""Session Distiller — condense session transcript into a SessionDigest.

Takes feed items + agent digests from sinain-core and produces a structured
digest of what happened, what patterns emerged, and what was learned.

Single LLM call, ~10s. Replaces: signal_analyzer + insight_synthesizer +
memory_miner for the purpose of knowledge extraction.

Usage:
    python3 session_distiller.py --memory-dir memory/ \
        --transcript '[ ... feed items ... ]' \
        --session-meta '{"sessionKey":"...","durationMs":...}'
"""

import argparse
import json
import sys
from pathlib import Path

from common import (
    LLMError,
    call_llm_with_fallback,
    extract_json,
    output_json,
    read_effective_playbook,
)

SYSTEM_PROMPT = """\
You are a session distiller for a personal AI overlay system (sinain).
Your job: analyze a session transcript and extract ALL knowledge worth remembering.

The transcript contains feed items from sinain-core:
- audio: transcribed speech from the user's environment
- agent: sinain's analysis digests and HUD messages
- openclaw: responses from the AI escalation system
- system: system events and status messages

Extract:
1. whatHappened: 2-3 sentences summarizing what occurred in this session
2. facts: up to 15 concrete factual claims stated in the session. Each fact must be a \
self-contained sentence. Cover ALL types: people and their roles/backgrounds, \
organizations and their properties, numbers/quantities/dates, relationships between \
entities, technical details. Prioritize facts someone might ask about later.
   Good: "The CTO of Al-Futaim previously worked at Citibank for 17 years as Director of IT in Singapore"
   Good: "Citibank has 2400 IntelliJ subscriptions and heavy TeamCity usage"
   Bad: "client-understanding-key: True"
3. decisions: up to 5 decisions or agreements made (who decided what, with any deadline)
4. entities: key people, organizations, tools, and topics mentioned (as lowercase-hyphenated slugs)
5. patterns: up to 3 reusable techniques or workflows (if any — skip if none)
6. preferences: up to 3 user preferences or habits observed

Entity naming: use actual names from the conversation, not abstract categories.
   Good: "citibank", "al-futaim-group", "artom", "intellij"
   Bad: "ai-solutions", "client-understanding", "tool-usage"

If existing entities are provided, reference them by name to enable reinforcement.
Focus on CONCRETE, SPECIFIC knowledge. Skip vague observations.
If the session was idle or empty, say so briefly.

Respond with ONLY a JSON object:
{
  "whatHappened": "string",
  "facts": ["self-contained factual sentence", ...],
  "decisions": ["decision sentence with who/what/when", ...],
  "entities": ["citibank", "al-futaim-group", "artom", ...],
  "patterns": ["reusable technique or workflow", ...],
  "preferences": ["user preference or habit", ...],
  "isEmpty": false
}"""


def _truncate_transcript(items: list[dict], max_chars: int = 100_000) -> str:
    """Format and truncate feed items to fit context window."""
    lines: list[str] = []
    total = 0
    for item in items:
        source = item.get("source", "?")
        text = item.get("text", "")
        ts = item.get("ts", "")

        # Strip [PERIODIC] items — they're overlay refresh noise
        if text.startswith("[PERIODIC]"):
            continue

        # Format timestamp as HH:MM:SS if numeric
        ts_str = ""
        if isinstance(ts, (int, float)) and ts > 0:
            from datetime import datetime, timezone
            ts_str = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime("%H:%M:%S")
        elif isinstance(ts, str):
            ts_str = ts[-8:] if len(ts) > 8 else ts

        line = f"[{ts_str}] ({source}) {text}"
        if total + len(line) > max_chars:
            lines.append(f"... truncated ({len(items) - len(lines)} more items)")
            break
        lines.append(line)
        total += len(line)

    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Session Distiller")
    parser.add_argument("--memory-dir", required=True, help="Path to memory/ directory")
    parser.add_argument("--transcript", required=True, help="JSON array of feed items")
    parser.add_argument("--session-meta", default="{}", help="JSON session metadata")
    parser.add_argument("--existing-entities", default="", help="Compact summary of existing knowledge graph entities")
    args = parser.parse_args()

    # Parse inputs
    try:
        items = json.loads(args.transcript)
    except json.JSONDecodeError as e:
        print(f"Invalid transcript JSON: {e}", file=sys.stderr)
        output_json({"error": f"Invalid transcript JSON: {e}", "isEmpty": True})
        return

    meta = json.loads(args.session_meta) if args.session_meta else {}

    # Skip if transcript is trivially empty
    if not items or len(items) < 2:
        output_json({
            "whatHappened": "Empty or trivial session",
            "facts": [],
            "decisions": [],
            "entities": [],
            "patterns": [],
            "preferences": [],
            "isEmpty": True,
        })
        return

    # Format transcript
    transcript_text = _truncate_transcript(items)

    # Include current playbook for context (helps avoid re-discovering known patterns)
    playbook = read_effective_playbook(args.memory_dir)
    playbook_summary = ""
    if playbook:
        lines = [l for l in playbook.splitlines() if l.strip() and not l.startswith("<!--")]
        playbook_summary = f"\n\n## Current Playbook (for reference — don't repeat known patterns)\n{chr(10).join(lines[:30])}"

    # Include existing entities for retrieve-before-extract (Mem0 pattern)
    existing_section = ""
    if args.existing_entities and args.existing_entities.strip():
        existing_section = f"\n\n## Existing Knowledge (reinforce or update these if the session confirms/changes them)\n{args.existing_entities}"

    user_prompt = f"""## Session Transcript ({len(items)} items)
{transcript_text}

## Session Metadata
{json.dumps(meta, indent=2)}{playbook_summary}{existing_section}"""

    try:
        raw = call_llm_with_fallback(
            SYSTEM_PROMPT,
            user_prompt,
            script="session_distiller",
            json_mode=True,
        )
        result = extract_json(raw)
    except (ValueError, LLMError) as e:
        print(f"LLM distillation failed: {e}", file=sys.stderr)
        output_json({"error": str(e), "isEmpty": True})
        return

    # Add metadata
    result["ts"] = meta.get("ts", "")
    result["sessionKey"] = meta.get("sessionKey", "")
    result["durationMs"] = meta.get("durationMs", 0)
    result["feedItemCount"] = len(items)

    output_json(result)


if __name__ == "__main__":
    main()
