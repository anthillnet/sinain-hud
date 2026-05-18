#!/usr/bin/env python3
"""Knowledge Integrator — update playbook + knowledge graph from a SessionDigest.

Takes a session digest (from session_distiller.py), the current playbook, and
the knowledge graph, then produces:
1. Updated playbook (working memory)
2. Graph operations (long-term memory: assert/reinforce/retract facts)

Single LLM call, ~15s. Replaces: playbook_curator + feedback_analyzer +
triple_extractor + triple_ingest.

Usage:
    python3 knowledge_integrator.py --memory-dir memory/ \
        --digest '{"whatHappened":"...","patterns":[...]}' \
        [--bootstrap]  # one-time: seed graph from current playbook
"""

import argparse
import hashlib
import json
import re
import shutil
import sys
import unicodedata
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

from common import (
    LLMError,
    call_llm_with_fallback,
    extract_json,
    output_json,
    read_playbook,
)

SYSTEM_PROMPT = """\
You are a knowledge integrator for a personal AI overlay system (sinain).
You maintain TWO knowledge stores:

1. PLAYBOOK (working memory, ~50 lines): actively curated patterns, anti-patterns,
   and preferences. Injected into every agent prompt. Must be concise and current.

2. KNOWLEDGE GRAPH (long-term memory): durable facts that survive playbook pruning.
   Stored as entity-attribute-value triples. Facts can be reinforced (seen again),
   retracted (contradicted or outdated), or newly asserted.

Given a session digest (what happened), the current playbook, and existing graph facts:

FOR THE PLAYBOOK:
- ADD patterns from the digest that are novel (not already in playbook)
- REINFORCE existing patterns that the session confirms (increment "seen" count)
- PRUNE patterns contradicted by session evidence
- PROMOTE frequently-reinforced patterns (seen 3+) to "established"
- Keep under 50 lines. Density over completeness.
- DO NOT modify header/footer comments (<!-- mining-index ... --> and <!-- effectiveness ... -->)
- Three Laws: (1) don't remove error-prevention patterns, (2) preserve high-scoring approaches, (3) then evolve

FOR THE KNOWLEDGE GRAPH:
- ASSERT every concrete fact from the digest: factual claims, decisions, relationships, numbers
- REINFORCE existing facts confirmed by the session (list their entity_ids)
- RETRACT facts contradicted by session evidence (list their entity_ids)
- Each fact needs: entity (real name from content), attribute (relationship type), value (self-contained sentence), confidence (0.0-1.0), domain (for scoping)
- Entity naming: use actual names as lowercase-hyphenated slugs
    Good: "citibank", "al-futaim-group", "artom", "intellij-idea"
    Bad: "ai-solutions", "client-understanding", "tool-usage"
- The value field must be a complete, self-contained sentence that answers a question on its own
- Assert BOTH durable facts AND time-bound decisions/action items (mark decisions with confidence 0.7)

If the session was empty/idle, return minimal changes.

Respond with ONLY a JSON object. IMPORTANT: put graphOps FIRST (before playbook) — \
graphOps are the most valuable output and must not be truncated.
{
  "graphOps": [
    {"op": "assert", "entity": "entity-slug", "attribute": "attr-name", "value": "fact text", "confidence": 0.8, "domain": "domain-name"},
    {"op": "reinforce", "entityId": "fact:existing-slug"},
    {"op": "retract", "entityId": "fact:existing-slug", "reason": "why"}
  ],
  "changes": {
    "added": ["pattern text", ...],
    "pruned": ["pattern text", ...],
    "promoted": ["pattern text", ...],
    "reinforced": ["pattern text", ...]
  },
  "updatedPlaybook": "full playbook body text (between header and footer comments)"
}"""


_STOPWORDS = frozenset({
    "the", "and", "for", "when", "with", "that", "this", "from", "into",
    "after", "before", "during", "should", "would", "could", "been", "have",
    "will", "also", "then", "than", "not", "but", "are", "was", "were",
    "can", "may", "use", "run", "set", "get", "try", "all", "any", "new",
    "score", "seen",
})


def _log_integrator_failure(memory_dir: str, digest: dict, errors: list[str]) -> None:
    """Stage 2: structured logging of Pydantic validation failures.

    Lenient mode never raises, but it can return ok=False if the digest is so
    malformed that even the salvage-by-dropping-bad-facts path fails. Surface
    those cases to integrator-failures.jsonl so they're investigable.
    Mirror of the distiller-failures.jsonl pattern.
    """
    try:
        record = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "errors": errors,
            "digest_keys": sorted(digest.keys()) if isinstance(digest, dict) else None,
            "fact_count": len(digest.get("facts", [])) if isinstance(digest, dict) else 0,
            "entity_count": len(digest.get("entities", [])) if isinstance(digest, dict) else 0,
            "session_ts": digest.get("ts", "") if isinstance(digest, dict) else "",
            "digest_hash": hashlib.sha256(
                json.dumps(digest, sort_keys=True, default=str).encode("utf-8")
            ).hexdigest()[:16],
        }
        log_path = Path(memory_dir) / "integrator-failures.jsonl"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a") as f:
            f.write(json.dumps(record) + "\n")
    except Exception:
        pass


def _extract_tags(value: str) -> list[str]:
    """Extract searchable keyword tags from fact value text.

    Returns up to 10 deduplicated lowercase tags suitable for AVET-indexed lookup.
    """
    # Lowercase words (including hyphenated compounds like "react-native")
    words = re.findall(r"[a-z][a-z0-9-]+", value.lower())
    tags = [w for w in words if len(w) > 2 and w not in _STOPWORDS]
    # Detect compound terms from CamelCase or "Title Case" patterns
    compounds = re.findall(r"[A-Z][a-z]+ [A-Z][a-z]+", value)
    for c in compounds:
        tags.append(c.lower().replace(" ", "-"))
    # Numeric tokens that look meaningful (error codes, port numbers)
    nums = re.findall(r"\b\d{3,5}\b", value)
    tags.extend(nums)
    # Deduplicate preserving order, cap at 10
    return list(dict.fromkeys(tags))[:10]


def _fact_id(entity: str, attribute: str, value: str) -> str:
    """Generate a deterministic fact entity ID from entity+attribute+value."""
    content = f"{entity}:{attribute}:{value}"
    h = hashlib.sha256(content.encode()).hexdigest()[:12]
    slug = entity.replace(" ", "-").lower()[:30]
    return f"fact:{slug}-{h}"


_UNICODE_PRE_MAP = str.maketrans({"ß": "ss", "ẞ": "SS"})


def _normalize_entity(name: str) -> str:
    """Normalize entity name to canonical form: lowercase, hyphenated, ASCII-transliterated."""
    s = name.translate(_UNICODE_PRE_MAP)
    s = unicodedata.normalize("NFKD", s)
    s = s.encode("ascii", "ignore").decode("ascii")
    s = s.lower().replace(" ", "-").replace("_", "-")
    s = re.sub(r"[^a-z0-9-]", "", s)
    s = re.sub(r"-{2,}", "-", s)
    return s.strip("-")


def _find_matching_entity(
    name: str,
    existing_names: dict[str, str],
) -> str | None:
    """Find an existing entity that fuzzy-matches `name`. Returns entity_node_id or None."""
    if name in existing_names:
        return existing_names[name]

    # Hyphen-insensitive exact match (chatgpt == chat-gpt)
    name_compact = name.replace("-", "")
    for existing_name, node_id in existing_names.items():
        if existing_name.replace("-", "") == name_compact:
            return node_id

    # Edit-distance fuzzy match
    if len(name) < 3:
        return None
    threshold = 0.90
    best_match = None
    best_ratio = threshold
    for existing_name, node_id in existing_names.items():
        if len(existing_name) < 3:
            continue
        if frozenset({name, existing_name}) in _DEDUP_SKIP_PAIRS:
            continue
        ratio = SequenceMatcher(None, name, existing_name).ratio()
        if ratio >= best_ratio:
            best_ratio = ratio
            best_match = node_id
    return best_match


