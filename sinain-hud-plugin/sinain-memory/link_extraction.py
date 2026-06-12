#!/usr/bin/env python3
"""Zero-LLM typed-link extractor for sinain transcripts.

Adapted from gbrain/src/core/link-extraction.ts (Garry Tan's personal-AI
memory system). gbrain's mechanism: regex patterns over markdown wikilinks
emit deterministic typed edges (works_at / founded / invested_in / advises)
at write-time — LLM only fires in overnight dream cycle.

Sinain adaptation: transcripts have no markdown wikilink syntax, so we use
the distiller's entity list (name + altLabels) to build a lexicon, scan
transcript text for entity-pair co-occurrences within a window, and
classify the connecting prose with the same regex chain.

Predicate naming uses sinain's camelCase convention with an `auto:` prefix
to mark provenance:
    works_at      → auto:worksAt
    founded       → auto:founded
    invested_in   → auto:investedIn
    advises       → auto:advises

Edges with co-occurrence count ≥ 2 within a single batch are promoted;
singletons drop. Confidence is fixed at 0.6 (below the 1.0 default for
LLM-distilled facts so query ranking de-prioritizes them).

Usage (programmatic):
    from link_extraction import extract_auto_edges
    edges = extract_auto_edges(transcript, entities)
    # edges: [{subject_id, predicate, object_id, confidence, evidence, count}, ...]

Usage (CLI smoke test):
    python3 link_extraction.py --transcript '[{"text":"...","role":"audio"}]' \
        --entities '[{"id":"entity:jane","name":"Jane Smith"}]'
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Iterable


# ─── Regex patterns (verbatim port of gbrain TS) ────────────────────────────
#
# Each pattern fires on prose that asserts a specific relationship between
# two entities found in the same window. Patterns are tried in order and the
# first match wins; precedence reflects gbrain's tuning: founded > invested_in
# > advises > works_at. Investor patterns precede employee patterns because
# investors often "sit on the board at" or "advise" portfolio companies and
# a naive employee match would mis-classify those phrasings.

WORKS_AT_RE = re.compile(
    # gbrain patterns (written prose — bios, Crunchbase-style pages)
    r"\b(?:CEO of|CTO of|COO of|CFO of|CMO of|CRO of|VP at|VP of|VPs? Engineering|"
    r"VPs? Product|works at|worked at|working at|employed by|employed at|"
    r"joined as|joined the team|engineer at|engineer for|director at|director of|"
    r"head of|heads up .{0,20} at|leads engineering|leads product|"
    r"leads the .{0,20} (?:team|org) at|manages engineering at|"
    r"manages product at|running (?:engineering|product|design) at|"
    r"currently at|previously at|previously worked at|"
    r"spent .* (?:years|months) at|stint at|stint as|tenure at|tenure as|"
    r"role at|position at|"
    r"(?:senior|staff|principal|lead|backend|frontend|full-?stack|ML|data|security) "
    r"engineer at|"
    r"promoted to (?:senior|staff|principal|lead) .{0,20} at|"
    r"(?:his|her|their|my) time at|"
    # sinain conversational additions — informal verb forms common in
    # transcribed meeting audio (e.g., "he comes from Citibank"). Tuned
    # against acme-prep-5min on 2026-05-18.
    r"comes from|came from|coming from|came over from|"
    r"works for|worked for|working for|"
    r"is from .{0,15} (?:team|org|side|group|department)|"
    r"is at .{0,5}(?:Inc|Corp|Group|Ltd|company)?|"
    r"used to (?:work|be) (?:at|with|for)|used to run|used to lead|"
    r"over at|over there at|"
    r"(?:guy|gal|woman|man|person|individual|colleague) (?:from|at|with)|"
    r"his background (?:is|was) (?:at|with|from)|"
    r"her background (?:is|was) (?:at|with|from)|"
    r"their background (?:is|was) (?:at|with|from)|"
    r"background (?:is|was) (?:at|from)|"
    r"started (?:his|her|their) career at|started out at|"
    r"experience at|experience with|years at|"
    r"comes (?:to us|from)|"
    r"on (?:loan|secondment) (?:from|at))\b",
    re.IGNORECASE,
)

INVESTED_RE = re.compile(
    r"\b(?:invested in|invests in|investing in|invest in|investment in|"
    r"investments in|backed by|funding from|funded by|raised from|"
    r"led the (?:seed|Series|round|investment|round)|"
    r"led .{0,30}(?:Series [A-Z]|seed|round|investment)|"
    r"participated in (?:the )?(?:seed|Series|round)|"
    r"wrote (?:a |the )?check|first check|early investor|"
    r"portfolio (?:company|includes)|board seat (?:at|in|on)|"
    r"term sheet for)\b",
    re.IGNORECASE,
)

FOUNDED_RE = re.compile(
    r"\b(?:founded|co-?founded|started the company|incorporated|"
    r"founder of|founders? (?:include|are)|the founder|"
    r"is a co-?founder|is one of the founders)\b",
    re.IGNORECASE,
)

ADVISES_RE = re.compile(
    r"\b(?:advises|advised|advisor (?:to|at|for|of)|"
    r"advisory (?:board|role|position|capacity|engagement|partnership|"
    r"contract|relationship|work)|board advisor|"
    r"on .{0,20} advisory board|joined .{0,20} advisory board|"
    r"in an? advisory (?:capacity|role|position)|"
    r"as an? (?:advisor|security advisor|technical advisor|strategic advisor|"
    r"industry advisor|product advisor|board advisor|senior advisor)|"
    r"(?:strategic|technical|security|product|industry|senior|board) "
    r"advisor (?:to|at|for|of)|"
    r"consults for|consulting role (?:at|with))\b",
    re.IGNORECASE,
)

# Page-role priors from gbrain — used as fallback classifiers when no verb
# pattern fires but context suggests a specific relationship type.
PARTNER_ROLE_RE = re.compile(
    r"\b(?:partner at|partner of|venture partner|VC partner|invested early|"
    r"investor at|investor in|portfolio|venture capital|"
    r"early-stage investor|seed investor|fund [A-Z]|invests across|"
    r"backs companies)\b",
    re.IGNORECASE,
)

ADVISOR_ROLE_RE = re.compile(
    r"\b(?:full-time advisor|professional advisor|"
    r"advises (?:multiple|several|various)|"
    r"is an? (?:advisor|security advisor|technical advisor|strategic advisor|"
    r"industry advisor|product advisor|senior advisor)|"
    r"took on advisory roles|"
    r"(?:her|his|their) advisory (?:work|role|engagement|portfolio)|"
    r"serves as (?:an )?advisor)\b",
    re.IGNORECASE,
)

EMPLOYEE_ROLE_RE = re.compile(
    r"\b(?:is an? (?:senior|staff|principal|lead|backend|frontend|full-?stack|"
    r"ML|data|security|DevOps|platform)? ?engineer at|"
    r"is an? (?:senior|staff|principal|lead)? ?"
    r"(?:developer|designer|product manager|engineering manager|director|VP) "
    r"(?:at|of)|"
    r"holds? the (?:CTO|CEO|CFO|COO|CMO|CRO|VP) (?:role|position|seat|title) at|"
    r"is the (?:CTO|CEO|CFO|COO|CMO|CRO) of|"
    r"employee at|on the team at|works on .{0,30} at)\b",
    re.IGNORECASE,
)

# Sinain predicate naming: gbrain's snake_case → sinain's camelCase, with
# `auto:` prefix to flag origin. Query layers can filter on `auto:` to
# de-prioritize auto-extracted edges vs LLM-distilled facts.
_PREDICATE_MAP = {
    "founded": "auto:founded",
    "invested_in": "auto:investedIn",
    "advises": "auto:advises",
    "works_at": "auto:worksAt",
}

# Co-occurrence search window. gbrain's value is implicit (uses chunk
# boundaries); we use a char-window because sinain transcripts are
# unstructured streams.
#
# 120 chars was tuned for written prose where mentions cluster tightly.
# Conversational transcripts have mentions spread across multiple short
# audio items (e.g., acme-prep-5min: "Mustafa" in one item, then 30-60s
# later "He comes from the Citibank" in another — separated by 300-500 chars
# of intervening speech). 600 chars covers typical conversational spread
# without inviting cross-topic noise. Tunable per call.
DEFAULT_WINDOW_CHARS = 600

# Promotion threshold per HANDOFF.json design decision. Singletons are
# usually noise; ≥ 2 occurrences in the same batch suggest the connection
# is real, not a passing reference.
DEFAULT_PROMOTION_THRESHOLD = 2

# Type-aware filter — semantic priors that recover the subject/object
# directionality gbrain gets for free from markdown wikilink syntax.
# Without this, prose extraction emits Acme→founded→Bob alongside the
# correct Bob→founded→Acme because regex matches inside a co-occurrence
# window without knowing which entity is the subject.
#
# Constraints reflect real-world semantics:
#   - Only Person can work-at / found / advise an Organization
#   - Investments allow Person→Org (angels) AND Org→Org (VC firms → startups)
#
# Strict-by-default: an edge is dropped if either type is missing or the
# (subject_type, object_type) pair isn't in the predicate's allowed set.
# Stage 2 distiller guarantees types on every entity; cache-invalidation
# salt forces re-distill of legacy caches, so strict-default is forward-safe.
_TYPE_CONSTRAINTS: dict[str, set[tuple[str, str]]] = {
    "auto:worksAt":    {("Person", "Organization")},
    "auto:founded":    {("Person", "Organization")},
    "auto:advises":    {("Person", "Organization")},
    "auto:investedIn": {("Person", "Organization"), ("Organization", "Organization")},
}


def _normalize_type(t: str | None) -> str:
    """Drop the schema.org prefix for pair-matching against _TYPE_CONSTRAINTS.

    Distiller emits types like `schema:Person`; constraints use bare
    `Person` so the table stays readable. Returns empty string on missing
    or non-string input — caller treats empty as a strict-mode drop.
    """
    if not isinstance(t, str):
        return ""
    return t.removeprefix("schema:")


def infer_link_type(context: str) -> str | None:
    """Classify a window of prose by which relation it asserts.

    Verb patterns checked in gbrain's documented precedence: founded first
    (catches "Jane founded Acme"), then invested_in / advises / works_at.
    Falls back to role priors which are weaker but catch noun-phrase forms
    like "advisor to Acme" without a leading verb.

    Returns the sinain-namespaced predicate (e.g., `auto:founded`) or
    `None` if no pattern fires — caller drops `None` results to avoid
    polluting the graph with generic `mentions` edges.
    """
    if FOUNDED_RE.search(context):
        return _PREDICATE_MAP["founded"]
    if INVESTED_RE.search(context):
        return _PREDICATE_MAP["invested_in"]
    if ADVISES_RE.search(context):
        return _PREDICATE_MAP["advises"]
    if WORKS_AT_RE.search(context):
        return _PREDICATE_MAP["works_at"]
    # Role priors — weaker; only used when no verb pattern matched.
    if PARTNER_ROLE_RE.search(context):
        return _PREDICATE_MAP["invested_in"]
    if ADVISOR_ROLE_RE.search(context):
        return _PREDICATE_MAP["advises"]
    if EMPLOYEE_ROLE_RE.search(context):
        return _PREDICATE_MAP["works_at"]
    return None


def _build_mention_index(
    entities: list[dict],
) -> list[tuple[str, str]]:
    """Build a (search_token, entity_id) list from distiller entities.

    Each entity contributes its `name` plus any `altLabels`. Tokens are
    lowercased once here so the scan can do case-insensitive matching
    without per-call .lower() overhead.

    Tokens shorter than 3 chars are dropped (avoid false hits on stop-word-
    length names that would explode the co-occurrence space).
    """
    pairs: list[tuple[str, str]] = []
    for ent in entities:
        if not isinstance(ent, dict):
            continue
        eid = ent.get("id")
        if not eid:
            continue
        # Normalize to full entity_id form expected by the triplestore.
        if not eid.startswith("entity:"):
            eid = f"entity:{eid}"
        for label in [ent.get("name"), *(ent.get("altLabels") or [])]:
            if not isinstance(label, str):
                continue
            token = label.strip().lower()
            if len(token) < 3:
                continue
            pairs.append((token, eid))
    return pairs


def _find_mentions(text: str, index: list[tuple[str, str]]) -> list[tuple[int, str]]:
    """Locate every entity-label occurrence in text, return (pos, entity_id).

    Uses word-boundary regex per token. Same entity can match via multiple
    altLabels — that's fine; we keep all positions for window-pair sweeps.
    Sort ascending by position so the outer-loop sweep can break out as soon
    as the inner pointer passes the window edge.
    """
    mentions: list[tuple[int, str]] = []
    for token, eid in index:
        # re.escape handles entity names containing special regex chars
        pattern = re.compile(r"\b" + re.escape(token) + r"\b", re.IGNORECASE)
        for m in pattern.finditer(text):
            mentions.append((m.start(), eid))
    mentions.sort(key=lambda x: x[0])
    return mentions


def _flatten_transcript(transcript: Iterable[dict]) -> str:
    """Concatenate transcript items into a single text blob for regex scan.

    Items joined with "  " (two spaces) so word boundaries hold across the
    boundary — a name at the end of one item won't bleed into the next item's
    first word and cause a spurious match.
    """
    parts: list[str] = []
    for item in transcript:
        if not isinstance(item, dict):
            continue
        text = item.get("text") or ""
        if isinstance(text, str) and text.strip():
            parts.append(text)
    return "  ".join(parts)


def extract_auto_edges(
    transcript: list[dict],
    entities: list[dict],
    *,
    window_chars: int = DEFAULT_WINDOW_CHARS,
    promotion_threshold: int = DEFAULT_PROMOTION_THRESHOLD,
    confidence: float = 0.6,
) -> list[dict]:
    """Extract typed (subj, predicate, obj) edges from co-occurrences.

    Workflow:
      1. Concat transcript items into one text blob.
      2. Build a (name|altLabel → entity_id) index from distiller entities.
      3. Find every entity mention position in the text.
      4. Sweep ordered pairs within `window_chars`; for each pair, slice
         the connecting context and classify via inferLinkType chain.
      5. Count occurrences per directed (subj, pred, obj) key. Drop pairs
         below `promotion_threshold`.
      6. Emit one edge dict per promoted key with the first-seen evidence
         excerpt.

    Same-entity pairs (subj == obj) are skipped — auto-edges to oneself
    would be noise (e.g., "Jane works at Jane's company" mentions Jane
    twice but the edge target is the company, not Jane).

    Returns a list of dicts ready for direct triplestore writes:
        {subject_id, predicate, object_id, confidence, evidence, count}
    """
    if not transcript or not entities:
        return []

    text = _flatten_transcript(transcript)
    if not text:
        return []

    index = _build_mention_index(entities)
    if not index:
        return []

    # Build (entity_id → normalized_type) lookup for the post-classification
    # type filter. Stage 2 distiller guarantees types; missing/unknown types
    # cause the edge to be dropped under strict-default semantics.
    entity_types: dict[str, str] = {}
    for ent in entities:
        if not isinstance(ent, dict):
            continue
        eid = ent.get("id")
        if not eid:
            continue
        if not eid.startswith("entity:"):
            eid = f"entity:{eid}"
        entity_types[eid] = _normalize_type(ent.get("type"))

    mentions = _find_mentions(text, index)
    if len(mentions) < 2:
        return []

    # Entity-id → display name for the readable value text on provenance nodes.
    # FTS5 indexes the value column; using human names instead of slugs means
    # natural-language queries ("How long has the CTO been at Citibank?") can
    # match the auto: provenance node via the same path as LLM-distilled facts.
    entity_names: dict[str, str] = {}
    for ent in entities:
        if not isinstance(ent, dict):
            continue
        eid = ent.get("id")
        if not eid:
            continue
        if not eid.startswith("entity:"):
            eid = f"entity:{eid}"
        entity_names[eid] = ent.get("name") or eid.split(":", 1)[1]

    pair_counts: dict[tuple[str, str, str], int] = {}
    pair_evidence: dict[tuple[str, str, str], str] = {}

    for i, (pos_a, ent_a) in enumerate(mentions):
        for j in range(i + 1, len(mentions)):
            pos_b, ent_b = mentions[j]
            if pos_b - pos_a > window_chars:
                break
            if ent_a == ent_b:
                continue
            # Include a small left-pad so verbs preceding the first mention
            # (e.g., "founded by Jane and John") are visible to the regex.
            ctx = text[max(0, pos_a - 20):min(len(text), pos_b + 50)]
            predicate = infer_link_type(ctx)
            if predicate is None:
                continue
            # Type-aware filter — eliminates directional spurious edges by
            # checking the (subject_type, object_type) pair against the
            # predicate's allowed combos. Stage 2 distiller guarantees types;
            # we strict-deny on missing type to keep the bench number clean.
            subj_t = entity_types.get(ent_a, "")
            obj_t = entity_types.get(ent_b, "")
            allowed = _TYPE_CONSTRAINTS.get(predicate, set())
            if (subj_t, obj_t) not in allowed:
                continue
            key = (ent_a, predicate, ent_b)
            pair_counts[key] = pair_counts.get(key, 0) + 1
            if key not in pair_evidence:
                pair_evidence[key] = ctx

    edges: list[dict] = []
    for (subj, predicate, obj), count in pair_counts.items():
        if count < promotion_threshold:
            continue
        edges.append({
            "subject_id": subj,
            "predicate": predicate,
            "object_id": obj,
            "confidence": confidence,
            "evidence": pair_evidence[(subj, predicate, obj)],
            "count": count,
            "subject_name": entity_names.get(subj, subj.split(":", 1)[-1]),
            "object_name": entity_names.get(obj, obj.split(":", 1)[-1]),
        })
    return edges


# Map sinain predicate slugs back to human-readable verb phrases for the
# value text of the provenance fact node. FTS5 indexes the value column,
# so storing "Mustafa works at Citibank" makes the node retrievable by
# natural-language queries that contain "Mustafa", "Citibank", or "works at".
PREDICATE_READABLE: dict[str, str] = {
    "auto:worksAt":    "works at",
    "auto:founded":    "founded",
    "auto:advises":    "advises",
    "auto:investedIn": "invested in",
}


def edge_readable_value(edge: dict) -> str:
    """Render an auto-edge as a natural-language sentence for FTS indexing.

    Example: ('entity:mustafa', 'auto:worksAt', 'entity:citibank') →
        "Mustafa works at Citibank"

    Falls back to slug names + raw predicate when name/predicate isn't in
    the known map — the goal is FTS-matchable text, even if slightly clunky.
    """
    subj = edge.get("subject_name") or edge.get("subject_id", "").split(":", 1)[-1]
    obj = edge.get("object_name") or edge.get("object_id", "").split(":", 1)[-1]
    pred_readable = PREDICATE_READABLE.get(edge.get("predicate", ""), edge.get("predicate", "").split(":")[-1])
    return f"{subj} {pred_readable} {obj}"


# ─── User-attribute extractor (extension of gbrain Proposal A) ───────────────
#
# extract_auto_edges (above) catches entity×entity relationships (worksAt,
# founded, ...) — acme's failure mode where LLM distillers miss
# "Mustafa was at Citibank for 17 years" type claims.
#
# This second extractor catches a different LLM-distiller failure mode:
# first-person user-attribute claims that get summarized away because they
# appear adjacent to richer content. LongMemEval q1 e47becba example —
# session contains "I graduated with my BA in business administration" but
# in the same session the user also discusses entrepreneurship podcasts;
# weak distillers (phi4-mini, qwen2.5:7b) extract the entrepreneurship
# discussion and drop the degree claim.
#
# These are deterministic substring regex patterns over the raw transcript
# text. They don't require entity detection — the subject is always the
# user (entity:user). Emitted facts go through the integrator's standard
# assert pipeline at confidence=0.85 (below LLM-distilled 0.9, above any
# auto:edge default 0.6) so they participate in retrieval without
# dominating LLM-distilled facts when both are present.

USER_DEGREE_RE = re.compile(
    # Anchored on first-person + completion-verb + degree-token.
    # Field captured greedily but bounded — degree fields are usually 1-4 words.
    r"\b(?:I|i)\s+(?:have|hold|got|earned|completed|received|finished|graduated\s+(?:with|from)|"
    r"studied|majored\s+in|got\s+my)\s+"
    r"(?:a\s+|an\s+|my\s+|the\s+)?"
    r"(?:(?P<level>bachelor'?s?|master'?s?|PhD|doctorate|BSc|BS|BA|MSc|MS|MA|MBA|"
    r"undergraduate|graduate|degree|diploma|certificate)"
    r"(?:'?s)?(?:\s+(?:degree|of))?\s*(?:in\s+)?)?"
    r"(?P<field>(?:[A-Z][a-zA-Z]+(?:\s+(?:and\s+)?[A-Z][a-zA-Z]+){0,3})|"
    r"(?:[a-z]+(?:\s+[a-z]+){0,3}\s+(?:engineering|science|studies|literature|administration|"
    r"economics|mathematics|biology|chemistry|physics|history|psychology|philosophy|"
    r"engineering|medicine|nursing|education|business|finance|marketing|design|art)))",
    re.IGNORECASE | re.MULTILINE,
)

USER_OCCUPATION_RE = re.compile(
    # "I work as a X" / "I'm a X" / "I'm working as Y"
    r"\b(?:I'?m|I\s+am|I\s+work|I\s+worked|I\s+am\s+working)\s+"
    r"(?:as\s+|at\s+)?(?:a\s+|an\s+)?"
    r"(?P<role>[A-Za-z][\w-]+(?:\s+[A-Za-z][\w-]+){0,3})\s+"
    r"(?P<termin>at\s+\w|\.|,|;|$)",
    re.IGNORECASE | re.MULTILINE,
)

USER_LOCATION_RE = re.compile(
    # "I live in X" / "I'm based in Y" / "I'm from Z"
    r"\b(?:I\s+(?:live|lived|reside|am\s+based|grew\s+up)|I'?m\s+(?:from|based|living))\s+(?:in\s+)?"
    r"(?P<place>[A-Z][a-zA-Z]+(?:[,\s]+[A-Z][a-zA-Z]+){0,2})",
    re.MULTILINE,
)

USER_DURATION_RE = re.compile(
    # "my commute is 45 minutes" / "my commute takes 45 minutes each way"
    # Captures personal-attribute durations — anchored on "my <noun>" possessive.
    r"\b(?:my|My)\s+(?P<attr>\w+)\s+(?:is|takes|lasts|runs|usually\s+takes|typically\s+is)\s+"
    r"(?:about\s+|around\s+|roughly\s+|approximately\s+)?"
    r"(?P<value>\d+(?:\.\d+)?\s*(?:minute|hour|day|week|month|year|km|kilometer|mile)s?"
    r"(?:\s+(?:each\s+way|one\s+way|round\s+trip|per\s+\w+))?)",
    re.MULTILINE,
)

USER_NAME_RE = re.compile(
    r"\bmy\s+name\s+is\s+(?P<name>[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})",
    re.IGNORECASE | re.MULTILINE,
)

USER_AGE_RE = re.compile(
    r"\b(?:I'?m|I\s+am)\s+(?P<age>\d{1,3})\s+(?:years\s+old|year-?old)",
    re.IGNORECASE | re.MULTILINE,
)

USER_RELATION_RE = re.compile(
    # "my sister/brother/wife/husband/partner/child/dog/cat is X"
    r"\bmy\s+(?P<relation>sister|brother|wife|husband|partner|son|daughter|child|"
    r"father|mother|dad|mom|grandfather|grandmother|grandpa|grandma|"
    r"dog|cat|pet|friend|colleague|coworker|boss|roommate)"
    r"(?:'s\s+name)?\s+(?:is|was|named)\s+"
    r"(?P<name>[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})",
    re.IGNORECASE | re.MULTILINE,
)


def extract_user_attributes(transcript: list[dict] | str) -> list[dict]:
    """Extract first-person user-attribute claims from a transcript.

    Sibling to extract_auto_edges: where that function captures pairs of
    entities mentioned in close proximity, this one captures self-claims
    the LLM distiller may have dropped because they were adjacent to
    richer content.

    Emits one fact dict per pattern hit. Schema mirrors the distiller
    digest's facts entries so the integrator can splice them in unchanged:
        {entity: "user", attribute, value, confidence, kind, source}
    """
    if isinstance(transcript, list):
        text = _flatten_transcript(transcript)
    else:
        text = transcript
    if not text or not text.strip():
        return []

    facts: list[dict] = []
    seen: set[tuple[str, str]] = set()

    def _add(attribute: str, value: str, evidence: str) -> None:
        v = value.strip().rstrip(".,;:")
        if not v or len(v) > 200:
            return
        key = (attribute.lower(), v.lower())
        if key in seen:
            return
        seen.add(key)
        facts.append({
            "entity": "user",
            "attribute": attribute,
            "value": v,
            "confidence": 0.85,
            "kind": "auto-extracted",
            "evidence": evidence[:140],
        })

    for m in USER_DEGREE_RE.finditer(text):
        level = (m.group("level") or "").strip()
        field = (m.group("field") or "").strip()
        if not field:
            continue
        value = f"{level} in {field}".strip() if level else field
        _add("degree", value, text[max(0, m.start() - 30):m.end() + 30])

    for m in USER_OCCUPATION_RE.finditer(text):
        role = (m.group("role") or "").strip()
        if not role or len(role) < 3:
            continue
        # Filter out generic verbs/auxiliaries that the loose pattern catches.
        if role.lower() in {"working", "currently", "happy", "still", "looking", "trying", "going"}:
            continue
        _add("occupation", role, text[max(0, m.start() - 20):m.end() + 20])

    for m in USER_LOCATION_RE.finditer(text):
        place = (m.group("place") or "").strip()
        if not place or len(place) < 2:
            continue
        _add("location", place, text[max(0, m.start() - 20):m.end() + 20])

    for m in USER_DURATION_RE.finditer(text):
        attr = (m.group("attr") or "").strip().lower()
        value = (m.group("value") or "").strip()
        if not attr or not value:
            continue
        _add(attr, value, text[max(0, m.start() - 20):m.end() + 20])

    for m in USER_NAME_RE.finditer(text):
        name = (m.group("name") or "").strip()
        if not name:
            continue
        _add("name", name, text[max(0, m.start() - 20):m.end() + 20])

    for m in USER_AGE_RE.finditer(text):
        age = (m.group("age") or "").strip()
        if not age:
            continue
        _add("age", f"{age} years old", text[max(0, m.start() - 20):m.end() + 20])

    for m in USER_RELATION_RE.finditer(text):
        relation = (m.group("relation") or "").strip().lower()
        name = (m.group("name") or "").strip()
        if not relation or not name:
            continue
        _add(relation, name, text[max(0, m.start() - 20):m.end() + 20])

    return facts


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Zero-LLM typed-link extractor (smoke test CLI)"
    )
    parser.add_argument("--transcript", required=True, help="JSON list of {role,text,ts?} items")
    parser.add_argument("--entities", default="[]", help="JSON list of {id,name,altLabels?} items")
    parser.add_argument("--window-chars", type=int, default=DEFAULT_WINDOW_CHARS)
    parser.add_argument("--threshold", type=int, default=DEFAULT_PROMOTION_THRESHOLD)
    parser.add_argument("--user-attrs", action="store_true",
                        help="Run extract_user_attributes instead of extract_auto_edges")
    args = parser.parse_args()

    transcript = json.loads(args.transcript)
    if args.user_attrs:
        facts = extract_user_attributes(transcript)
        json.dump(facts, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
        return

    entities = json.loads(args.entities)
    edges = extract_auto_edges(
        transcript, entities,
        window_chars=args.window_chars,
        promotion_threshold=args.threshold,
    )
    json.dump(edges, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
