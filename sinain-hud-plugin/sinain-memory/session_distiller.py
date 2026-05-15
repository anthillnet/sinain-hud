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
- audio: speech from the user's environment
- agent: sinain's HUD messages
- openclaw: AI escalation responses
- system: system events

# FACT EXTRACTION (the most important output)

Extract up to 25 ATOMIC factual claims. Each fact must:
- Stand alone as a complete declarative sentence
- State ONE specific claim — not a summary of what was discussed
- Be answerable to a future question ("what size is my TV?", "what restaurant did the assistant recommend?", "when did Sarah join Acme?")
- Use the surface forms actually present in the source (preserve names, numbers, dates verbatim)

Extract from ALL viewpoints present in the source:
- USER claims about themselves (what they own, did, plan, prefer, decided)
- USER claims about other people, orgs, products, places they discussed
- ASSISTANT claims (what the AI recommended, named, suggested, looked up)
- ENTITY properties (facts about specific people, orgs, products, books, restaurants
  the conversation revolves around)

GOOD facts (atomic, answer-shaped, drawn from any viewpoint):
  "The user set up a new Samsung 55-inch 4K smart TV on Saturday."
  "The user graduated with a degree in Business Administration."
  "The user spent two weeks in Japan on a solo trip."
  "The assistant recommended Roscioli for a romantic dinner in Rome."
  "The assistant suggested Miss Bee Providore for Nasi Goreng in Cihampelas Walk, Bandung."
  "The Plesiosaur in the children's book has a blue scaly body."
  "The CTO of Al-Futaim previously worked at Citibank for 17 years as Director of IT in Singapore."
  "Citibank has 2400 IntelliJ subscriptions and uses TeamCity heavily."
  "The meeting is scheduled for Tuesday and lasts 45 minutes."
  "The user's personal best in the charity 5K is 25 minutes 50 seconds."

BAD facts (summaries, meta-narratives, generic encyclopedia):
  "The user asked about travel credit cards and their benefits for frequent travelers."  (meta-narrative)
  "The user discussed adaptations of lichens to extreme environments."  (meta-narrative)
  "American Express Platinum offers travel insurance up to $2,000 per person."  (generic — not anchored to the conversation)
  "The conversation covered weekend plans and grocery shopping."  (summary, not a fact)

Aim for breadth across these dimensions when the source supports it (don't let one
theme or viewpoint dominate):
- WHO: people mentioned, their roles, relationships, properties
- WHAT: specific properties of things — items owned, used, recommended, discussed
- HOW MUCH: numbers, sizes, durations, counts, dates, prices, scores
- WHAT CHANGED: decisions, agreements, state changes, transitions
- WHAT'S NEXT: commitments, action items, deadlines, plans

If 80% of your facts start with "The user...", you are biased — re-check whether the
source also contains assistant recommendations, third-party people/place properties,
or entity-level claims that deserve extraction.

# FACT SHAPE

Default to plain strings. Only emit the object form when the source mentions a clear
time anchor:
  "facts": [
    "The user graduated with a degree in Business Administration.",
    "The assistant recommended Roscioli for a romantic dinner in Rome.",
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
  {"name": "roscioli", "type": "restaurant", "aliases": ["Roscioli"]}
- "name" is a lowercase-hyphenated slug
- "type" is freeform (person, org, product, restaurant, framework, file, ...)
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

Focus on RECALL of atomic claims from every viewpoint present in the source. A
future question-answering system will retrieve these facts to answer specific
questions — about the user, about people/places/things discussed, and about what
the assistant recommended. Each fact must carry enough on its own to answer one.
If the session was idle or empty, say so briefly."""


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