def _canonicalize_ops(ops: list[dict], existing_entities: list[str], existing_facts: list[dict]) -> list[dict]:
    """Deduplicate graph ops via embedding similarity (Mem0 pattern).

    For each new assertion, check if a semantically equivalent fact already exists
    using cosine similarity (threshold 0.78). If so, reinforce instead of asserting.
    Falls back to exact hash matching if embedding service is unavailable.
    """
    existing_id_set = set(existing_entities)

    # Build text→entity_id map for existing facts (for embedding-based dedup)
    existing_texts: list[str] = []
    existing_ids: list[str] = []
    for f in existing_facts:
        val = f.get("value", "")
        eid = f.get("entityId", f.get("entity_id", ""))
        if val and eid:
            existing_texts.append(val)
            existing_ids.append(eid)

    # Separate assert ops for batch dedup
    assert_ops = [(i, op) for i, op in enumerate(ops) if op.get("op") == "assert"]
    non_assert_ops = [(i, op) for i, op in enumerate(ops) if op.get("op") != "assert"]

    # Batch embedding dedup: single HTTP call for all new facts
    dedup_map: dict[int, int] = {}  # assert_index → existing_index
    if assert_ops and existing_texts:
        try:
            from embed_client import find_duplicates_batch
            new_values = [op.get("value", "") for _, op in assert_ops]
            dedup_map = find_duplicates_batch(new_values, existing_texts)
            if dedup_map:
                print(f"  [dedup] found {len(dedup_map)} semantic duplicates in batch", file=sys.stderr)
        except Exception:
            pass  # embedding unavailable, fall through to exact matching

    result = []
    seen_fact_ids: set[str] = set()
    seen_values_set: set[str] = set()

    # Re-merge in original order
    all_indexed = non_assert_ops + assert_ops
    all_indexed.sort(key=lambda x: x[0])

    for orig_idx, op in all_indexed:
        if op.get("op") != "assert":
            result.append(op)
            continue

        entity = op.get("entity", "")
        attribute = op.get("attribute", "")
        value = op.get("value", "")
        fact_id = _fact_id(entity, attribute, value)

        # Exact hash match
        if fact_id in existing_id_set or fact_id in seen_fact_ids:
            if fact_id in existing_id_set:
                result.append({"op": "reinforce", "entityId": fact_id})
                print(f"  [dedup] exact → reinforce '{fact_id}'", file=sys.stderr)
            continue

        # Check batch embedding dedup results
        assert_idx = [i for i, (oi, _) in enumerate(assert_ops) if oi == orig_idx]
        if assert_idx and assert_idx[0] in dedup_map:
            dup_existing_idx = dedup_map[assert_idx[0]]
            result.append({"op": "reinforce", "entityId": existing_ids[dup_existing_idx]})
            print(f"  [dedup] semantic → reinforce '{existing_ids[dup_existing_idx]}'", file=sys.stderr)
            continue

        # Intra-batch dedup (by value text)
        if value in seen_values_set:
            continue

        result.append(op)
        seen_fact_ids.add(fact_id)
        seen_values_set.add(value)

    return result


def _load_graph_facts(db_path: str, entities: list[str] | None = None, limit: int = 50) -> list[dict]:
    """Load relevant facts from the knowledge graph for LLM context."""
    if not Path(db_path).exists():
        return []

    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)

        # Get all non-retracted fact entities with their attributes
        if entities:
            # Tag-based search: find facts whose tags match any of the keywords
            # Normalize keywords to lowercase for tag matching
            # Handle both old-style string entities and new-style dict entities
            keywords = []
            for e in entities:
                if isinstance(e, dict):
                    keywords.append(e.get("name", "").lower().replace(" ", "-"))
                else:
                    keywords.append(str(e).lower().replace(" ", "-"))
            keywords = [k for k in keywords if k]
            placeholders = ",".join(["?" for _ in keywords])
            rows = store._conn.execute(
                f"""SELECT entity_id, COUNT(*) as matches
                    FROM triples
                    WHERE attribute = 'tag' AND NOT retracted
                    AND value IN ({placeholders})
                    GROUP BY entity_id
                    ORDER BY matches DESC
                    LIMIT ?""",
                (*keywords, limit),
            ).fetchall()
            fact_ids = [r["entity_id"] for r in rows]
        else:
            # Top-N by confidence
            rows = store._conn.execute(
                """SELECT entity_id, CAST(value AS REAL) as conf
                   FROM triples
                   WHERE attribute = 'confidence' AND NOT retracted
                   AND entity_id LIKE 'fact:%'
                   ORDER BY conf DESC
                   LIMIT ?""",
                (limit,),
            ).fetchall()
            fact_ids = [r["entity_id"] for r in rows]

        facts = []
        for fid in fact_ids:
            attrs = store.entity(fid)
            if attrs:
                fact = {"entityId": fid}
                for attr_name, values in attrs.items():
                    fact[attr_name] = values[0] if len(values) == 1 else values
                facts.append(fact)

        store.close()
        return facts
    except Exception as e:
        print(f"[warn] Failed to load graph facts: {e}", file=sys.stderr)
        return []


_CONSOLIDATION_PROMPT = """\
You are reviewing multiple stored facts about the same entity to detect \
redundancy, contradiction, and state evolution.

You will receive:
- The entity name
- A numbered list of facts currently stored about it

Your job: produce ONE integrated narrative fact that captures the entity's \
current truth, then identify which original facts should be retracted.

Rules:
- The narrative MUST be a single self-contained sentence.
- If facts contradict each other in a way that reflects state change over time \
("was X, then became Y"), the narrative MUST preserve that evolution explicitly \
("Used to X; now Y" or "X from 2020 to 2023, then Y").
- If facts are simply redundant (same claim worded differently), pick the most \
informative wording.
- If a fact is clearly outdated, retract it. If two facts contradict and only one \
is still true, retract the outdated one.
- Set narrativeOccurredStart only if a clear earliest temporal anchor exists.
- Set narrativeOccurredEnd only if the integrated fact is bounded (rare — most \
current-state narratives have no end).
- retractIds MUST be a subset of the input fact indices (0-based).

Respond with ONLY JSON:
{
  "narrative": "single-sentence integrated fact",
  "narrativeOccurredStart": "YYYY-MM-DD or null",
  "narrativeOccurredEnd": "YYYY-MM-DD or null",
  "retractIndices": [0, 2, 3]
}"""


def _llm_consolidate(entity_name: str, facts: list[tuple[str, str]]) -> dict | None:
    """Ask the LLM to produce an integrated narrative + retraction plan.

    Returns parsed JSON or None on failure. Caller must handle None by leaving
    facts as-is — consolidation is best-effort, never destructive on error.
    """
    numbered = "\n".join(f"{i}. {val}" for i, (_, val) in enumerate(facts))
    user_prompt = f"Entity: {entity_name}\n\nFacts:\n{numbered}"
    try:
        raw = call_llm_with_fallback(
            _CONSOLIDATION_PROMPT,
            user_prompt,
            script="consolidation",
            json_mode=True,
        )
        return extract_json(raw)
    except (ValueError, LLMError) as e:
        print(f"  [consolidate] LLM failed for {entity_name}: {e}", file=sys.stderr)
        return None


