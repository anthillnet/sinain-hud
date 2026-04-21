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
from datetime import datetime, timezone
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


def _normalize_entity(name: str) -> str:
    """Normalize entity name to canonical form: lowercase, hyphenated, no punctuation."""
    return re.sub(r"[^a-z0-9-]", "", name.lower().replace(" ", "-").replace("_", "-"))


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


def _consolidate_entity_facts(db_path: str, min_facts: int = 3) -> int:
    """Merge multiple facts about the same entity into consolidated facts.

    Pure code — no LLM. Concatenates fact values with "; " separator.
    Runs at shutdown only (not incremental passes).
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

            # Check if a consolidated fact already exists
            if any(";" in val and len(val) > 100 for _, val in facts):
                continue  # already consolidated

            # Deduplicate values (same fact stated differently)
            seen_values: list[str] = []
            for _, val in facts:
                # Skip if very similar to an already-seen value
                if not any(len(set(val.lower().split()) & set(sv.lower().split())) / max(len(val.split()), 1) > 0.7 for sv in seen_values):
                    seen_values.append(val)

            if len(seen_values) < 2:
                continue  # nothing to consolidate after dedup

            merged_value = "; ".join(seen_values)
            if len(merged_value) > 500:
                merged_value = merged_value[:500] + "..."

            # Create consolidated fact, retract originals
            tx = store.begin_tx("consolidation")
            new_eid = _fact_id(entity_name, "consolidated", merged_value)
            store.assert_triple(tx, new_eid, "entity", entity_name)
            store.assert_triple(tx, new_eid, "attribute", "consolidated")
            store.assert_triple(tx, new_eid, "value", merged_value)
            store.assert_triple(tx, new_eid, "confidence", "0.95")
            store.assert_triple(tx, new_eid, "first_seen", _now_iso())
            store.assert_triple(tx, new_eid, "reinforce_count", str(len(facts)))
            for tag in _extract_tags(merged_value):
                store.assert_triple(tx, new_eid, "tag", tag)

            # Retract original individual facts
            for old_eid, _ in facts:
                for attr_name in list(store.entity(old_eid).keys()):
                    store.retract_triple(tx, old_eid, attr_name)

            consolidated += 1
            print(f"  [consolidate] {entity_name}: {len(facts)} facts → 1 ({len(merged_value)} chars)", file=sys.stderr)

        store.close()
        return consolidated
    except Exception as e:
        print(f"  [consolidate] failed: {e}", file=sys.stderr)
        return 0


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


def _facts_to_graph_ops(digest: dict) -> list[dict]:
    """Convert distiller facts/entities/decisions directly to graph ops.

    DETERMINISTIC — no LLM needed. The distiller already extracted structured
    facts with entity names. This function mechanically converts them to
    assert operations for the triplestore.
    """
    ops = []
    known_entities = digest.get("entities", [])

    # Each fact becomes an assert op
    for fact_text in digest.get("facts", []):
        if not fact_text or len(fact_text) < 5:
            continue
        entity = _extract_entity_from_fact(fact_text, known_entities)
        ops.append({
            "op": "assert",
            "entity": entity,
            "attribute": "fact",
            "value": fact_text,
            "confidence": 0.9,
            "domain": "",
        })

    # Each decision becomes an assert with lower confidence (time-bound)
    for decision_text in digest.get("decisions", []):
        if not decision_text or len(decision_text) < 5:
            continue
        entity = _extract_entity_from_fact(decision_text, known_entities)
        ops.append({
            "op": "assert",
            "entity": entity,
            "attribute": "decision",
            "value": decision_text,
            "confidence": 0.7,
            "domain": "",
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

                if not entity or not attribute or not value:
                    continue

                entity_id = _fact_id(entity, attribute, value)
                tx = store.begin_tx("knowledge_integrator", metadata=json.dumps({"digest_ts": digest_ts}))
                store.assert_triple(tx, entity_id, "entity", entity)
                store.assert_triple(tx, entity_id, "attribute", attribute)
                store.assert_triple(tx, entity_id, "value", value)
                store.assert_triple(tx, entity_id, "confidence", str(confidence))
                store.assert_triple(tx, entity_id, "first_seen", digest_ts)
                store.assert_triple(tx, entity_id, "last_reinforced", digest_ts)
                store.assert_triple(tx, entity_id, "reinforce_count", "1")
                if domain:
                    store.assert_triple(tx, entity_id, "domain", domain)
                # Auto-tag for keyword-based discovery
                for tag in _extract_tags(value):
                    store.assert_triple(tx, entity_id, "tag", tag)
                stats["asserted"] += 1

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
                # Create entity:* nodes from digest entities
                for ent in (digest_entities or []):
                    if isinstance(ent, dict):
                        ename = _normalize_entity(ent.get("name", ""))
                        etype = ent.get("type", "unknown")
                    else:
                        ename = _normalize_entity(str(ent))
                        etype = "unknown"
                    if not ename or len(ename) < 2:
                        continue

                    entity_node_id = f"entity:{ename}"
                    existing = store.entity(entity_node_id)
                    if not existing:
                        tx = store.begin_tx("entity_graph")
                        store.assert_triple(tx, entity_node_id, "name", ename)
                        store.assert_triple(tx, entity_node_id, "type", etype)

                # Link facts to their entity nodes via "about" ref edges
                for op_data in ops:
                    if op_data.get("op") != "assert":
                        continue
                    entity = op_data.get("entity", "")
                    value = op_data.get("value", "")
                    attribute = op_data.get("attribute", "")
                    fact_eid = _fact_id(entity, attribute, value)
                    entity_node_id = f"entity:{_normalize_entity(entity)}"
                    # Only link if entity node exists
                    if store.entity(entity_node_id):
                        tx = store.begin_tx("entity_graph")
                        store.assert_triple(tx, fact_eid, "about", entity_node_id, value_type="ref")

                # Infer cross-entity refs from fact content
                all_entity_nodes = {}
                for r in store.entities_with_attr("name"):
                    if r[0].startswith("entity:"):
                        all_entity_nodes[r[1]] = r[0]  # {name: entity_id}

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


def main() -> None:
    parser = argparse.ArgumentParser(description="Knowledge Integrator")
    parser.add_argument("--memory-dir", required=True, help="Path to memory/ directory")
    parser.add_argument("--digest", default=None, help="SessionDigest JSON string")
    parser.add_argument("--bootstrap", action="store_true", help="One-time: seed graph from playbook")
    parser.add_argument("--retag", action="store_true", help="Re-extract tags for all existing facts")
    args = parser.parse_args()

    memory_dir = args.memory_dir
    db_path = str(Path(memory_dir) / "knowledge-graph.db")

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

    # Add novel facts as new playbook lines (no LLM — just format as bullet points)
    for fact in digest.get("facts", [])[:5]:  # cap at 5 new lines per pass
        fact_tags = set(_extract_tags(fact))
        # Only add if no existing playbook line covers this
        if not any(set(_extract_tags(l)) & fact_tags for l in playbook_lines if len(fact_tags) > 1):
            new_line = f"- {fact} (seen 1)"
            updated_lines.append(new_line)
            changes["added"].append(fact[:60])

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
