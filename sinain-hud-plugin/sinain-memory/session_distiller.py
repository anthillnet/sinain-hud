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
import re
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
            # "the nightly job processes ~12k records" but too short for a
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
2. facts: up to 25 concrete factual claims. Each must be a self-contained sentence. \
IMPORTANT — spread across these dimensions (do not let one theme dominate):
   - WHO: people mentioned, their roles, backgrounds, relationships to each other
   - WHAT: specific claims, properties, descriptions of things discussed
   - HOW MUCH: any numbers, quantities, dates, durations, counts stated
   - WHAT CHANGED: decisions made, agreements reached, state changes
   - WHAT'S NEXT: commitments, action items, plans, deadlines
   If you have 5+ facts about one dimension and 0 about another that was discussed, \
you are missing something. Breadth over depth.

   **Preserve the LINK, not just the topic.** When a named entity is tied to a \
distinctive attribute, capture that relationship explicitly in ONE self-contained \
fact — do not summarize it away. Examples of the shape (not the topic): a place and \
its signature offering ("Miss Bee Providore serves nasi goreng"), where an action \
happened ("the user redeemed the coffee-creamer coupon at Target"), a product's \
brand/compatibility ("the user's camera is a Sony, so accessories must be Sony-\
compatible"), or a topic focus ("the user's research is on deep learning for medical \
image analysis"). The query later will name the attribute (the dish, the store, the \
brand) and expect the linked entity — so the link must survive distillation.

   **Enumerate distinct items — never collapse them into a count or a bare "items".** \
When the user mentions several distinct things (purchases, returns, tasks, events, \
models, places), record EACH as its own fact ("the user needs to return a blue \
sweater", "...return a pair of jeans", "...pick up boots from Zara"). A later question \
may ask "how many" or "which ones", and that is only answerable if each item is its \
own fact rather than a summarized "several items to return".

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
   Examples: {"name": "postgres", "type": "service"}, {"name": "auth-module", "type": "file"}, \
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
  "entities": [{"name": "postgres", "type": "service"}, {"name": "maria", "type": "person"}, ...],
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


_PROPER_NOUN_RE = re.compile(r"\b[A-Z][A-Za-z]{3,}\b")
_PROPER_BIGRAM_RE = re.compile(r"\b[A-Z][A-Za-z]+ [A-Z][A-Za-z]+\b")
# OCR/UI chrome words that look capitalized but aren't entity names.
_SCREEN_STOPWORDS = frozenset({
    "File", "Edit", "View", "Help", "Window", "Tools", "Search", "Settings",
    "Cancel", "Submit", "Save", "Close", "Open", "Menu", "Home", "Back", "Next",
    "Untitled", "Loading", "Error", "Warning", "Online", "Offline", "Today",
})


def _harvest_screen_entities(items: list[dict], cap: int = 200) -> list[str]:
    """Proper-noun candidates from the session's SCREEN/OCR items (source=sense).

    The names being spoken are usually visible on screen (Slack/IDE/docs), so
    on-screen capitalized tokens are a high-precision, config-free gazetteer for
    correcting the AUDIO transcript — the structural edge a pure-audio ASR
    pipeline lacks. Conservative: capitalized tokens/bigrams len>=4, minus UI
    chrome; the downstream NEC gate (metaphone-equal + ratio) filters the rest.
    """
    from collections import Counter
    counts: Counter = Counter()
    for item in items:
        if item.get("source") != "sense":
            continue
        text = item.get("text", "") or ""
        for m in _PROPER_BIGRAM_RE.findall(text):
            counts[m] += 1
        for m in _PROPER_NOUN_RE.findall(text):
            if m not in _SCREEN_STOPWORDS:
                counts[m] += 1
    return [name for name, _ in counts.most_common(cap)]


def _nec_correct_items(items: list[dict], memory_dir: str) -> list[dict]:
    """ASR-C: deterministic named-entity correction on transcript items BEFORE
    distillation (and before coref — coref mis-binds on un-canonicalized names).

    Fixes proper-noun mangling the ASR introduced ("City Bank"→"Citibank",
    "Jet brains"→"JetBrains") so the distiller extracts the correct entities.
    Gazetteer (auto, no config needed in production):
      1. this memory dir's KG entity:* nodes (accumulates → self-reinforcing);
      2. proper nouns harvested from THIS session's screen/OCR items (the
         spoken names are usually on screen);
      3. SINAIN_NEC_GAZETTEER / TRANSCRIPTION_INITIAL_PROMPT (optional bootstrap).
    Deterministic tier only (Metaphone-equal class — the safely-recoverable one;
    see asr_nec.py for the measured ceiling). Gated SINAIN_NEC (default ON);
    no-op on any failure. Live-validated acme 30-min: sinain 2.04→2.36/5,
    IPR 50.5→57.3%, recall@10 12→20% (gazetteer self-reinforced 12→38 mid-session).
    """
    if os.environ.get("SINAIN_NEC", "1") == "0":
        return items
    try:
        from asr_nec import build_gazetteer, phonetic_correct
        raw_terms = (
            os.environ.get("SINAIN_NEC_GAZETTEER")
            or os.environ.get("TRANSCRIPTION_INITIAL_PROMPT", "")
        )
        extra = [
            t.strip()
            for t in raw_terms.replace("\n", ",").replace(";", ",").split(",")
            if len(t.strip()) >= 3
        ]
        extra.extend(_harvest_screen_entities(items))  # on-screen names (config-free)
        db = str(Path(memory_dir) / "knowledge-graph.db")
        gaz = build_gazetteer(
            db_path=db if Path(db).exists() else None, extra_terms=extra
        )
        if not gaz:
            return items
        total = 0
        for item in items:
            txt = item.get("text", "")
            if not txt or txt.startswith("[PERIODIC]"):
                continue
            corrected, corr = phonetic_correct(txt, gaz)
            if corr:
                item["text"] = corrected
                total += len(corr)
        if total:
            print(
                f"[nec] corrected {total} entity mention(s) across {len(items)} items "
                f"(gazetteer={len(gaz)})",
                file=sys.stderr,
            )
    except Exception as e:  # pragma: no cover
        print(f"[nec] failed (non-fatal): {e}", file=sys.stderr)
    return items


