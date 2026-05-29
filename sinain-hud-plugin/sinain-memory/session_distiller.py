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
import os
import sys
from pathlib import Path

from common import (
    LLMError,
    call_llm_with_fallback,
    extract_json,
    output_json,
    read_effective_playbook,
)

# Strict JSON Schema for the distiller's response shape. Forces atomic facts[]
# vs narrative paragraphs — the failure mode for qwen2.5:7b (0/2) and
# gemma4:e2b (q1 0/1) on LongMemEval-S. Bounds string lengths so a model
# can't pack a session summary into a single "fact" item.
#
# Diarization Lever 1 (2026-05-28): facts items may now be EITHER a bare string
# (legacy shape) OR an object {text, attributedTo?, subject?}. attributedTo
# carries the SPEAKER_NN tag when the transcript supplied speaker labels;
# subject is the entity/person the fact is ABOUT (may differ from speaker).
# Integrator detects shape and routes attributedTo into mentioned_by triples
# (per-fact granularity, replacing batch-level fallback).
DIGEST_SCHEMA = {
    "title": "SessionDigest",
    "type": "object",
    "properties": {
        "whatHappened": {"type": "string", "minLength": 1, "maxLength": 600},
        "facts": {
            "type": "array",
            "maxItems": 20,
            # Per-fact bound: 250 chars is enough for "X has a degree in Y" or
            # "Citibank has 2400 IntelliJ subscriptions" but too short for a
            # paragraph-style summary.
            # Lever 1: items are now `oneOf` either string OR fact-object.
            # Distillers that ignore the new shape continue to emit strings;
            # those that adopt it gain per-fact attribution.
            "items": {
                "oneOf": [
                    {"type": "string", "minLength": 10, "maxLength": 250},
                    {
                        "type": "object",
                        "properties": {
                            "text": {"type": "string", "minLength": 10, "maxLength": 250},
                            "attributedTo": {"type": "string", "maxLength": 40},
                            "subject": {"type": "string", "maxLength": 80},
                        },
                        "required": ["text"],
                        "additionalProperties": False,
                    },
                ],
            },
        },
        "decisions": {
            "type": "array",
            "maxItems": 10,
            "items": {"type": "string", "minLength": 5, "maxLength": 300},
        },
        "entities": {
            "type": "array",
            "maxItems": 30,
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "minLength": 1, "maxLength": 80},
                    "type": {"type": "string", "minLength": 1, "maxLength": 40},
                },
                "required": ["name", "type"],
                "additionalProperties": False,
            },
        },
        "patterns": {
            "type": "array",
            "maxItems": 5,
            "items": {"type": "string", "minLength": 5, "maxLength": 300},
        },
        "preferences": {
            "type": "array",
            "maxItems": 5,
            "items": {"type": "string", "minLength": 5, "maxLength": 200},
        },
        "isEmpty": {"type": "boolean"},
    },
    "required": ["whatHappened", "facts", "decisions", "entities", "patterns", "preferences", "isEmpty"],
    "additionalProperties": False,
}


SYSTEM_PROMPT = """\
You are a session distiller for a personal AI overlay system (sinain).
Your job: analyze a session transcript and extract ALL knowledge worth remembering.

The transcript contains feed items from sinain-core:
- audio: transcribed speech from the user's environment
- agent: sinain's analysis digests and HUD messages
- openclaw: responses from the AI escalation system
- system: system events and status messages
- SPEAKER_NN (e.g. SPEAKER_00, SPEAKER_01): an identified speaker in transcribed \
audio. The speaker tag is anonymous (no real name) but persistent within a session. \
Use it to attribute claims when relevant — see facts schema below.

Extract:
1. whatHappened: 2-3 sentences summarizing what occurred in this session
2. facts: up to 15 concrete factual claims. Each must be a self-contained sentence. \
IMPORTANT — spread across these dimensions (do not let one theme dominate):
   - WHO: people mentioned, their roles, backgrounds, relationships to each other
   - WHAT: specific claims, properties, descriptions of things discussed
   - HOW MUCH: any numbers, quantities, dates, durations, counts stated
   - WHAT CHANGED: decisions made, agreements reached, state changes
   - WHAT'S NEXT: commitments, action items, plans, deadlines
   If you have 5+ facts about one dimension and 0 about another that was discussed, \
you are missing something. Breadth over depth.

   **Fact shape**: each item is either a plain string (legacy) OR an object \
{"text": "...", "attributedTo": "SPEAKER_NN", "subject": "entity-name"}. Use the \
object form when the transcript contains SPEAKER_NN tags; populate attributedTo with \
the speaker who uttered the claim. subject is the entity the fact is ABOUT (may differ \
from speaker — e.g. SPEAKER_01 says something about Maria → attributedTo=SPEAKER_01, \
subject=maria). Omit attributedTo if uncertain; omit subject if the fact is general. \
NEVER put SPEAKER_NN inside the text field — keep speaker info in the structured fields.

   (Examples below are generic ONLY to show the shape — they are not about any \
particular topic; extract facts from the actual transcript, whatever its domain.)
   Good (object form): {"text": "Sam migrated the payment service to the new retry \
queue over three weeks", "attributedTo": "SPEAKER_02", "subject": "sam"}
   Good (object form): {"text": "The user is allergic to penicillin", \
"attributedTo": "SPEAKER_USER", "subject": "user"}
   Good (legacy string): "The build pipeline runs on GitHub Actions, ~12 min average"
   Bad: "SPEAKER_02 said the service was migrated" (don't bake the tag into text)
   Bad: five near-duplicate variations of the same claim
3. decisions: up to 5 decisions or agreements made (who decided what, with any deadline)
4. entities: named things discussed or interacted with — as objects with name \
(lowercase-hyphenated slug) and type (freeform — person, org, tool, file, concept, \
service, framework, error, whatever fits the context).
   Examples: {"name": "citibank", "type": "org"}, {"name": "auth-module", "type": "file"}, \
{"name": "react-native", "type": "framework"}
5. patterns: up to 3 reusable techniques or workflows (if any — skip if none)
6. preferences: up to 3 user preferences or habits observed

If existing entities are provided, reference them by name to enable reinforcement.
Focus on CONCRETE, SPECIFIC knowledge. Skip vague observations.
If the session was idle or empty, say so briefly.

Respond with ONLY a JSON object:
{
  "whatHappened": "string",
  "facts": [
    {"text": "self-contained factual sentence", "attributedTo": "SPEAKER_NN", "subject": "entity-name"},
    "or a plain string if no speaker context",
    ...
  ],
  "decisions": ["decision sentence with who/what/when", ...],
  "entities": [{"name": "citibank", "type": "org"}, {"name": "artom", "type": "person"}, ...],
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

    # SINAIN_STRUCTURED_DISTILLER=0 disables strict JSON Schema mode for
    # A/B comparison. Default is on — measurement showed 0/2 → ?/2 for qwen
    # and confirms phi/cloud don't regress under the constraint.
    use_schema = os.environ.get("SINAIN_STRUCTURED_DISTILLER", "1") != "0"
    try:
        raw = call_llm_with_fallback(
            SYSTEM_PROMPT,
            user_prompt,
            script="session_distiller",
            json_mode=True,
            json_schema=DIGEST_SCHEMA if use_schema else None,
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
