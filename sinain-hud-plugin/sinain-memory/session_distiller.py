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
2. facts: up to 15 concrete factual claims. Each fact is an OBJECT with:
   - "text": self-contained factual sentence
   - "occurredStart" (optional ISO date): earliest time this fact was true in the world.
     Set this when the source mentions a date or relative anchor ("yesterday",
     "last week", "in September 2024"). Omit when the fact is a stable property
     with no time anchor.
   - "occurredEnd" (optional ISO date): most recent time this fact was true.
     Set this for facts that are bounded ("until June 2026", "before the layoffs",
     "ended last quarter"). Omit when the fact is still current.
   IMPORTANT — spread across these dimensions (do not let one theme dominate):
   - WHO: people mentioned, their roles, backgrounds, relationships to each other
   - WHAT: specific claims, properties, descriptions of things discussed
   - HOW MUCH: any numbers, quantities, dates, durations, counts stated
   - WHAT CHANGED: decisions made, agreements reached, state changes
   - WHAT'S NEXT: commitments, action items, plans, deadlines
   If you have 5+ facts about one dimension and 0 about another that was discussed, \
you are missing something. Breadth over depth.
   Good: {"text": "The CTO of Al-Futaim previously worked at Citibank for 17 years as Director of IT in Singapore"}
   Good: {"text": "Citibank has 2400 IntelliJ subscriptions and heavy TeamCity usage"}
   Good: {"text": "The meeting is 45 minutes, scheduled for Tuesday", "occurredStart": "2026-05-12"}
   Good: {"text": "Sarah was CTO at Acme from 2020 to 2023", "occurredStart": "2020-01-01", "occurredEnd": "2023-12-31"}
   Bad: {"text": "client-understanding-key: True"}
3. decisions: up to 5 decisions or agreements made. SAME object shape as facts
   (text + optional occurredStart/occurredEnd).
4. entities: named things discussed or interacted with — as objects with:
   - "name" (lowercase-hyphenated slug)
   - "type" (freeform — person, org, tool, file, concept, service, framework, error, whatever fits)
   - "aliases" (optional list of strings): alternate surface forms the source used
     to refer to this entity ("the CEO", "Sarah", "Sarah Chen"). Helps coreference
     resolution. Omit when the entity was always referred to by one name.
   Examples:
     {"name": "citibank", "type": "org"}
     {"name": "sarah-chen", "type": "person", "aliases": ["Sarah", "the CEO", "Sarah Chen"]}
     {"name": "react-native", "type": "framework"}
5. patterns: up to 3 reusable techniques or workflows (plain strings — no time anchors)
6. preferences: up to 3 user preferences or habits observed (plain strings)

If existing entities are provided, reference them by name to enable reinforcement.
Focus on CONCRETE, SPECIFIC knowledge. Skip vague observations.
If the session was idle or empty, say so briefly.

For backwards compatibility, facts and decisions may be emitted as plain strings
if no temporal anchor exists — the parser accepts both shapes. Prefer the object
shape when you've detected a temporal anchor or an alias.

Respond with ONLY a JSON object:
{
  "whatHappened": "string",
  "facts": [{"text": "...", "occurredStart": "...", "occurredEnd": "..."}, ...],
  "decisions": [{"text": "...", "occurredStart": "..."}, ...],
  "entities": [{"name": "citibank", "type": "org", "aliases": ["Citi"]}, ...],
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