def _consolidate_entity_facts(db_path: str, min_facts: int = 3, use_llm: bool = True) -> int:
    """LLM-judged contradiction-aware consolidation.

    For each entity with at least `min_facts` stored facts, an LLM classifies
    the set as redundant / contradictory / state-evolution / independent and
    produces a single narrative fact that integrates the current truth.
    Outdated or redundant originals are retracted (soft, via valid_to).

    With use_llm=False, the function is a no-op — useful for tests that don't
    want to incur LLM cost. The legacy "; "-join consolidation has been removed
    because it conflated state-change with redundancy and silently flattened
    temporal evolution.

    Args:
        db_path: path to the knowledge graph DB
        min_facts: minimum fact count to consider for consolidation (default 3)
        use_llm: when False, returns 0 without making LLM calls

    Returns:
        Number of entities consolidated.
    """
    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)

        # Group facts by entity name
        entity_facts: dict[str, list[tuple[str, str]]] = {}  # entity → [(fact_id, value)]
        for r in store.entities_with_attr("entity"):
            fact_id, entity_name = r[0], r[1]
            if not fact_id.startswith("fact:") or isinstance(entity_name, list):
                continue
            attrs = store.entity(fact_id)
            if attrs and "value" in attrs:
                val = attrs["value"][0] if isinstance(attrs["value"], list) else str(attrs["value"])
                entity_facts.setdefault(entity_name, []).append((fact_id, val))

        consolidated = 0
        for entity_name, facts in entity_facts.items():
            if len(facts) < min_facts:
                continue

            # Skip entities that already have an integrated narrative
            if any(_looks_consolidated(val) for _, val in facts):
                continue

            if not use_llm:
                continue  # bail without modifying anything

            plan = _llm_consolidate(entity_name, facts)
            if not plan:
                continue

            narrative = (plan.get("narrative") or "").strip()
            retract_indices = plan.get("retractIndices") or []
            if not narrative or not isinstance(retract_indices, list):
                continue
            # Defensive: bound indices to the input range
            retract_indices = [i for i in retract_indices
                               if isinstance(i, int) and 0 <= i < len(facts)]

            occ_start = plan.get("narrativeOccurredStart")
            occ_end = plan.get("narrativeOccurredEnd")
            # Normalize "null" string and None to None
            occ_start = occ_start if occ_start and occ_start != "null" else None
            occ_end = occ_end if occ_end and occ_end != "null" else None

            tx = store.begin_tx("consolidation", metadata=json.dumps({
                "entity": entity_name,
                "original_count": len(facts),
                "retracted_count": len(retract_indices),
            }))
            new_eid = _fact_id(entity_name, "consolidated", narrative)
            store.assert_triple(tx, new_eid, "entity", entity_name)
            store.assert_triple(tx, new_eid, "attribute", "consolidated")
            store.assert_triple(
                tx, new_eid, "value", narrative,
                occurred_start=occ_start, occurred_end=occ_end,
            )
            store.assert_triple(tx, new_eid, "confidence", "0.95")
            store.assert_triple(tx, new_eid, "first_seen", _now_iso())
            store.assert_triple(tx, new_eid, "reinforce_count", str(len(facts)))
            store.assert_triple(tx, new_eid, "kind", "consolidated")
            for tag in _extract_tags(narrative):
                store.assert_triple(tx, new_eid, "tag", tag)

            # Retract only the facts the LLM flagged as outdated/redundant.
            # The append-only triplestore preserves them via valid_to for audit.
            for idx in retract_indices:
                old_eid, _ = facts[idx]
                for attr_name in list(store.entity(old_eid).keys()):
                    store.retract_triple(tx, old_eid, attr_name)

            consolidated += 1
            print(
                f"  [consolidate] {entity_name}: integrated {len(facts)} facts → 1 "
                f"narrative ({len(narrative)} chars, retracted {len(retract_indices)} originals)",
                file=sys.stderr,
            )

        store.close()
        return consolidated
    except Exception as e:
        print(f"  [consolidate] failed: {e}", file=sys.stderr)
        return 0


def _looks_consolidated(val: str) -> bool:
    """Heuristic: skip facts that already look like a consolidated narrative.

    Catches both the legacy "; "-join shape AND new-style integrated narratives
    that mention temporal evolution. Conservative — false negatives just trigger
    another consolidation pass.
    """
    if len(val) > 200 and val.count(";") >= 2:
        return True  # legacy "; "-joined consolidation
    lower = val.lower()
    return ("used to" in lower and "now" in lower) or ("from " in lower and "to " in lower)


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _extract_entity_from_fact(fact_text: str, known_entities: list) -> str:
    """Extract the most relevant entity name from a fact sentence.

    Matches against known entities from the distiller output.
    Falls back to first capitalized multi-word phrase.
    """
    fact_lower = fact_text.lower()
    # Check which known entities appear in the fact text (longest match first)
    candidates = []
    for ent in known_entities:
        ename = ent if isinstance(ent, str) else ent.get("name", "")
        if ename and ename.lower().replace("-", " ") in fact_lower.replace("-", " "):
            candidates.append(ename)
    if candidates:
        # Return the longest matching entity (most specific)
        return _normalize_entity(max(candidates, key=len))

    # Fallback: first capitalized multi-word phrase
    import re as _re
    match = _re.search(r"[A-Z][a-z]+(?: [A-Z][a-z]+)+", fact_text)
    if match:
        return _normalize_entity(match.group())

    # Last resort: first significant word
    words = [w for w in fact_text.split() if len(w) > 3 and w[0].isupper()]
    if words:
        return _normalize_entity(words[0])

    return "general"


def _unpack_fact_item(item) -> tuple[str, str | None, str | None]:
    """Parse a distiller fact/decision entry. Accepts both legacy string shape
    and the new object shape with optional temporal anchors.

    Legacy:  "Sarah leads platform"
    New:     {"text": "Sarah leads platform", "occurredStart": "...", "occurredEnd": "..."}

    Returns (text, occurred_start, occurred_end). Missing fields are None.
    """
    if isinstance(item, str):
        return item, None, None
    if isinstance(item, dict):
        # Tolerate either "text" or "value" — different LLM passes have used both.
        text = item.get("text", "") or item.get("value", "") or ""
        return str(text), item.get("occurredStart"), item.get("occurredEnd")
    return "", None, None


def _is_stage2_shape(digest: dict) -> bool:
    """Detect whether digest carries Stage 2 structured-triple shape.

    Stage 2 signal: at least one fact is a dict with subject/predicate/object keys,
    AND at least one entity is a dict with id/name/type keys.
    """
    facts = digest.get("facts", [])
    if not facts:
        return False
    first_fact = facts[0]
    if not isinstance(first_fact, dict):
        return False
    if not all(k in first_fact for k in ("subject", "predicate", "object")):
        return False
    entities = digest.get("entities", [])
    if entities and isinstance(entities[0], dict):
        if "id" in entities[0]:
            return True
    return False


