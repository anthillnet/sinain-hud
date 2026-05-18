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
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from common import (
    LLMError,
    call_llm_with_fallback,
    extract_json,
    output_json,
    read_effective_playbook,
)


def _log_distillation_failure(
    memory_dir: str,
    error: Exception,
    raw_response: str | None,
    transcript: str,
    stage: str,
) -> None:
    """Append a structured record to distiller-failures.jsonl for post-hoc analysis.

    Stage 2 prep: stops the silent isEmpty drop from being invisible. Failures here
    must never propagate — observability is not allowed to break the pipeline it observes.
    """
    try:
        record = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "stage": stage,
            "error_type": type(error).__name__,
            "error_message": str(error),
            "raw_response": raw_response[:5000] if raw_response else None,
            "raw_response_length": len(raw_response) if raw_response else 0,
            "transcript_hash": hashlib.sha256(transcript.encode("utf-8")).hexdigest()[:16],
            "transcript_length": len(transcript),
        }
        log_path = Path(memory_dir) / "distiller-failures.jsonl"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a") as f:
            f.write(json.dumps(record) + "\n")
    except Exception:
        pass

SYSTEM_PROMPT = """\
You are a session distiller for a personal AI overlay system (sinain).
Your job: analyze a session transcript and extract structured knowledge as a typed graph.

The transcript contains feed items from sinain-core:
- audio: transcribed speech from the user's environment
- agent: sinain's analysis digests and HUD messages
- openclaw: responses from the AI escalation system
- system: system events and status messages

**Output is a typed graph with TWO connected layers — `entities` (typed nodes) and `facts` (subject-predicate-object triples).** Free-text claims belong in `whatHappened`; everything queryable belongs in the graph.

## entities — declare every node you'll reference

Each entity is an object with these required fields:
- `id`: lowercase-hyphenated slug, used as the canonical reference key in facts (e.g., "citibank", "al-futaim-cto", "react-native")
- `name`: display name (e.g., "Citibank", "Al-Futaim CTO", "React Native")
- `type`: a schema.org class string. Pick the closest match:
  - `schema:Person` (named individuals, roles like "the CTO")
  - `schema:Organization` (companies, teams, projects-as-org)
  - `schema:SoftwareApplication` (tools, frameworks, IDEs, libraries)
  - `schema:CreativeWork` (documents, designs, code files)
  - `schema:Event` (meetings, releases, incidents)
  - `schema:Place` (cities, offices, regions)
  - `schema:Product` (physical or digital products)
  - `schema:Project` (named initiatives, sprints)
  - `schema:Service` (APIs, infra services)
  - `schema:Concept` (abstract topics, methodologies)
  - `schema:Action` (specific things someone did)
  - `schema:Quantity` (numeric measurements with units)
  - `schema:Date` (specific dates, deadlines)
- `altLabels`: array of strings — synonyms, abbreviations, misspellings, role-paraphrases. **CRITICAL: every proper-noun entity MUST have at least one altLabel.** Whisper STT mishears proper nouns (Citibank → "City Bank"; JetBrains → "Jet Brains"); altLabels are how we recover. For a role-typed Person, include the role-paraphrases you heard ("the CTO", "the senior executive"). Empty array is ONLY acceptable for common-noun entities.

**User anchor — REQUIRED when any first-person utterance exists:** if the transcript contains anything in first person ("I X", "my Y", "we Z", "I've been"), you MUST declare an entity with `id: "user"`, `type: "schema:Person"`, `name: "User"`, `altLabels: ["I", "me", "my", "mine", "myself", "we", "the user"]`. Then every first-person fact becomes a triple anchored on `subject: "user"`. Examples:
  - "I ran a 5K in 25:50" → entity `user` + fact `{subject: "user", predicate: "personalBest5KTime", object: "25:50", value_type: "literal"}`
  - "I need to return 3 items to the store" → entity `user` + fact `{subject: "user", predicate: "needsToReturn", object: "3-clothing-items", value_type: "ref"}`
  - "I asked Claude Code to refactor my auth module" → entity `user` + fact `{subject: "user", predicate: "askedAgent", object: "claude-code", value_type: "ref"}`

## facts — subject-predicate-object triples

Each fact is an object with:
- `subject`: the `id` of an entity declared in `entities`
- `predicate`: a domain relation name in camelCase. Prefer schema.org vocabulary when applicable:
  - `worksFor`, `previouslyWorkedAt`, `roleOf`, `jobTitle`, `homeLocation`, `workLocation`
  - `subscribesTo`, `uses`, `dependsOn`, `competes`, `partnerOf`
  - `startDate`, `endDate`, `duration`, `attendedBy`
  - `quantityOf`, `priceOf`, `versionOf`
  Use freeform camelCase predicates when no canonical fits, e.g. `prefers`, `expressedConcernAbout`.
- `object`: EITHER another entity's `id` (set `value_type: "ref"`) OR a literal string (set `value_type: "literal"`). Numbers and dates are literals as strings.
- `value_type`: `"ref"` or `"literal"`. Required.
- `confidence`: optional float 0.0-1.0; default 0.9.

Up to 25 facts per session. Spread across these dimensions — do NOT let one theme dominate:
- **WHO**: people, roles, backgrounds, relationships (`previouslyWorkedAt`, `roleOf`, `reportsTo`)
- **WHAT**: properties, attributes, descriptions (`uses`, `dependsOn`, `versionOf`)
- **HOW MUCH**: numbers, quantities, dates, durations (`quantityOf`, `subscriptionCount`, `duration`)
- **WHAT CHANGED**: decisions, agreements, state transitions (`decidedTo`, `switchedFrom`, `committedTo`)
- **WHAT'S NEXT**: commitments, action items, deadlines (`willDeliver`, `dueBy`, `plannedFor`)

If 5+ facts cover one dimension and 0 cover another that was discussed, you are missing something. Breadth over depth.

## Other top-level fields

- `whatHappened`: 2-3 sentence prose summary (free text — NOT in the graph)
- `decisions`: up to 5 decision sentences ("who decided what, with any deadline")
- `patterns`: up to 3 reusable techniques or workflows (skip if none)
- `preferences`: up to 3 user preferences or habits observed
- `isEmpty`: true if the session had nothing substantive

If existing entities are provided in context, reuse their `id`s exactly so the integrator can reinforce them.

## Example output

```json
{
  "whatHappened": "Al-Futaim's CTO described prior employment and tooling. Background discussion covered subscription counts and the CDO role.",
  "entities": [
    {"id": "citibank", "name": "Citibank", "type": "schema:Organization", "altLabels": ["Citi", "City Bank", "Citicorp"]},
    {"id": "al-futaim-cto", "name": "Al-Futaim CTO", "type": "schema:Person", "altLabels": ["the CTO", "the senior executive", "the chief technology officer"]},
    {"id": "singapore", "name": "Singapore", "type": "schema:Place", "altLabels": ["SG", "Republic of Singapore"]},
    {"id": "intellij", "name": "IntelliJ IDEA", "type": "schema:SoftwareApplication", "altLabels": ["IntelliJ", "IDEA", "JetBrains IntelliJ", "Jet Brains"]},
    {"id": "teamcity", "name": "TeamCity", "type": "schema:SoftwareApplication", "altLabels": ["Team City"]},
    {"id": "al-futaim-cdo", "name": "Al-Futaim CDO", "type": "schema:Person", "altLabels": ["the CDO", "the chief data officer"]},
    {"id": "ai-engineering-lead", "name": "AI Engineering Lead", "type": "schema:Concept", "altLabels": ["AI eng lead"]}
  ],
  "facts": [
    {"subject": "al-futaim-cto", "predicate": "previouslyWorkedAt", "object": "citibank", "value_type": "ref"},
    {"subject": "al-futaim-cto", "predicate": "workLocation", "object": "singapore", "value_type": "ref"},
    {"subject": "al-futaim-cto", "predicate": "yearsOfTenure", "object": "17", "value_type": "literal"},
    {"subject": "al-futaim-cto", "predicate": "jobTitle", "object": "Director of IT", "value_type": "literal"},
    {"subject": "citibank", "predicate": "subscribesTo", "object": "intellij", "value_type": "ref"},
    {"subject": "citibank", "predicate": "subscriptionCount", "object": "2400", "value_type": "literal"},
    {"subject": "citibank", "predicate": "uses", "object": "teamcity", "value_type": "ref"},
    {"subject": "al-futaim-cdo", "predicate": "previouslyWorkedAt", "object": "citibank", "value_type": "ref"},
    {"subject": "al-futaim-cdo", "predicate": "roleOf", "object": "ai-engineering-lead", "value_type": "ref"}
  ],
  "decisions": [],
  "patterns": [],
  "preferences": [],
  "isEmpty": false
}
```

## Hard rules

- Every `fact.subject` MUST appear in `entities` (with matching `id`). Same for `fact.object` when `value_type` is `"ref"`.
- Every proper-noun entity (named person, named company, named tool/product) MUST have at least one altLabel.
- If you don't know an entity's schema.org type, prefer `schema:Concept` over guessing wrong.
- Numbers, dates, and durations are literals — never invent entity ids for them unless they refer to a named/recurring thing.
- **If first-person utterances exist, `entity:user` MUST be declared AND every first-person property MUST be a triple with `subject: "user"`. No first-person content may live only in `whatHappened` or `facts` strings — it must be in the graph.**
- If the session was idle or empty, return `isEmpty: true` with empty arrays and a one-sentence `whatHappened`.

Respond with ONLY a JSON object matching the example shape above. No prose before or after."""


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

    raw: str | None = None
    stage = "llm_call"
    try:
        raw = call_llm_with_fallback(
            SYSTEM_PROMPT,
            user_prompt,
            script="session_distiller",
            json_mode=True,
            temperature=0.0,
        )
        stage = "extract_json"
        result = extract_json(raw)
    except (ValueError, LLMError) as e:
        print(f"LLM distillation failed at {stage}: {e}", file=sys.stderr)
        _log_distillation_failure(args.memory_dir, e, raw, args.transcript, stage)
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
