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
Your job: extract every concrete, atomic fact worth remembering from the transcript.

The transcript contains feed items:
- audio: speech from the user's environment (usually first-person statements)
- agent: sinain's HUD messages
- openclaw: AI escalation responses
- system: system events

# FACT EXTRACTION (the most important output)

Extract up to 25 ATOMIC factual claims. Each fact must:
- Stand alone as a complete declarative sentence
- State ONE specific claim — not a summary of what was discussed
- Be answerable to a future question ("what size is my TV?", "when did I visit Japan?", "what's my degree in?")
- Prefer the user's own claims about themselves, their possessions, plans, history, preferences
- Use the surface forms the user actually used (e.g. "Samsung 55-inch 4K smart TV", not "the user's television")

GOOD facts (atomic, answer-shaped, drawn from user's own statements):
  "The user set up a new Samsung 55-inch 4K smart TV on Saturday."
  "The user graduated with a degree in Business Administration."
  "The user attended a literary festival and met author Celeste Ng."
  "The user spent two weeks in Japan on a solo trip."
  "The user decided to buy the TriggerPoint GRID Foam Roller for shoulder recovery."
  "The meeting is scheduled for Tuesday and lasts 45 minutes."
  "Citibank has 2400 IntelliJ subscriptions and uses TeamCity heavily."

BAD facts (summaries, meta-narratives, generic):
  "The user asked about travel credit cards and their benefits for frequent travelers."
  "The user discussed adaptations of lichens to extreme environments."
  "American Express Platinum offers travel insurance up to $2,000 per person."  (encyclopedic — not about the user)
  "client-understanding-key: True"

Aim for breadth across these dimensions when the source supports it (don't let one
theme dominate):
- WHO: people mentioned, their roles, relationships
- WHAT: specific properties of things the user owns, uses, did, plans
- HOW MUCH: numbers, sizes, durations, counts, dates the user stated
- WHAT CHANGED: decisions, agreements, state changes
- WHAT'S NEXT: commitments, action items, deadlines

# FACT SHAPE

Default to plain strings. Only emit the object form when the source mentions a clear
time anchor:
  "facts": [
    "The user graduated with a degree in Business Administration.",
    "The user set up a new Samsung 55-inch 4K smart TV on Saturday.",
    {"text": "Sarah was CTO at Acme from 2020 to 2023", "occurredStart": "2020-01-01", "occurredEnd": "2023-12-31"},
    {"text": "The user is taking a two-week trip to Japan", "occurredStart": "2026-04-01"}
  ]

# DECISIONS

Up to 5 decisions or commitments. Same shape rules as facts (strings preferred,
objects when temporally anchored).

# ENTITIES

Named things — people, products, tools, orgs, places, files, frameworks, etc:
  {"name": "samsung-55-tv", "type": "product"}
  {"name": "celeste-ng", "type": "person", "aliases": ["Celeste Ng", "the author"]}
  {"name": "sarah-chen", "type": "person", "aliases": ["Sarah", "the CEO"]}
- "name" is a lowercase-hyphenated slug
- "type" is freeform (person, org, product, framework, file, ...)
- "aliases" only when the source referred to the entity by multiple surface forms

# PATTERNS / PREFERENCES

Up to 3 each, plain strings, only if the session reveals genuinely reusable patterns
or stable preferences. Skip entirely if nothing clear emerges — do NOT pad.

# OUTPUT

Respond with ONLY a JSON object:
{
  "whatHappened": "2-3 sentence summary of what occurred",
  "facts": [...],
  "decisions": [...],
  "entities": [...],
  "patterns": [...],
  "preferences": [...],
  "isEmpty": false
}

Focus on RECALL of atomic user-centric claims. A future question-answering system
will retrieve these facts to answer specific questions, so each fact must carry
enough on its own to answer one. If the session was idle or empty, say so briefly."""


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