def _facts_to_graph_ops(digest: dict) -> list[dict]:
    """Convert ALL distiller output + raw feed items to graph ops.

    DETERMINISTIC — no LLM needed. Stores distilled knowledge (facts,
    decisions, patterns, preferences, summary) AND verbatim raw captures
    (audio quotes, agent analysis) so the triplestore is the single
    source of truth for session recall.

    Stage 2 path: when distiller emits structured triples + altLabels +
    schema.org types, writes direct S-P-O rows + alias ops + set_type ops
    alongside the legacy narrative path (verbatim audio + agent analysis).
    """
    ops = []
    known_entities = digest.get("entities", [])
    raw_items = digest.pop("_rawItems", None) or []
    stage2 = _is_stage2_shape(digest)

    # Session anchor from whatHappened
    session_ts = digest.get("ts", "")[:16]  # "2026-05-07T10:08"
    session_eid = f"session:{session_ts}" if session_ts else None
    if session_eid and digest.get("whatHappened"):
        ops.append({
            "op": "assert",
            "entity": session_ts,
            "attribute": "value",
            "value": digest["whatHappened"],
            "confidence": 0.9,
            "domain": "session",
            "kind": "distilled",
            "session_ref": session_eid,
        })

    # ── Stage 2 path: structured triples + aliases + schema.org types ──
    if stage2:
        for entity in known_entities:
            if not isinstance(entity, dict):
                continue
            eid = entity.get("id", "")
            if not eid:
                continue
            # Namespace the entity id to match assert_triple's expectation
            canonical_id = eid if eid.startswith("entity:") else f"entity:{eid}"
            # Schema.org type override
            etype = entity.get("type", "")
            if etype:
                ops.append({
                    "op": "set_type",
                    "entity_id": canonical_id,
                    "entity_type": etype,
                })
            # Aliases — one op per altLabel
            for alias in entity.get("altLabels", []) or []:
                if alias and isinstance(alias, str):
                    ops.append({
                        "op": "alias",
                        "canonical_id": canonical_id,
                        "alias": alias,
                        "confidence": 1.0,
                        "source": "distiller",
                    })
            # Also write the display name as a triple so the entity has a label
            name = entity.get("name", "")
            if name:
                ops.append({
                    "op": "triple",
                    "subject": canonical_id,
                    "predicate": "schema:name",
                    "object": name,
                    "value_type": "literal",
                })
        # Structured facts → direct triples
        for fact in digest.get("facts", []):
            if not isinstance(fact, dict):
                continue
            subj = fact.get("subject", "")
            pred = fact.get("predicate", "")
            obj = fact.get("object", "")
            if not subj or not pred or not obj:
                continue
            value_type = fact.get("value_type", "literal")
            # Namespace subject and (for ref-typed objects) the object
            subj_id = subj if subj.startswith("entity:") else f"entity:{subj}"
            obj_id = obj
            if value_type == "ref" and not obj.startswith(("entity:", "fact:", "session:")):
                obj_id = f"entity:{obj}"
            ops.append({
                "op": "triple",
                "subject": subj_id,
                "predicate": pred,
                "object": obj_id,
                "value_type": value_type,
            })

    # Facts (distilled). Each item may be a string (legacy) or an object with
    # optional occurredStart/occurredEnd temporal anchors.
    # In Stage 2 mode, facts have already been emitted as triples above — skip the legacy path.
    legacy_fact_iter = [] if stage2 else digest.get("facts", [])
    for raw in legacy_fact_iter:
        fact_text, occ_start, occ_end = _unpack_fact_item(raw)
        if not fact_text or len(fact_text) < 5:
            continue
        entity = _extract_entity_from_fact(fact_text, known_entities)
        op = {
            "op": "assert",
            "entity": entity,
            "attribute": "value",
            "value": fact_text,
            "confidence": 0.9,
            "kind": "distilled",
            "session_ref": session_eid,
        }
        if occ_start:
            op["occurred_start"] = occ_start
        if occ_end:
            op["occurred_end"] = occ_end
        ops.append(op)

    # Decisions (distilled, lower confidence — time-bound). Same dual-shape support.
    for raw in digest.get("decisions", []):
        decision_text, occ_start, occ_end = _unpack_fact_item(raw)
        if not decision_text or len(decision_text) < 5:
            continue
        entity = _extract_entity_from_fact(decision_text, known_entities)
        op = {
            "op": "assert",
            "entity": entity,
            "attribute": "value",
            "value": decision_text,
            "confidence": 0.7,
            "kind": "distilled",
            "session_ref": session_eid,
        }
        if occ_start:
            op["occurred_start"] = occ_start
        if occ_end:
            op["occurred_end"] = occ_end
        ops.append(op)

    # Patterns + Preferences (distilled)
    for text in digest.get("patterns", []) + digest.get("preferences", []):
        if not text or not isinstance(text, str) or len(text) < 5:
            continue
        entity = _extract_entity_from_fact(text, known_entities)
        ops.append({
            "op": "assert",
            "entity": entity,
            "attribute": "value",
            "value": text,
            "confidence": 0.7,
            "kind": "distilled",
            "session_ref": session_eid,
        })

    # Verbatim audio quotes (top 20 by length, > 30 chars)
    audio = [i for i in raw_items
             if i.get("source") == "audio" and len(i.get("text", "")) > 30]
    for item in sorted(audio, key=lambda x: -len(x.get("text", "")))[:20]:
        text = re.sub(r"^\[.*?\]\s*", "", item["text"])  # strip emoji prefixes
        if len(text) < 20:
            continue
        entity = _extract_entity_from_fact(text, known_entities)
        ops.append({
            "op": "assert",
            "entity": entity,
            "attribute": "value",
            "value": text,
            "confidence": 0.95,
            "kind": "verbatim",
            "session_ref": session_eid,
        })

    # Agent analysis responses (last 10, > 50 chars — verbatim)
    agents = [i for i in raw_items
              if i.get("source") in ("agent", "openclaw")
              and len(i.get("text", "")) > 50]
    for item in agents[-10:]:
        text = re.sub(r"^\[.*?\]\s*", "", item["text"])  # strip emoji prefixes
        if len(text) < 30:
            continue
        entity = _extract_entity_from_fact(text, known_entities)
        ops.append({
            "op": "assert",
            "entity": entity,
            "attribute": "value",
            "value": text,
            "confidence": 0.8,
            "kind": "verbatim",
            "session_ref": session_eid,
        })

    return ops