def main() -> None:
    parser = argparse.ArgumentParser(description="Session Distiller")
    parser.add_argument("--memory-dir", required=True, help="Path to memory/ directory")
    parser.add_argument("--transcript", default=None, help="JSON array of feed items (inline)")
    parser.add_argument("--transcript-file", default=None,
                        help="Path to a JSON file with feed items. Preferred over --transcript: "
                             "a 100-item transcript + OCR as a single argv can brush macOS ARG_MAX.")
    parser.add_argument("--session-meta", default="{}", help="JSON session metadata")
    parser.add_argument("--existing-entities", default="", help="Compact summary of existing knowledge graph entities")
    args = parser.parse_args()

    # Parse inputs
    try:
        if args.transcript_file:
            with open(args.transcript_file, encoding="utf-8") as f:
                items = json.load(f)
        elif args.transcript is not None:
            items = json.loads(args.transcript)
        else:
            raise ValueError("--transcript or --transcript-file is required")
    except (json.JSONDecodeError, OSError, ValueError) as e:
        print(f"Invalid transcript: {e}", file=sys.stderr)
        output_json({"error": f"Invalid transcript: {e}", "isEmpty": True})
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

    # ASR-C: named-entity correction on the transcript text BEFORE coref + LLM.
    # Runs first so coref binds pronouns to CANONICAL names (coref mis-binds on
    # un-canonicalized ASR — see eval-log). Deterministic, gated SINAIN_NEC.
    items = _nec_correct_items(items, args.memory_dir)

    # Stage A (discourse reconstruction): resolve coreference across turns
    # BEFORE the LLM sees the transcript, so pronouns become named entities
    # regardless of distiller-model strength. No-op unless SINAIN_COREF=1; safe
    # fallback to original items on any failure. See coreference.py.
    try:
        from coreference import resolve_items
        items = resolve_items(items)
    except Exception as e:
        print(f"[coref] import failed (non-fatal): {e}", file=sys.stderr)

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
        # Greedy + fixed seed → deterministic distillation: re-ingesting the same
        # haystack yields the SAME facts run-to-run. Previously omitted (provider
        # default temperature ~1.0), which made every re-distill sample different
        # facts — the real driver of LongMemEval run-to-run variance (e.g. "5K"
        # mis-distilled "55k" one run, a "$400,000" callback caught only some runs).
        # SINAIN_DISTILL_SEED overrides; SINAIN_DISTILL_TEMP loosens for ablation.
        _dtemp = float(os.environ.get("SINAIN_DISTILL_TEMP", "0.0"))
        _dseed = int(os.environ.get("SINAIN_DISTILL_SEED", "42"))
        raw = call_llm_with_fallback(
            SYSTEM_PROMPT,
            user_prompt,
            script="session_distiller",
            json_mode=True,
            json_schema=DIGEST_SCHEMA if use_schema else None,
            temperature=_dtemp,
            seed=_dseed,
            retries=int(os.environ.get("SINAIN_DISTILL_RETRIES", "4")),
        )
        result = extract_json(raw)
    except (ValueError, LLMError) as e:
        print(f"LLM distillation failed: {e}", file=sys.stderr)
        output_json({"error": str(e), "isEmpty": True})
        return

    # Robustness: the LLM sometimes emits a bare JSON ARRAY instead of the
    # digest object (e.g. just the facts list, or `[{...digest...}]`). Without
    # this coercion `result["ts"] = ...` raises TypeError and the whole batch's
    # facts are dropped — which silently tanks single-session questions whose
    # answer lives in exactly that batch. Salvage what we can instead of losing
    # the segment. See eval-log § "Distillation empty-batch retry".
    if isinstance(result, list):
        if len(result) == 1 and isinstance(result[0], dict):
            result = result[0]
        else:
            facts = [x for x in result if isinstance(x, (str, dict))]
            result = {"facts": facts, "isEmpty": not facts}
    elif not isinstance(result, dict):
        result = {"isEmpty": True}

    # Add metadata
    result["ts"] = meta.get("ts", "")
    result["sessionKey"] = meta.get("sessionKey", "")
    result["durationMs"] = meta.get("durationMs", 0)
    result["feedItemCount"] = len(items)

    output_json(result)


if __name__ == "__main__":
    main()