def _execute_graph_ops(db_path: str, ops: list[dict], digest_ts: str, digest_entities: list | None = None) -> dict:
    """Execute graph operations + build entity graph with ref edges."""
    if not ops:
        return {"asserted": 0, "reinforced": 0, "retracted": 0}

    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)

        # Deduplicate via embedding similarity (Mem0 pattern)
        existing_ids = [r[0] for r in store.entities_with_attr("entity")]
        # Load existing fact values for semantic comparison
        existing_facts_for_dedup = []
        for eid in existing_ids:
            attrs = store.entity(eid)
            if attrs and "value" in attrs:
                vals = attrs["value"]
                val = vals[0] if isinstance(vals, list) and vals else str(vals) if vals else ""
                if val:
                    existing_facts_for_dedup.append({"entity_id": eid, "value": val})
        ops = _canonicalize_ops(ops, existing_ids, existing_facts_for_dedup)

        stats = {"asserted": 0, "reinforced": 0, "retracted": 0}

        for op_data in ops:
            op = op_data.get("op", "")

            if op == "assert":
                entity = op_data.get("entity", "")
                attribute = op_data.get("attribute", "")
                value = op_data.get("value", "")
                confidence = op_data.get("confidence", 0.7)
                domain = op_data.get("domain", "")
                occ_start = op_data.get("occurred_start")
                occ_end = op_data.get("occurred_end")

                if not entity or not attribute or not value:
                    continue

                entity_id = _fact_id(entity, attribute, value)
                tx = store.begin_tx("knowledge_integrator", metadata=json.dumps({"digest_ts": digest_ts}))
                store.assert_triple(tx, entity_id, "entity", entity)
                store.assert_triple(tx, entity_id, "attribute", attribute)
                # Temporal anchors belong on the canonical "value" triple — that
                # row represents the fact's claim, so its occurred_start/end
                # describe when the claim was true in the world.
                store.assert_triple(
                    tx, entity_id, "value", value,
                    occurred_start=occ_start, occurred_end=occ_end,
                )
                store.assert_triple(tx, entity_id, "confidence", str(confidence))
                store.assert_triple(tx, entity_id, "first_seen", digest_ts)
                store.assert_triple(tx, entity_id, "last_reinforced", digest_ts)
                store.assert_triple(tx, entity_id, "reinforce_count", "1")
                if domain:
                    store.assert_triple(tx, entity_id, "domain", domain)
                kind = op_data.get("kind", "distilled")
                store.assert_triple(tx, entity_id, "kind", kind)
                # Link to session anchor via ref edge
                session_ref = op_data.get("session_ref")
                if session_ref:
                    store.assert_triple(tx, entity_id, "session", session_ref, value_type="ref")
                # Auto-tag for keyword-based discovery
                for tag in _extract_tags(value):
                    store.assert_triple(tx, entity_id, "tag", tag)
                stats["asserted"] += 1

            elif op == "triple":
                # Stage 2: structured S-P-O triple written directly into EAV,
                # NOT wrapped in a fact:* entity. Cleaner graph shape.
                subj = op_data.get("subject", "")
                pred = op_data.get("predicate", "")
                obj = op_data.get("object", "")
                value_type = op_data.get("value_type", "literal")
                if not subj or not pred or not obj:
                    continue
                tx = store.begin_tx(
                    "knowledge_integrator",
                    metadata=json.dumps({"digest_ts": digest_ts, "shape": "stage2_triple"}),
                )
                store.assert_triple(
                    tx, subj, pred, obj,
                    value_type=("ref" if value_type == "ref" else "string"),
                    occurred_start=op_data.get("occurred_start"),
                    occurred_end=op_data.get("occurred_end"),
                )
                stats["asserted"] += 1

            elif op == "alias":
                # Stage 2: write SKOS-style altLabel into entity_aliases table.
                canonical = op_data.get("canonical_id", "")
                alias = op_data.get("alias", "")
                if not canonical or not alias:
                    continue
                store.add_alias(
                    canonical,
                    alias,
                    confidence=op_data.get("confidence", 1.0),
                    source=op_data.get("source", "distiller"),
                )

            elif op == "set_type":
                # Stage 2: store schema.org class string for an entity.
                eid = op_data.get("entity_id", "")
                etype = op_data.get("entity_type", "")
                if not eid or not etype:
                    continue
                store.set_type(eid, etype)

            elif op == "reinforce":
                entity_id = op_data.get("entityId", "")
                if not entity_id:
                    continue

                # Read current confidence and reinforce count
                attrs = store.entity(entity_id)
                if not attrs:
                    continue

                cur_conf = 0.5
                cur_count = 0
                if "confidence" in attrs:
                    try:
                        cur_conf = float(attrs["confidence"][0])
                    except (ValueError, IndexError):
                        pass
                if "reinforce_count" in attrs:
                    try:
                        cur_count = int(attrs["reinforce_count"][0])
                    except (ValueError, IndexError):
                            pass

                new_conf = min(1.0, cur_conf + 0.15)
                new_count = cur_count + 1

                tx = store.begin_tx("knowledge_integrator", metadata=json.dumps({
                    "op": "reinforce", "entity_id": entity_id, "digest_ts": digest_ts
                }))
                # Retract old values, assert new
                store.retract_triple(tx, entity_id, "confidence", str(cur_conf))
                store.assert_triple(tx, entity_id, "confidence", str(round(new_conf, 2)))
                store.retract_triple(tx, entity_id, "reinforce_count", str(cur_count))
                store.assert_triple(tx, entity_id, "reinforce_count", str(new_count))
                # Retract old last_reinforced if present
                old_reinforced = attrs.get("last_reinforced", [])
                for val in old_reinforced:
                    store.retract_triple(tx, entity_id, "last_reinforced", val)
                store.assert_triple(tx, entity_id, "last_reinforced", digest_ts)
                # Update mentioned_at on the value triple — this is the recency
                # signal used by retrieval's temporal_mode currency boost.
                store.touch_mention(entity_id, attribute="value")
                stats["reinforced"] += 1

            elif op == "retract":
                entity_id = op_data.get("entityId", "")
                reason = op_data.get("reason", "")
                if not entity_id:
                    continue

                tx = store.begin_tx("knowledge_integrator", metadata=json.dumps({
                    "op": "retract", "entity_id": entity_id, "reason": reason, "digest_ts": digest_ts
                }))
                # Retract all attributes of this entity
                attrs = store.entity(entity_id)
                for attr_name, values in attrs.items():
                    for val in values:
                        store.retract_triple(tx, entity_id, attr_name, val)
                stats["retracted"] += 1

        # --- Build entity graph layer (two-layer model) ---
        if digest_entities and stats["asserted"] > 0:
            try:
                # Load existing entity names for fuzzy matching
                all_entity_nodes: dict[str, str] = {}  # {name: entity_node_id}
                for r in store.entities_with_attr("name"):
                    if r[0].startswith("entity:"):
                        all_entity_nodes[r[1]] = r[0]

                # Create entity:* nodes from digest entities (with fuzzy dedup).
                # Track aliases per canonical node so we can populate entity_aliases
                # after the resolve step, and track the set of canonical IDs in
                # this session so we can record cooccurrence pairs.
                entity_resolve: dict[str, str] = {}  # {normalized_name: resolved_node_id}
                aliases_to_record: list[tuple[str, str]] = []  # (canonical_id, alias)
                session_canonicals: set[str] = set()
                for ent in (digest_entities or []):
                    if isinstance(ent, dict):
                        ename = _normalize_entity(ent.get("name", ""))
                        etype = ent.get("type", "unknown")
                        ent_aliases = ent.get("aliases", []) or []
                    else:
                        ename = _normalize_entity(str(ent))
                        etype = "unknown"
                        ent_aliases = []
                    if not ename or len(ename) < 2:
                        continue

                    # Check for fuzzy match against existing entities
                    matched_id = _find_matching_entity(ename, all_entity_nodes)
                    if matched_id:
                        entity_resolve[ename] = matched_id
                        session_canonicals.add(matched_id)
                        # Even when the entity already exists, the distiller may
                        # have observed new surface forms — record them.
                        for a in ent_aliases:
                            if isinstance(a, str) and a.strip():
                                aliases_to_record.append((matched_id, a.strip()))
                        # The original name we resolved away from is itself an
                        # alias of the canonical — record it too.
                        if matched_id != f"entity:{ename}":
                            print(f"  [graph] alias: \"{ename}\" → {matched_id}", file=sys.stderr)
                            aliases_to_record.append((matched_id, ename))
                        continue

                    entity_node_id = f"entity:{ename}"
                    existing = store.entity(entity_node_id)
                    if not existing:
                        tx = store.begin_tx("entity_graph")
                        store.assert_triple(tx, entity_node_id, "name", ename)
                        store.assert_triple(tx, entity_node_id, "type", etype)
                    all_entity_nodes[ename] = entity_node_id
                    entity_resolve[ename] = entity_node_id
                    session_canonicals.add(entity_node_id)
                    for a in ent_aliases:
                        if isinstance(a, str) and a.strip():
                            aliases_to_record.append((entity_node_id, a.strip()))

                # Record aliases. add_alias is idempotent via the (canonical, alias)
                # primary key so re-running is safe.
                for canonical_id, alias in aliases_to_record:
                    try:
                        store.add_alias(canonical_id, alias, confidence=0.95, source="extracted")
                    except Exception as e:
                        print(f"  [graph] alias record failed for {alias}: {e}", file=sys.stderr)

                # Record cooccurrence pairs for entities in this session. The
                # cooccurrence table dedupes via canonical lexicographic ordering
                # so direction doesn't matter; we increment session_count once
                # per ordered pair per integration call.
                canonicals = sorted(session_canonicals)
                for i in range(len(canonicals)):
                    for j in range(i + 1, len(canonicals)):
                        try:
                            store.record_cooccurrence(canonicals[i], canonicals[j])
                        except Exception:
                            pass
                if aliases_to_record or len(canonicals) >= 2:
                    print(
                        f"  [graph] aliases={len(aliases_to_record)} "
                        f"cooccur_pairs={(len(canonicals) * (len(canonicals) - 1)) // 2}",
                        file=sys.stderr,
                    )

                # Link facts to their entity nodes via "about" ref edges
                for op_data in ops:
                    if op_data.get("op") != "assert":
                        continue
                    entity = op_data.get("entity", "")
                    value = op_data.get("value", "")
                    attribute = op_data.get("attribute", "")
                    fact_eid = _fact_id(entity, attribute, value)
                    norm_entity = _normalize_entity(entity)
                    entity_node_id = entity_resolve.get(norm_entity, f"entity:{norm_entity}")
                    # Only link if entity node exists
                    if store.entity(entity_node_id):
                        tx = store.begin_tx("entity_graph")
                        store.assert_triple(tx, fact_eid, "about", entity_node_id, value_type="ref")

                ref_count = 0
                for fact_eid_row in store.entities_with_attr("value"):
                    fact_eid = fact_eid_row[0]
                    if not fact_eid.startswith("fact:"):
                        continue
                    attrs = store.entity(fact_eid)
                    source_entity = (attrs.get("entity", [""])[0] if attrs.get("entity") else "").lower()
                    value_lower = (attrs["value"][0] if attrs.get("value") else "").lower()

                    for ename, enode_id in all_entity_nodes.items():
                        if ename == source_entity or len(ename) < 4:
                            continue
                        if ename in value_lower:
                            existing_refs = store.backrefs(enode_id, attribute="mentions")
                            if not any(r[0] == fact_eid for r in existing_refs):
                                tx = store.begin_tx("ref_inference")
                                store.assert_triple(tx, fact_eid, "mentions", enode_id, value_type="ref")
                                ref_count += 1

                if ref_count:
                    stats["refs_created"] = ref_count
                    print(f"  [graph] {len(all_entity_nodes)} entity nodes, {ref_count} ref edges", file=sys.stderr)
            except Exception as e:
                print(f"  [graph] entity graph failed (non-fatal): {e}", file=sys.stderr)

        store.close()
        return stats
    except Exception as e:
        import traceback
        print(f"[warn] Failed to execute graph ops: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return {"asserted": 0, "reinforced": 0, "retracted": 0, "error": str(e)}


def _extract_header_footer(playbook: str) -> tuple[str, str, str]:
    """Split playbook into (header, body, footer)."""
    lines = playbook.splitlines()
    header_lines: list[str] = []
    footer_lines: list[str] = []
    body_lines: list[str] = []

    in_header = True
    for line in lines:
        stripped = line.strip()
        if in_header and stripped.startswith("<!--"):
            header_lines.append(line)
            continue
        in_header = False
        if stripped.startswith("<!-- effectiveness"):
            footer_lines.append(line)
        else:
            body_lines.append(line)

    return "\n".join(header_lines), "\n".join(body_lines), "\n".join(footer_lines)


def _archive_playbook(memory_dir: str) -> str | None:
    """Archive current playbook. Returns archive path or None."""
    src = Path(memory_dir) / "sinain-playbook.md"
    if not src.exists():
        return None

    archive_dir = Path(memory_dir) / "playbook-archive"
    archive_dir.mkdir(parents=True, exist_ok=True)

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M")
    dest = archive_dir / f"sinain-playbook-{ts}.md"
    shutil.copy2(src, dest)
    return str(dest)


def _bootstrap_graph(memory_dir: str, db_path: str) -> dict:
    """One-time: seed knowledge graph from current playbook patterns."""
    playbook = read_playbook(memory_dir)
    if not playbook:
        return {"bootstrapped": 0}

    import re
    # Extract patterns from playbook (lines starting with "- ")
    patterns = []
    for line in playbook.splitlines():
        line = line.strip()
        if line.startswith("- ") and ("score" in line or "seen" in line):
            patterns.append(line[2:])

    if not patterns:
        return {"bootstrapped": 0}

    # Generate assert ops for each pattern
    ops = []
    for pattern in patterns:
        # Extract score if present
        score_match = re.search(r"score\s*[\d.]+", pattern)
        confidence = 0.6
        if score_match:
            try:
                confidence = float(re.search(r"[\d.]+", score_match.group()).group())
            except (ValueError, AttributeError):
                pass

        # Determine domain from pattern text (basic heuristic)
        domain = "general"
        domain_keywords = {
            "react": "react-native", "metro": "react-native", "flutter": "flutter",
            "ocr": "vision", "audio": "audio", "hud": "sinain-hud",
            "docker": "infrastructure", "ssh": "infrastructure", "deploy": "infrastructure",
            "intellij": "intellij", "psi": "intellij", "claude": "ai-agents",
            "gemini": "ai-agents", "openrouter": "ai-agents", "escalation": "sinain-core",
        }
        lower = pattern.lower()
        for kw, dom in domain_keywords.items():
            if kw in lower:
                domain = dom
                break

        ops.append({
            "op": "assert",
            "entity": domain,
            "attribute": "pattern",
            "value": pattern[:200],
            "confidence": confidence,
            "domain": domain,
        })

    now = datetime.now(timezone.utc).isoformat()
    stats = _execute_graph_ops(db_path, ops, now)
    return {"bootstrapped": stats.get("asserted", 0)}


# Pairs that fuzzy matching incorrectly clusters — reviewed and confirmed distinct.
_DEDUP_SKIP_PAIRS = {
    frozenset({"ai-driven-development", "spac-driven-development"}),
    frozenset({"german", "germany"}),
    frozenset({"llama", "ollama"}),
    frozenset({"gemma", "gemma4"}),
}


def _dedup_via_aliases(db_path: str) -> dict:
    """Stage 2 dedup: merge entities where one's altLabel matches another's slug.

    Runs after every integration. Lighter than merge_entity_duplicates — no
    fuzzy matching, no migration stamp, no full-graph scan. Driven entirely by
    entity_aliases entries written by Stage 2 distillation.

    Algorithm:
    1. Collect candidate pairs from entity_aliases — wherever a canonical_id has
       an altLabel whose slug matches another existing entity:* id.
    2. For each pair, pick the entity with more outbound triples as canonical
       (richer node = more knowledge). Tiebreak by lexicographic id for
       determinism. This avoids the "bidirectional alias = merge both
       directions = data shuttled back and forth" bug.
    3. Merge weaker → richer. Each pair processed at most once.

    Idempotent: once the weaker entity has no triples, future runs skip it.
    """
    from triplestore import TripleStore
    import re as _re
    store = TripleStore(db_path)
    try:
        rows = store._conn.execute(
            "SELECT canonical_id, alias FROM entity_aliases"
        ).fetchall()

        # Build unordered candidate pairs (frozenset of two entity ids)
        candidate_pairs: set[frozenset[str]] = set()
        for row in rows:
            canonical_id = row["canonical_id"]
            alias = row["alias"] or ""
            if not alias.strip():
                continue
            slug = _re.sub(r"[^a-z0-9]+", "-", alias.lower()).strip("-")
            if not slug:
                continue
            candidate_id = slug if slug.startswith("entity:") else f"entity:{slug}"
            if candidate_id == canonical_id:
                continue
            if not canonical_id.startswith("entity:") or not candidate_id.startswith("entity:"):
                continue
            candidate_pairs.add(frozenset({canonical_id, candidate_id}))

        # For each pair, pick the richer entity (more outbound triples) as canonical.
        def triple_count(eid: str) -> int:
            row = store._conn.execute(
                "SELECT COUNT(*) FROM triples WHERE entity_id = ? AND NOT retracted",
                (eid,),
            ).fetchone()
            return row[0] if row else 0

        merge_count = 0
        repoint_count = 0
        already_merged: set[str] = set()

        # Sort pairs so we get deterministic order (richer first to maximize transitive merges)
        ordered_pairs = sorted(
            candidate_pairs,
            key=lambda pair: -max(triple_count(e) for e in pair),
        )
        for pair in ordered_pairs:
            a, b = sorted(pair)  # deterministic
            if a in already_merged or b in already_merged:
                continue
            ca, cb = triple_count(a), triple_count(b)
            if ca == 0 or cb == 0:
                continue  # one side is already empty
            # Richer = canonical; lighter = merged-away
            if ca >= cb:
                canonical_id, candidate_id = a, b
            else:
                canonical_id, candidate_id = b, a

            cand_attrs = store.entity(candidate_id)
            if not cand_attrs:
                continue

            # Move outbound triples from candidate → canonical
            canon = store.entity(canonical_id) or {}
            for attr, values in cand_attrs.items():
                values_list = values if isinstance(values, list) else [values]
                existing = canon.get(attr, [])
                if not isinstance(existing, list):
                    existing = [existing]
                existing_str = {str(e) for e in existing}
                for val in values_list:
                    tx = store.begin_tx("alias_dedup")
                    store.retract_triple(tx, candidate_id, attr, str(val))
                    if str(val) not in existing_str:
                        vt = "ref" if str(val).startswith(("entity:", "fact:", "session:")) else "string"
                        store.assert_triple(tx, canonical_id, attr, str(val), value_type=vt)

            # Repoint inbound refs (X refers_to candidate → X refers_to canonical)
            for src_entity, src_attr in store.backrefs(candidate_id):
                tx = store.begin_tx("alias_dedup")
                store.retract_triple(tx, src_entity, src_attr, candidate_id)
                store.assert_triple(tx, src_entity, src_attr, canonical_id, value_type="ref")
                repoint_count += 1

            # Propagate aliases from duplicate to canonical
            for da in store.aliases_of(candidate_id):
                store.add_alias(canonical_id, da, confidence=0.9, source="alias_dedup")

            already_merged.add(candidate_id)
            merge_count += 1

        return {"merged_entities": merge_count, "refs_repointed": repoint_count}
    finally:
        store.close()


def merge_entity_duplicates(db_path: str, dry_run: bool = True) -> dict:
    """Merge fragmented entity nodes using fuzzy matching.

    Idempotent: checks for migration:entity-dedup-v1 stamp.
    """
    from triplestore import TripleStore
    store = TripleStore(db_path)

    # Idempotency check
    stamp = store.entity("migration:entity-dedup-v1")
    if stamp:
        print("migration:entity-dedup-v1 already applied — skipping", file=sys.stderr)
        return {"status": "already_applied"}

    # Load all entity nodes
    all_entities: dict[str, str] = {}  # {name: entity_node_id}
    for entity_id, name in store.entities_with_attr("name"):
        if entity_id.startswith("entity:"):
            all_entities[name] = entity_id

    print(f"Total entity nodes: {len(all_entities)}", file=sys.stderr)

    # Build clusters via greedy matching
    remaining = dict(all_entities)  # copy
    clusters: list[list[tuple[str, str]]] = []  # [[( name, node_id ), ...], ...]

    while remaining:
        seed_name, seed_id = next(iter(remaining.items()))
        cluster = [(seed_name, seed_id)]
        del remaining[seed_name]

        # Find all matches for this seed
        to_remove = []
        for other_name, other_id in remaining.items():
            matched = _find_matching_entity(other_name, {seed_name: seed_id})
            if matched:
                cluster.append((other_name, other_id))
                to_remove.append(other_name)
        for name in to_remove:
            del remaining[name]

        if len(cluster) > 1:
            # Filter out known false-positive pairs
            names_set = {n for n, _ in cluster}
            if any(pair <= names_set for pair in _DEDUP_SKIP_PAIRS):
                continue
            clusters.append(cluster)

    print(f"Found {len(clusters)} duplicate clusters", file=sys.stderr)

    merge_count = 0
    repoint_count = 0

    for cluster in clusters:
        # Canonical selection: if any entity has significantly more backrefs (5+),
        # use it. Otherwise prefer longest name (most complete spelling).
        max_refs = max(len(store.backrefs(nid)) for _, nid in cluster)
        if max_refs >= 5:
            cluster.sort(key=lambda x: (-len(store.backrefs(x[1])), -len(x[0]), x[0]))
        else:
            cluster.sort(key=lambda x: (-len(x[0]), x[0]))
        canonical_name, canonical_id = cluster[0]
        duplicates = cluster[1:]

        dup_names = [d[0] for d in duplicates]
        print(f"  cluster: {canonical_name} ← {dup_names}", file=sys.stderr)

        if dry_run:
            merge_count += len(duplicates)
            continue

        for dup_name, dup_id in duplicates:
            # Re-point all refs pointing to this duplicate
            refs = store.backrefs(dup_id)
            for src_entity, attr in refs:
                tx = store.begin_tx("entity_dedup")
                store.retract_triple(tx, src_entity, attr, dup_id)
                store.assert_triple(tx, src_entity, attr, canonical_id, value_type="ref")
                repoint_count += 1

            # Retract all triples of the duplicate entity itself
            dup_attrs = store.entity(dup_id)
            tx = store.begin_tx("entity_dedup")
            for attr, values in dup_attrs.items():
                if not isinstance(values, list):
                    values = [values]
                for val in values:
                    store.retract_triple(tx, dup_id, attr, str(val))

            merge_count += 1

    # Stamp migration
    if not dry_run and clusters:
        tx = store.begin_tx("entity_dedup")
        store.assert_triple(tx, "migration:entity-dedup-v1", "applied_at",
                            datetime.now(timezone.utc).isoformat())
        store.assert_triple(tx, "migration:entity-dedup-v1", "clusters_merged",
                            str(len(clusters)))

    result = {
        "status": "dry_run" if dry_run else "applied",
        "clusters": len(clusters),
        "entities_merged": merge_count,
        "refs_repointed": repoint_count,
    }
    print(json.dumps(result, indent=2), file=sys.stderr)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Knowledge Integrator")
    parser.add_argument("--memory-dir", required=True, help="Path to memory/ directory")
    parser.add_argument("--digest", default=None, help="SessionDigest JSON string")
    parser.add_argument("--bootstrap", action="store_true", help="One-time: seed graph from playbook")
    parser.add_argument("--retag", action="store_true", help="Re-extract tags for all existing facts")
    parser.add_argument("--dedup-entities", action="store_true", help="Merge fragmented entity nodes")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without applying")
    args = parser.parse_args()

    memory_dir = args.memory_dir
    db_path = str(Path(memory_dir) / "knowledge-graph.db")

    # Entity dedup mode: merge fragmented entity nodes
    if args.dedup_entities:
        if not Path(db_path).exists():
            output_json({"error": "knowledge-graph.db not found"})
            return
        result = merge_entity_duplicates(db_path, dry_run=args.dry_run)
        output_json(result)
        return

    # Bootstrap mode: seed graph from current playbook
    if args.bootstrap:
        result = _bootstrap_graph(memory_dir, db_path)
        output_json(result)
        return

    # Retag mode: extract tags for all existing facts
    if args.retag:
        if not Path(db_path).exists():
            output_json({"error": "knowledge-graph.db not found"})
            return
        from triplestore import TripleStore
        store = TripleStore(db_path)
        # Get all fact entities that have a 'value' attribute
        rows = store._conn.execute(
            "SELECT DISTINCT entity_id FROM triples WHERE attribute = 'value' AND NOT retracted AND entity_id LIKE 'fact:%'"
        ).fetchall()
        tagged = 0
        for row in rows:
            fid = row["entity_id"]
            attrs = store.entity(fid)
            value_text = attrs.get("value", [""])[0] if attrs else ""
            existing_tags = set(attrs.get("tag", [])) if attrs else set()
            new_tags = _extract_tags(value_text)
            missing = [t for t in new_tags if t not in existing_tags]
            if missing:
                tx = store.begin_tx("retag", metadata=json.dumps({"entity_id": fid}))
                for tag in missing:
                    store.assert_triple(tx, fid, "tag", tag)
                tagged += 1
        store.close()
        output_json({"retagged": tagged, "total_facts": len(rows)})
        return

    # Normal mode: integrate session digest
    if not args.digest:
        print("--digest is required (unless --bootstrap or --retag)", file=sys.stderr)
        output_json({"error": "--digest required"})
        return

    try:
        digest = json.loads(args.digest)
    except json.JSONDecodeError as e:
        output_json({"error": f"Invalid digest JSON: {e}"})
        return

    # Skip if digest indicates empty session
    if digest.get("isEmpty", False):
        output_json({"skipped": True, "reason": "empty session"})
        return

    # Stage 2: validate distiller output through Pydantic schema (lenient mode).
    # If the digest carries the new structured-triple shape, lenient validation
    # salvages malformed facts (drops unresolved refs, keeps the rest) and
    # surfaces warnings without raising. Legacy-shape digests bypass this.
    validation_warnings: list[str] = []
    try:
        from distiller_schema import validate_lenient
    except ImportError:
        validate_lenient = None  # type: ignore[assignment]
    if validate_lenient is not None and _is_stage2_shape(digest):
        result = validate_lenient(digest)
        if result.ok and result.payload is not None:
            validation_warnings = result.warnings
            cleaned = result.payload.model_dump(exclude_unset=False)
            # Preserve top-level metadata fields the schema marks as extras
            for k in ("ts", "sessionKey", "durationMs", "feedItemCount", "_rawItems"):
                if k in digest and k not in cleaned:
                    cleaned[k] = digest[k]
            digest = cleaned
        else:
            _log_integrator_failure(memory_dir, digest, result.errors)
            # Best-effort: keep going with the raw digest; the shape detector
            # will route to the most-applicable path.

    # Read current playbook
    playbook = read_playbook(memory_dir)
    header, body, footer = _extract_header_footer(playbook)

    # Load relevant graph facts for LLM context
    digest_entities = digest.get("entities", [])
    existing_facts = _load_graph_facts(db_path, entities=digest_entities if digest_entities else None)

    # Build user prompt
    facts_text = ""
    if existing_facts:
        facts_lines = []
        for f in existing_facts[:30]:
            eid = f.get("entityId", "?")
            val = f.get("value", "")
            conf = f.get("confidence", "?")
            domain = f.get("domain", "?")
            facts_lines.append(f"- [{eid}] ({domain}, confidence={conf}) {val}")
        facts_text = f"\n\n## Existing Graph Facts (for reference — reinforce or retract as needed)\n" + "\n".join(facts_lines)

    # ── Step 1: DETERMINISTIC graph ops from distiller output (no LLM needed) ──
    # The distiller already extracted structured facts — conversion is mechanical.
    graph_ops = _facts_to_graph_ops(digest)
    digest_ts = digest.get("ts", datetime.now(timezone.utc).isoformat())

    # Dedup + execute
    graph_stats = _execute_graph_ops(db_path, graph_ops, digest_ts, digest_entities=digest_entities)

    # Stage 2 dedup: merge entities where one's altLabel matches another's slug.
    # Catches the citibank/city-bank duplicate that whisper STT mishearings
    # can produce when the same real entity is named differently across sessions.
    try:
        dedup_stats = _dedup_via_aliases(db_path)
        if dedup_stats.get("merged_entities", 0):
            graph_stats["alias_dedup"] = dedup_stats
            print(
                f"  [graph] alias_dedup merged={dedup_stats['merged_entities']} "
                f"repointed={dedup_stats['refs_repointed']}",
                file=sys.stderr,
            )
    except Exception as e:
        print(f"[warn] alias_dedup failed (non-fatal): {e}", file=sys.stderr)

    # NOTE: Consolidation (merging entity facts) and summaries both HURT retrieval
    # at our scale (<200 facts). Individual facts are more retrievable than merged ones.
    # Keep facts separate — dedup handles true duplicates, different facts stay distinct.

    # ── Step 2: Automated playbook curation (tag overlap, no LLM) ──
    archive_path = _archive_playbook(memory_dir)
    active_tags = set()
    for op in graph_ops:
        active_tags.update(_extract_tags(op.get("value", "")))

    playbook_lines = [l for l in body.splitlines() if l.strip() and not l.startswith("<!--")]
    changes: dict[str, list[str]] = {"added": [], "pruned": [], "promoted": [], "reinforced": []}

    # Reinforce playbook lines whose tags overlap with this session
    updated_lines = []
    for line in playbook_lines:
        line_tags = set(_extract_tags(line))
        if line_tags & active_tags:
            # Increment seen count: "... (seen 3)" → "... (seen 4)"
            import re as _re
            seen_match = _re.search(r"\(seen (\d+)\)", line)
            if seen_match:
                old_count = int(seen_match.group(1))
                line = line[:seen_match.start()] + f"(seen {old_count + 1})" + line[seen_match.end():]
                changes["reinforced"].append(line.strip()[:60])
            updated_lines.append(line)
        else:
            updated_lines.append(line)

    # Add novel facts as new playbook lines (no LLM — just format as bullet points).
    # Phase 2: facts may be strings (legacy) or {"text", "occurredStart", ...} objects.
    # _unpack_fact_item normalizes both shapes; _extract_tags needs a plain string.
    for raw_fact in digest.get("facts", [])[:5]:  # cap at 5 new lines per pass
        fact_text, _occ_start, _occ_end = _unpack_fact_item(raw_fact)
        if not fact_text:
            continue
        fact_tags = set(_extract_tags(fact_text))
        # Only add if no existing playbook line covers this
        if not any(set(_extract_tags(l)) & fact_tags for l in playbook_lines if len(fact_tags) > 1):
            new_line = f"- {fact_text} (seen 1)"
            updated_lines.append(new_line)
            changes["added"].append(fact_text[:60])

    # Keep playbook under 50 lines
    if len(updated_lines) > 50:
        updated_lines = updated_lines[:50]

    updated_body = "\n".join(updated_lines)
    new_playbook = f"{header}\n\n{updated_body}\n\n{footer}".strip() + "\n"
    playbook_path = Path(memory_dir) / "sinain-playbook.md"
    playbook_path.write_text(new_playbook, encoding="utf-8")

    # Append digest to session-digests.jsonl
    digests_path = Path(memory_dir) / "session-digests.jsonl"
    with open(digests_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(digest, ensure_ascii=False) + "\n")

    # Write integration log
    log_entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "_type": "integration",
        "changes": changes,
        "graphStats": graph_stats,
        "digestEntities": digest_entities,
        "archivePath": archive_path,
        "playbookLines": len(new_playbook.splitlines()),
    }
    log_dir = Path(memory_dir) / "playbook-logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    log_file = log_dir / f"{today}.jsonl"
    with open(log_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(log_entry, ensure_ascii=False) + "\n")

    output_json({
        "status": "ok",
        "changes": changes,
        "graphStats": graph_stats,
        "playbookLines": len(new_playbook.splitlines()),
    })


if __name__ == "__main__":
    main()
