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
import os
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
    Good: "citibank", "acme-group", "tariq", "intellij-idea"
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


def _to_str(v) -> str:
    """Coerce any value to a string; dict/list go through json.dumps."""
    if isinstance(v, str):
        return v
    try:
        return json.dumps(v, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(v)


def _normalize_digest(digest: dict) -> dict:
    """Force the digest into the schema the integrator expects.

    Main's distiller emits a tight `list[str]` shape for facts/decisions/
    patterns/preferences and a list[dict] for entities. Local distillers
    (phi4-mini, gemma4:e2b, etc.) sometimes emit dicts in place of lists,
    bools in place of strings, or single objects instead of arrays. We
    normalize once at the parse boundary so every downstream consumer
    (graph ops, playbook formatting, tag extraction) sees the same shape.

    Returns a NEW dict (does not mutate input).
    """
    if not isinstance(digest, dict):
        return {"isEmpty": True, "error": "digest is not a dict"}

    out = dict(digest)

    # String-list fields: coerce each element to a string; wrap dicts in
    # a single-element list of their JSON form; drop non-iterables.
    #
    # Lever 1 exception: `facts` items may legitimately be objects of shape
    # {text, attributedTo?, subject?}. Preserve those; stringify everything
    # else as before.
    def _coerce_fact_item(x):
        if isinstance(x, dict) and isinstance(x.get("text"), str) and x["text"]:
            clean = {"text": x["text"]}
            at = x.get("attributedTo")
            if isinstance(at, str) and at.strip():
                clean["attributedTo"] = at.strip()
            subj = x.get("subject")
            if isinstance(subj, str) and subj.strip():
                clean["subject"] = subj.strip()
            # Preserve provenance kind (e.g. "recon" from T1-RECON consolidation).
            # This allow-list rebuild previously DROPPED `kind`, so consolidated
            # current-state facts reached _facts_to_graph_ops untagged and defaulted
            # to "distilled" — the root cause of the read-side recon guard being a
            # no-op (zero kind=recon ever persisted).
            kind = x.get("kind")
            if isinstance(kind, str) and kind.strip():
                clean["kind"] = kind.strip()
            return clean
        return _to_str(x)

    raw_facts = out.get("facts", [])
    if isinstance(raw_facts, list):
        out["facts"] = [_coerce_fact_item(x) for x in raw_facts if x not in (None, "", False)]
    elif isinstance(raw_facts, dict):
        out["facts"] = [_coerce_fact_item(v) for v in raw_facts.values() if v not in (None, "", False)]
    elif isinstance(raw_facts, str):
        out["facts"] = [raw_facts] if raw_facts else []
    else:
        out["facts"] = []

    for key in ("decisions", "patterns", "preferences"):
        raw = out.get(key, [])
        if isinstance(raw, list):
            out[key] = [_to_str(x) for x in raw if x not in (None, "", False)]
        elif isinstance(raw, dict):
            # Dict-shaped emission — flatten values into strings.
            out[key] = [_to_str(v) for v in raw.values() if v not in (None, "", False)]
        elif isinstance(raw, str):
            out[key] = [raw] if raw else []
        else:
            out[key] = []

    # entities: list of dicts. If dict, wrap in list; if list, keep dicts only.
    ents = out.get("entities", [])
    if isinstance(ents, dict):
        # Some local models emit a flat dict of name → metadata.
        ents_list = [{"name": k, **(v if isinstance(v, dict) else {"type": _to_str(v)})}
                     for k, v in ents.items()]
    elif isinstance(ents, list):
        ents_list = [e for e in ents if isinstance(e, dict)]
    else:
        ents_list = []
    # Each entity's `name` and `type` MUST be strings — local distillers
    # sometimes emit bool / None / nested dict here, and downstream callers
    # (e.g., _extract_entity_from_fact) call .lower() on the name.
    out["entities"] = []
    for e in ents_list:
        clean = dict(e)
        for k in ("name", "type"):
            if k in clean and not isinstance(clean[k], str):
                clean[k] = _to_str(clean[k])
        # Drop entities with non-string name after coercion fallback (rare).
        if isinstance(clean.get("name"), str) and clean["name"]:
            out["entities"].append(clean)

    # Scalar fields — keep type or coerce.
    if not isinstance(out.get("whatHappened", ""), str):
        out["whatHappened"] = _to_str(out.get("whatHappened", ""))
    if not isinstance(out.get("ts", ""), str):
        out["ts"] = _to_str(out.get("ts", ""))
    out["isEmpty"] = bool(out.get("isEmpty", False))

    return out


def _extract_tags(value) -> list[str]:
    """Extract searchable keyword tags from fact value text.

    Returns up to 10 deduplicated lowercase tags suitable for AVET-indexed lookup.

    Defensive coercion 2026-05-27: local distillers (phi4-mini, gemma4:e2b)
    sometimes emit `value` as a nested dict or list rather than a string.
    JSON-stringify non-string inputs so tag extraction still produces
    meaningful tags (keys + values both contribute) instead of crashing.
    """
    if not isinstance(value, str):
        try:
            value = json.dumps(value, ensure_ascii=False)
        except (TypeError, ValueError):
            value = str(value)
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
    if best_match is not None:
        return best_match

    # E1 — phonetic + fuzzy canonicalization. Catches variants below the 0.90
    # difflib floor that weak distillers / ASR produce ("city-bank"↔"citibank",
    # "mustapha"↔"mustafa") — the entity-graph fragmentation that hurts local
    # mode most. Metaphone gate + RapidFuzz confirm + a prefix/suffix guard that
    # generalizes _DEDUP_SKIP_PAIRS. Default ON; SINAIN_CANON=0 ablates (and is
    # mixed into the bench cache key so on/off land in distinct store slots).
    if os.environ.get("SINAIN_CANON", "1") != "0":
        try:
            from entity_canonicalizer import phonetic_fuzzy_match
            hit = phonetic_fuzzy_match(name, existing_names, _DEDUP_SKIP_PAIRS)
            if hit is not None:
                return existing_names[hit]
        except Exception:
            pass
    return None


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

        # T1-RECON: consolidated current-state facts (kind=recon) run in a SECOND
        # integrator pass AFTER the main graph exists, so they are almost always
        # embedding-similar to an existing distilled fact. Letting the dedup below
        # convert them to a `reinforce` collapses them into that distilled fact and
        # DROPS the kind=recon provenance — which makes the read-side topical guard a
        # no-op (root cause of RECON-on 24/36: zero recon facts ever persisted). Keep
        # recon asserts as distinct facts (only intra-batch exact-value dedup applies)
        # so they carry kind=recon and the guard can demote/keep them per query.
        if op.get("kind") == "recon":
            if value in seen_values_set or fact_id in seen_fact_ids:
                continue
            result.append(op)
            seen_fact_ids.add(fact_id)
            seen_values_set.add(value)
            continue

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
            ranked = store.tag_ranked_search(keywords, limit=limit)
            fact_ids = [eid for eid, _ in ranked]
        else:
            # Top-N by confidence
            top = store.top_facts_by_confidence(limit=limit)
            fact_ids = [eid for eid, _ in top]

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

            # T1-SUPERSEDE: SOFT-retract the merged-away originals (mark valid_to +
            # supersededBy=consolidated fact) instead of hard-deleting. The data
            # survives for history/as-of/undo; current-state reads exclude it. The
            # consolidated fact carries the same info, so dropping originals from
            # current retrieval is loss-free.
            for old_eid, _ in facts:
                store.soft_retract_triple(tx, old_eid, superseded_by=new_eid)

            consolidated += 1
            print(f"  [consolidate] {entity_name}: {len(facts)} facts → 1 ({len(merged_value)} chars)", file=sys.stderr)

        store.close()
        return consolidated
    except Exception as e:
        print(f"  [consolidate] failed: {e}", file=sys.stderr)
        return 0


def _manifold_canonicalize_graph(db_path: str, tau: float = 0.90) -> int:
    """#2: graph-wide spherical-medoid canonicalization (IG_features.md).

    The distiller rephrases the SAME fact differently each run and across sessions, so the
    graph accumulates paraphrase clusters that bloat retrieval and make the stored set drift
    run-to-run (the ~70% distillation non-determinism). Embed all current facts, cluster on
    the unit hypersphere (connected components at cosine >= tau — deterministic, order-
    invariant), and keep ONE canonical representative per cluster: the spherical MEDOID (the
    member nearest the cluster's geodesic/Fréchet centre, i.e. max summed cosine to the rest).
    Non-medoids are SOFT-retracted (valid_to + supersededBy → excluded from current-state
    reads, preserved for history/undo; reversible, loss-free since the medoid carries the same
    meaning). Converts run-to-run STRING variance into SEMANTIC stability (measure with
    semantic Jaccard, not byte Jaccard).

    Set-level upgrade of the pairwise Mem0 dedup; the Fréchet-mean idea (Karcher 1977) on the
    sphere, realised as the discrete medoid since facts are text (no synthesised mean fact).
    Local embeddings (works without sinain-core /embed). Skips kind in {recon, verbatim},
    already-retracted, and already-consolidated facts. Deterministic, fail-open.
    Gated by SINAIN_MANIFOLD_CANON in the caller."""
    try:
        from triplestore import TripleStore
        from embed_client import embed
        store = TripleStore(db_path)
        facts: list[tuple[str, str, float]] = []  # (fact_id, value, confidence)
        for fid, _ in store.entities_with_attr("value"):
            if not str(fid).startswith("fact:"):
                continue
            a = store.entity(fid)
            if not a:
                continue
            v = a.get("value", [""]); v = v[0] if isinstance(v, list) else v
            if not (v and isinstance(v, str) and len(v) > 8):
                continue
            k = a.get("kind", [""]); k = k[0] if isinstance(k, list) else k
            if k in ("recon", "verbatim", "gapfill"):
                continue  # recon=current-state, verbatim=raw, gapfill=#6 coverage facts (all kept distinct)
            if a.get("valid_to"):
                continue  # already superseded
            if ";" in v and len(v) > 100:
                continue  # already consolidated
            c = a.get("confidence", ["0.8"]); c = c[0] if isinstance(c, list) else c
            try:
                conf = float(c or 0.8)
            except (TypeError, ValueError):
                conf = 0.8
            facts.append((fid, v, conf))
        if len(facts) < 2:
            store.close()
            return 0
        vecs = embed([f[1] for f in facts])
        if not vecs or len(vecs) != len(facts):
            store.close()
            return 0  # no embeddings → cannot cluster → no-op

        n = len(facts)

        def _cos(a, b) -> float:
            return sum(x * y for x, y in zip(a, b))

        # Connected components at cosine >= tau (vectors are unit-normalised → dot = cosine).
        # Components are invariant to fact iteration order (RocksDB scan order varies), so the
        # canonicalization result is deterministic regardless of store layout.
        parent = list(range(n))

        def _find(x: int) -> int:
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for i in range(n):
            for j in range(i + 1, n):
                if _cos(vecs[i], vecs[j]) >= tau:
                    ri, rj = _find(i), _find(j)
                    if ri != rj:
                        parent[max(ri, rj)] = min(ri, rj)

        clusters: dict[int, list[int]] = {}
        for k in range(n):
            clusters.setdefault(_find(k), []).append(k)

        retracted = 0
        merged_clusters = 0
        tx = store.begin_tx("manifold-canon")
        for members in clusters.values():
            if len(members) < 2:
                continue
            merged_clusters += 1

            def _centrality(m: int, _members=members) -> tuple:
                s = round(sum(_cos(vecs[m], vecs[o]) for o in _members if o != m), 6)
                # max centrality; tie-break: higher confidence, then value text (deterministic)
                return (s, facts[m][2], facts[m][1])

            medoid = max(members, key=_centrality)
            for m in members:
                if m != medoid:
                    store.soft_retract_triple(tx, facts[m][0], superseded_by=facts[medoid][0])
                    retracted += 1
        store.commit_tx(tx)
        store.close()
        if retracted:
            print(f"  [manifold] canonicalized {retracted} paraphrase(s) → medoid across "
                  f"{merged_clusters} cluster(s)", file=sys.stderr)
        return retracted
    except Exception as e:  # FAIL-OPEN — never break ingestion
        print(f"  [manifold] failed (fail-open): {e}", file=sys.stderr)
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


_GENERIC_PRED = re.compile(
    # definitional / how-to / general-knowledge predicate shapes the distiller
    # volunteers as background (NOT about the user): "Bee balm repels pests",
    # "Turkey wraps can be refrigerated", "Atmospheric distillation is a process".
    r"\b(?:is|are|was|were|can be|could be|should be|may be|repels?|provides?|"
    r"offers?|involves?|includes?|consists?|requires?|contains?|refers?|"
    r"helps?|prevents?|reduces?|improves?|means?|denotes?|typically|generally|"
    r"usually|often|are known|is known|is a type|is the process)\b",
    re.IGNORECASE,
)
_USER_REF = re.compile(r"\b(?:the user(?:'s|s')?|the user is|user's)\b", re.IGNORECASE)


def _fact_text_of(f) -> str:
    if isinstance(f, str):
        return f
    if isinstance(f, dict):
        t = f.get("text")
        return t if isinstance(t, str) else ""
    return ""


def _salience_filter(facts: list) -> list:
    """Deterministic, model-agnostic salience gate (T3-FORGET 'salience-gated
    writes'; eval-log STAGES rule — NOT a distiller-prompt instruction, so it
    works regardless of which model distilled or whether it complied).

    LLM distillation of long sessions is non-deterministic (~70% of facts vary
    run-to-run); the volatile tail is INCIDENTAL world-trivia the assistant
    volunteered ("Bee balm repels hornworm", "Frida Kahlo underwent surgeries"),
    while the stable core is the user-centric / asked-about material. Dropping the
    incidental tail raises precision (fewer retrieval distractors → the salient
    facts rank more reliably → answers stabilize) AND shrinks the volatile set.

    CONSERVATIVE — drops a fact only when ALL hold, so central/asked-about topics
    and user facts always survive (raw chunks backstop anything dropped):
      (a) it does NOT reference the user, AND
      (b) it is "generic-leaning", AND
      (c) its subject entity is NOT shared with any user-referencing fact in this
          batch (i.e. it is not part of the user's own context/topic).

    "Generic-leaning" (criterion b) has two implementations:
      * DEFAULT — a regex generic-knowledge predicate shape (hand-built proxy).
      * #1 SURPRISAL (SINAIN_SURPRISAL_SALIENCE=1) — the principled information-content
        gate: embed the fact, score its kNN density on a FROZEN generic-knowledge manifold
        (generic_background) and on the in-batch user facts; drop when the surprisal log-
        ratio LR = score_user − score_generic < θ AND generic_density ≥ g_floor (two-sided
        guard so a novel-but-salient fact far from BOTH manifolds is never dropped). θ /
        g_floor via SINAIN_SALIENCE_LR_THETA / SINAIN_SALIENCE_GFLOOR. Fail-open to the
        regex gate if embeddings are unavailable.
    """
    if not isinstance(facts, list) or len(facts) < 2:
        return facts
    import os as _os
    texts = [_fact_text_of(f) for f in facts]
    # subjects/entities that co-occur with a user-referencing fact → protected
    def _subj(f, txt):
        s = f.get("subject") if isinstance(f, dict) else ""
        if isinstance(s, str) and s.strip():
            return s.strip().lower()
        # fallback: capitalized lead phrase
        m = re.match(r"\s*([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+){0,2})", txt)
        return m.group(1).lower() if m else ""
    user_subjects = set()
    for f, txt in zip(facts, texts):
        if _USER_REF.search(txt):
            sj = _subj(f, txt)
            if sj:
                user_subjects.add(sj)

    # #1 surprisal scores (per fact, aligned to `facts`): (LR, generic_density). None unless
    # the mode is on AND embeddings + frozen background are available (else regex fallback).
    sal = None
    if False:  # #1 surprisal runs GRAPH-WIDE (_surprisal_prune_graph), not per-session:
        # a single session's ~10 facts give too few user vecs for a reliable LR. Per-session
        # stays the regex gate; the surprisal pass operates on the accumulated graph at end-of-ingest.
        try:
            from embed_client import embed
            from generic_background import salience_scores
            fact_vecs = embed(texts)
            if fact_vecs:
                user_vecs = [fact_vecs[i] for i, t in enumerate(texts) if _USER_REF.search(t)]
                sal = salience_scores(fact_vecs, user_vecs)
        except Exception:
            sal = None
    # θ=0.0 → drop a non-user fact only when it is closer to the GENERIC manifold than to the
    # user's own content (surprisal log-ratio < 0). Calibrated on real stores: this catches the
    # incidental world-trivia tail (CLI definitions, history, generic how-tos) at ~1.5% drop with
    # ZERO user/salient facts touched. g_floor defaults to 0.0 (guard OFF): score_generic is
    # corpus-limited (a frozen background can't cover every trivia domain), so requiring high
    # generic-density backfires by PROTECTING corpus-missing trivia; the robust signal is the LR
    # itself (driven by score_user). g_floor>0 is available as an extra-precision tightener.
    lr_theta = float(_os.environ.get("SINAIN_SALIENCE_LR_THETA", "0.0"))
    g_floor = float(_os.environ.get("SINAIN_SALIENCE_GFLOOR", "0.0"))

    kept = []
    for i, (f, txt) in enumerate(zip(facts, texts)):
        if not txt:
            kept.append(f)
            continue
        # Exempt consolidated/attribution facts (kind=recon): already curated cross-session
        # summaries that legitimately use generic predicates ("includes"); never drop them.
        if isinstance(f, dict) and f.get("kind") == "recon":
            kept.append(f)
            continue
        # Hard protections (both modes): never drop user facts or the user's own topics.
        if _USER_REF.search(txt):
            kept.append(f)
            continue
        sj = _subj(f, txt)
        if sj and sj in user_subjects:
            kept.append(f)
            continue
        # criterion (b): generic-leaning?
        if sal is not None:
            lr, g_density = sal[i]
            if (lr < lr_theta) and (g_density >= g_floor):
                continue  # surprisal: generic-leaning AND not user-relevant → drop trivia
        elif _GENERIC_PRED.search(txt):
            continue  # default regex gate
        kept.append(f)
    return kept


def _surprisal_prune_graph(db_path: str, lr_theta: float = 0.0, g_floor: float = 0.0) -> int:
    """#1: graph-wide information-content (surprisal) salience prune.

    The volatile ~70% distillation tail is INCIDENTAL world-trivia the assistant volunteered
    (CLI definitions, history asides, generic how-tos) — content HIGH-probability under a generic
    LM, i.e. near-zero pointwise mutual information with THIS user. Approximate the surprisal
    log-ratio LR = log P(f|user) - log P(f|generic) with embedding kNN densities: score_user on
    the accumulated USER-referencing facts, score_generic on a FROZEN generic-knowledge corpus
    (generic_background). Soft-retract a non-user, non-recon fact when LR < lr_theta (closer to
    the generic manifold than to the user's own content) and, if g_floor>0, score_generic>=g_floor.

    Runs GRAPH-WIDE (not per-session): the LR needs the full user manifold — one session's ~10
    facts give an unreliable estimate (the regex `_salience_filter` stays per-session). Mirrors
    #2's structure. Hard protections: never drop user-referencing facts, kind in {recon,verbatim},
    already-retracted, already-consolidated, or a fact whose subject co-occurs with a user fact.
    Soft-retract = reversible; raw-chunk backstop covers anything dropped. Calibrated on real
    stores: theta=0 drops ~1-2% (genuine trivia, zero user/salient). Deterministic, fail-open.
    Gated by SINAIN_SURPRISAL_SALIENCE in the caller."""
    try:
        from triplestore import TripleStore
        from embed_client import embed
        from generic_background import salience_scores
        store = TripleStore(db_path)
        items: list[tuple[str, str]] = []  # (fact_id, value)
        for fid, _ in store.entities_with_attr("value"):
            if not str(fid).startswith("fact:"):
                continue
            a = store.entity(fid)
            if not a:
                continue
            k = a.get("kind", [""]); k = k[0] if isinstance(k, list) else k
            if k in ("recon", "verbatim", "gapfill"):
                continue
            if a.get("valid_to"):
                continue
            v = a.get("value", [""]); v = v[0] if isinstance(v, list) else v
            if not (v and isinstance(v, str) and len(v) > 8):
                continue
            if ";" in v and len(v) > 100:
                continue  # already consolidated
            items.append((fid, v))
        if len(items) < 5:
            store.close()
            return 0
        texts = [v for _, v in items]
        vecs = embed(texts)
        if not vecs or len(vecs) != len(items):
            store.close()
            return 0
        user_idx = [i for i, t in enumerate(texts) if _USER_REF.search(t)]
        user_vecs = [vecs[i] for i in user_idx]
        if len(user_vecs) < 3:
            store.close()
            return 0  # too few user facts to estimate the user manifold reliably
        user_subjects = set()
        for i in user_idx:
            m = re.match(r"\s*([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+){0,2})", texts[i])
            if m:
                user_subjects.add(m.group(1).lower())
        sal = salience_scores(vecs, user_vecs)
        if sal is None:
            store.close()
            return 0
        pruned = 0
        tx = store.begin_tx("surprisal-prune")
        for i, (fid, v) in enumerate(items):
            if _USER_REF.search(v):
                continue  # hard-protect user facts
            m = re.match(r"\s*([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+){0,2})", v)
            if m and m.group(1).lower() in user_subjects:
                continue  # the user's own topic
            lr, g_density = sal[i]
            if lr < lr_theta and (g_floor <= 0.0 or g_density >= g_floor):
                store.soft_retract_triple(tx, fid)  # superseded=None -> just mark valid_to
                pruned += 1
        store.commit_tx(tx)
        store.close()
        if pruned:
            print(f"  [surprisal] pruned {pruned} low-information (generic-trivia) fact(s)",
                  file=sys.stderr)
        return pruned
    except Exception as e:  # FAIL-OPEN — never break ingestion
        print(f"  [surprisal] failed (fail-open): {e}", file=sys.stderr)
        return 0


_GAPFILL_MONTHS = re.compile(
    r"\b(?:january|february|march|april|may|june|july|august|september|october|november|"
    r"december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b", re.IGNORECASE)
_GAPFILL_NUM = re.compile(r"\b\d{4}-\d{2}-\d{2}\b|\$\s?\d|\b\d{2,}\b", re.IGNORECASE)
_GAPFILL_WORDNUM = re.compile(
    r"\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b", re.IGNORECASE)


def _has_salience_anchor(s: str) -> bool:
    """A source sentence is worth gap-filling only if it carries an answer-bearing ANCHOR —
    a date, money/number, month, word-number, or a named entity (a capitalized word that is
    NOT the sentence's first token). Generic prose without an anchor is not filled."""
    if _GAPFILL_NUM.search(s) or _GAPFILL_MONTHS.search(s) or _GAPFILL_WORDNUM.search(s):
        return True
    toks = s.split()
    return any(re.match(r"[A-Z][a-z]{2,}", t) for t in toks[1:])


def _coverage_gapfill_graph(db_path: str, max_fill: int = 15, cover_floor: float = 0.62,
                            user_floor: float = 0.28, min_len: int = 20, max_len: int = 300) -> int:
    """#6: coverage-gated verbatim gap-fill (the salvageable fragment of OT coverage distillation).

    The distiller DROPS salient source regions. Compute each source sentence's coverage_gap =
    1 − max cosine to any current fact (the cheap source→summary 1-NN / Chamfer term of the
    optimal-transport coverage objective — no Sinkhorn). Emit a sentence VERBATIM as a kind=gapfill
    fact when it is (a) UNCOVERED (max-cosine-to-fact < cover_floor), (b) carries a salience ANCHOR
    (date / number / named entity), AND (c) is USER-RELEVANT (top-k cosine to the user's own facts
    ≥ user_floor). Criterion (c) is ESSENTIAL: coverage_gap alone surfaces narrative/fiction NOISE
    the distiller correctly dropped (those are uncovered too); the user-proximity gate keeps only
    the user's genuinely-dropped facts ("I just got back from a tour at MoMA …": user_prox≈0.37)
    and rejects fiction ("Matt put a hand on his shoulder": ≈0.19). Deterministic, no LLM; unlike
    the query-driven raw-chunk backstop, bakes the fact retrievable regardless of query phrasing.
    Skipped by #1/#2 (kind=gapfill). Fail-open. Gated SINAIN_GAPFILL.

    NOTE: does NOT recover facts whose answer lives in session METADATA rather than text (e.g. a
    visit DATE carried by occurred_at, not the sentence) — that is the #8 temporal-index lever."""
    try:
        from triplestore import TripleStore
        from embed_client import embed
        from raw_store import _sidecar_path
        sidecar = _sidecar_path(db_path)
        if not sidecar.exists():
            return 0
        # source sentences carrying an anchor (chunk-id ordered), deduped
        seen: set[str] = set()
        src: list[tuple[int, str]] = []
        for line in sidecar.open():
            try:
                rec = json.loads(line)
            except Exception:
                continue
            try:
                cid = int(rec.get("id", 0))
            except Exception:
                cid = 0
            for sent in re.split(r"(?<=[.!?])\s+", rec.get("text", "")):
                s = sent.strip()
                if min_len < len(s) < max_len and _has_salience_anchor(s):
                    key = s.lower()
                    if key not in seen:
                        seen.add(key)
                        src.append((cid, s))
        if not src:
            return 0
        store = TripleStore(db_path)
        facts: list[str] = []
        ufacts: list[str] = []
        for fid, _ in store.entities_with_attr("value"):
            if not str(fid).startswith("fact:"):
                continue
            a = store.entity(fid)
            if not a or a.get("valid_to"):
                continue
            v = a.get("value", [""]); v = v[0] if isinstance(v, list) else v
            if v and isinstance(v, str) and len(v) > 8:
                facts.append(v)
                if _USER_REF.search(v):
                    ufacts.append(v)
        if not facts or len(ufacts) < 3:
            store.close()
            return 0  # need a user manifold for the relevance gate
        fvecs = embed(facts)
        svecs = embed([s for _, s in src])
        uvecs = embed(ufacts)
        if not fvecs or not svecs or not uvecs or len(svecs) != len(src):
            store.close()
            return 0

        def _cos(a, b) -> float:
            return sum(x * y for x, y in zip(a, b))

        def _topk_mean(vec, pool, k=5):
            ss = sorted((_cos(vec, p) for p in pool), reverse=True)[:max(1, min(k, len(pool)))]
            return sum(ss) / len(ss)

        gaps = []  # (max_cosine, cid, sentence) — lower max_cosine = more uncovered
        for i, (cid, s) in enumerate(src):
            mc = max(_cos(svecs[i], fv) for fv in fvecs)
            if mc >= cover_floor:
                continue  # already covered by a fact
            if _topk_mean(svecs[i], uvecs) < user_floor:
                continue  # not user-relevant → narrative/fiction noise, not a salient gap
            gaps.append((mc, cid, s))
        if not gaps:
            store.close()
            return 0
        gaps.sort(key=lambda g: (g[0], g[1]))  # most-uncovered first; cid tie-break (deterministic)
        added = 0
        tx = store.begin_tx("coverage-gapfill")
        for mc, cid, s in gaps[:max_fill]:
            ent = _extract_entity_from_fact(s, []) or "general"
            fid = _fact_id(ent, "gapfill", s)
            if store.entity(fid):
                continue
            store.assert_triple(tx, fid, "entity", ent)
            store.assert_triple(tx, fid, "attribute", "gapfill")
            store.assert_triple(tx, fid, "value", s)
            store.assert_triple(tx, fid, "kind", "gapfill")
            store.assert_triple(tx, fid, "confidence", "0.75")
            store.assert_triple(tx, fid, "first_seen", _now_iso())
            for tag in _extract_tags(s):
                store.assert_triple(tx, fid, "tag", tag)
            added += 1
        store.commit_tx(tx)
        store.close()
        if added:
            print(f"  [gapfill] added {added} coverage gap-fill fact(s)", file=sys.stderr)
        return added
    except Exception as e:  # FAIL-OPEN — never break ingestion
        print(f"  [gapfill] failed (fail-open): {e}", file=sys.stderr)
        return 0


def _recurrence_importance_graph(db_path: str, tau: float = 0.55, drop_isolated: bool = False) -> int:
    """#6b: ONLINE forward-recurrence importance (the streaming reframe of OT coverage).

    Importance is not a property of a fact in isolation — it is REVEALED OVER TIME by how much
    SUBSEQUENT content returns to a fact's semantic region. Process the source chunks in temporal
    order (sidecar chunk_id = session order); a fact's `recurrence` = the number of DISTINCT source
    chunks that contain a sentence with cos ≥ tau to it. A recurring theme the user revisits
    (mortgage, the job, mom's list) accumulates returns → high recurrence → the stable, important
    core. A one-off (a single fiction line, incidental trivia) is never revisited → recurrence≈1 →
    the volatile tail. This is the self-exciting / Hawkes-process view (one mention raises the rate
    of future mentions; importance = the excitation) and the SEMANTIC, forward-looking generalization
    of the exact-match `reinforce_count` Sinain already tracks. Unlike static coverage gap-fill, it
    needs no generic corpus and no user manifold, and it does NOT surface fiction noise (fiction
    isn't revisited).

    Writes the `recurrence` attribute on every fact (a production-usable importance signal for
    retrieval ranking / retention). With drop_isolated=True, ALSO soft-retracts the isolated
    volatile tail (recurrence ≤ 1) — but only for non-user, non-recon/gapfill facts WITHOUT a
    strong value anchor, so user facts, dated/numeric anchors and curated facts are always kept.
    Deterministic, fail-open. Gated SINAIN_RECURRENCE in the caller."""
    try:
        from triplestore import TripleStore
        from embed_client import embed
        from raw_store import _sidecar_path
        sidecar = _sidecar_path(db_path)
        if not sidecar.exists():
            return 0
        # source chunks in order; each chunk → its sentences
        chunks: list[list[str]] = []
        for line in sidecar.open():
            try:
                rec = json.loads(line)
            except Exception:
                continue
            sents = [s.strip() for s in re.split(r"(?<=[.!?])\s+", rec.get("text", ""))
                     if 12 < len(s.strip()) < 300]
            if sents:
                chunks.append(sents)
        if len(chunks) < 2:
            return 0
        store = TripleStore(db_path)
        items: list[tuple[str, str]] = []  # (fact_id, value)
        for fid, _ in store.entities_with_attr("value"):
            if not str(fid).startswith("fact:"):
                continue
            a = store.entity(fid)
            if not a or a.get("valid_to"):
                continue
            v = a.get("value", [""]); v = v[0] if isinstance(v, list) else v
            if v and isinstance(v, str) and len(v) > 8:
                items.append((fid, v))
        if not items:
            store.close()
            return 0
        fvecs = embed([v for _, v in items])
        # embed each chunk's sentences (flatten with chunk index)
        flat, owner = [], []
        for ci, sents in enumerate(chunks):
            for s in sents:
                flat.append(s); owner.append(ci)
        svecs = embed(flat)
        if not fvecs or not svecs:
            store.close()
            return 0

        def _cos(a, b) -> float:
            return sum(x * y for x, y in zip(a, b))

        # recurrence[f] = # distinct chunks with a sentence cos≥tau to f
        recur = [0] * len(items)
        for fi in range(len(items)):
            hit_chunks = set()
            fv = fvecs[fi]
            for si in range(len(flat)):
                if _cos(fv, svecs[si]) >= tau:
                    hit_chunks.add(owner[si])
            recur[fi] = len(hit_chunks)

        written = 0
        dropped = 0
        tx = store.begin_tx("recurrence-importance")
        for fi, (fid, v) in enumerate(items):
            store.assert_triple(tx, fid, "recurrence", str(recur[fi]))
            written += 1
            if drop_isolated and recur[fi] <= 1:
                if _USER_REF.search(v):
                    continue
                if _strong_value_tokens(v):
                    continue
                a = store.entity(fid)
                k = a.get("kind", [""]); k = k[0] if isinstance(k, list) else k
                if k in ("recon", "verbatim", "gapfill"):
                    continue
                store.soft_retract_triple(tx, fid)  # isolated one-off, no anchor → volatile tail
                dropped += 1
        store.commit_tx(tx)
        store.close()
        print(f"  [recurrence] scored {written} fact(s); soft-retracted {dropped} isolated one-off(s)",
              file=sys.stderr)
        return written
    except Exception as e:  # FAIL-OPEN — never break ingestion
        print(f"  [recurrence] failed (fail-open): {e}", file=sys.stderr)
        return 0


def _facts_to_graph_ops(
    digest: dict,
    transcript_speakers: list[str] | None = None,
) -> list[dict]:
    """Convert ALL distiller output + raw feed items to graph ops.

    DETERMINISTIC — no LLM needed. Stores distilled knowledge (facts,
    decisions, patterns, preferences, summary) AND verbatim raw captures
    (audio quotes, agent analysis) so the triplestore is the single
    source of truth for session recall.

    transcript_speakers: optional list of distinct speaker labels (e.g.
        ["SPEAKER_00", "SPEAKER_01"]) active in the batch that produced
        this digest. When non-empty, every distilled op gets
        op["mentioned_by"] = transcript_speakers so _execute_graph_ops
        can write mentioned_by triples. Verbatim audio ops get per-item
        speaker granularity from raw_items below. See
        .planning/phases/diarization-levers/00-PLAN.md Lever 4.
    """
    ops = []
    known_entities = digest.get("entities", [])
    raw_items = digest.pop("_rawItems", None) or []
    batch_speakers = list(transcript_speakers or [])

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
            "mentioned_by": batch_speakers,
        })

    # Facts (distilled)
    #
    # Lever 1 (2026-05-28): facts items can now be either strings (legacy) or
    # objects {text, attributedTo?, subject?}. When an object carries
    # attributedTo, route it into per-fact mentioned_by (single speaker,
    # discriminative). When a string or no attributedTo, fall back to
    # batch_speakers (Lever 4 coarse behavior preserved). When the object
    # supplies subject, prefer it over heuristic entity extraction.
    for fact_item in _salience_filter(digest.get("facts", [])):
        attributed_to: str | None = None
        explicit_subject: str | None = None
        if isinstance(fact_item, str):
            fact_text = fact_item
        elif isinstance(fact_item, dict) and isinstance(fact_item.get("text"), str):
            fact_text = fact_item["text"]
            at = fact_item.get("attributedTo")
            if isinstance(at, str) and at.strip():
                attributed_to = at.strip()
            subj = fact_item.get("subject")
            if isinstance(subj, str) and subj.strip():
                explicit_subject = subj.strip()
        else:
            # Defensive coercion (pre-2026-05-28 path): local distillers
            # sometimes emit non-string facts (dicts for typed SPO triples,
            # bools, ints). JSON-stringify so length checks + storage work.
            try:
                fact_text = json.dumps(fact_item, ensure_ascii=False)
            except (TypeError, ValueError):
                fact_text = str(fact_item)

        if not fact_text or len(fact_text) < 5:
            continue
        entity = explicit_subject or _extract_entity_from_fact(fact_text, known_entities)
        per_fact_speakers = [attributed_to] if attributed_to else batch_speakers
        ops.append({
            "op": "assert",
            "entity": entity,
            "attribute": "value",
            "value": fact_text,
            "confidence": 0.9,
            "kind": (fact_item.get("kind") if isinstance(fact_item, dict)
                     and fact_item.get("kind") else "distilled"),
            "session_ref": session_eid,
            "mentioned_by": per_fact_speakers,
        })

    # Decisions (distilled, lower confidence — time-bound)
    for decision_text in digest.get("decisions", []):
        if not isinstance(decision_text, str):
            try:
                decision_text = json.dumps(decision_text, ensure_ascii=False)
            except (TypeError, ValueError):
                decision_text = str(decision_text)
        if not decision_text or len(decision_text) < 5:
            continue
        entity = _extract_entity_from_fact(decision_text, known_entities)
        ops.append({
            "op": "assert",
            "entity": entity,
            "attribute": "value",
            "value": decision_text,
            "confidence": 0.7,
            "kind": "distilled",
            "session_ref": session_eid,
            "mentioned_by": batch_speakers,
        })

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
            "mentioned_by": batch_speakers,
        })

    # Verbatim audio quotes (top 20 by length, > 30 chars). Per-item speaker
    # when present; falls back to batch-level when the source raw item has no
    # speaker field (e.g. live capture before sherpa-onnx is wired in).
    audio = [i for i in raw_items
             if i.get("source") == "audio" and len(i.get("text", "")) > 30]
    for item in sorted(audio, key=lambda x: -len(x.get("text", "")))[:20]:
        text = re.sub(r"^\[.*?\]\s*", "", item["text"])  # strip emoji prefixes
        if len(text) < 20:
            continue
        entity = _extract_entity_from_fact(text, known_entities)
        item_speaker = item.get("speaker")
        speakers_for_op = [item_speaker] if item_speaker else batch_speakers
        ops.append({
            "op": "assert",
            "entity": entity,
            "attribute": "value",
            "value": text,
            "confidence": 0.95,
            "kind": "verbatim",
            "session_ref": session_eid,
            "mentioned_by": speakers_for_op,
        })

    # Agent analysis responses (last 10, > 50 chars — verbatim).
    # Agent/openclaw sources are NOT human-spoken, so mentioned_by stays
    # batch-level (or empty) — agents are not speakers.
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
            "mentioned_by": [],
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
                # T1-SUPERSEDE bi-temporal: occurred_at = EVENT time (the session's
                # timestamp), distinct from wall-clock ingest time. Lets latest-state
                # queries pick the most-recent value by when it HAPPENED, not when it
                # was distilled. (digest_ts is the session ts in this pipeline.)
                store.assert_triple(tx, entity_id, "occurred_at", digest_ts)
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
                # Diarization Lever 4: mentioned_by triples — one per distinct
                # speaker active in the batch that produced this fact. Pure
                # graph metadata, never enters fact text. Queries opt in via
                # query_facts_hybrid(..., mentioned_by_speaker=[...]). See
                # .planning/phases/diarization-levers/00-PLAN.md
                mentioned_by = op_data.get("mentioned_by") or []
                if mentioned_by:
                    for spk in mentioned_by:
                        if spk:
                            store.assert_triple(tx, entity_id, "mentioned_by", spk)
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
                # T1-SUPERSEDE: SOFT-retract (mark valid_to) instead of hard-delete,
                # so a distiller-driven retraction is reversible and visible to
                # as-of/history queries; current-state reads exclude it.
                store.soft_retract_triple(tx, entity_id)
                stats["retracted"] += 1

        # --- Build entity graph layer (two-layer model) ---
        if digest_entities and stats["asserted"] > 0:
            try:
                # Load existing entity names for fuzzy matching
                all_entity_nodes: dict[str, str] = {}  # {name: entity_node_id}
                for r in store.entities_with_attr("name"):
                    if r[0].startswith("entity:"):
                        all_entity_nodes[r[1]] = r[0]

                # Create entity:* nodes from digest entities (with fuzzy dedup)
                entity_resolve: dict[str, str] = {}  # {normalized_name: resolved_node_id}
                for ent in (digest_entities or []):
                    if isinstance(ent, dict):
                        ename = _normalize_entity(ent.get("name", ""))
                        etype = ent.get("type", "unknown")
                    else:
                        ename = _normalize_entity(str(ent))
                        etype = "unknown"
                    if not ename or len(ename) < 2:
                        continue

                    # Check for fuzzy match against existing entities
                    matched_id = _find_matching_entity(ename, all_entity_nodes)
                    if matched_id:
                        entity_resolve[ename] = matched_id
                        if matched_id != f"entity:{ename}":
                            print(f"  [graph] alias: \"{ename}\" → {matched_id}", file=sys.stderr)
                        continue

                    entity_node_id = f"entity:{ename}"
                    existing = store.entity(entity_node_id)
                    if not existing:
                        tx = store.begin_tx("entity_graph")
                        store.assert_triple(tx, entity_node_id, "name", ename)
                        store.assert_triple(tx, entity_node_id, "type", etype)
                    all_entity_nodes[ename] = entity_node_id
                    entity_resolve[ename] = entity_node_id

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
    parser.add_argument("--transcript", default=None,
                        help="Raw transcript JSON (list of {source,text,ts} items). When provided, "
                             "the zero-LLM typed-link extractor + user-attribute extractor "
                             "run post-LLM to recover facts the distiller missed. gbrain "
                             "Proposal A pattern — topic-robust, deterministic.")
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
        fact_ids = sorted({eid for eid, _ in store.entities_with_attr("value")
                           if eid.startswith("fact:")})
        tagged = 0
        for fid in fact_ids:
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
        output_json({"retagged": tagged, "total_facts": len(fact_ids)})
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

    # Normalize digest at parse boundary. Local distillers (phi4-mini and
    # similar small models) emit list fields as dicts, bools, or nested
    # objects rather than the list[str] shape main's distiller produces.
    # Coerce here so downstream code (graph ops, playbook rendering,
    # tag extraction) can rely on the schema contract.
    digest = _normalize_digest(digest)

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

    # ── Step 0.5: Pre-parse transcript once for downstream speaker + zero-LLM use ──
    # Lever 4 (mentioned_by speaker triples) needs the distinct speaker set
    # for this batch before _facts_to_graph_ops runs. We also reuse the parsed
    # items in Step 1.5 below (zero-LLM extractors). Failing the parse here is
    # non-fatal — fall back to empty list, which preserves prior behaviour.
    transcript_items: list[dict] = []
    transcript_speakers: list[str] = []
    if args.transcript:
        try:
            transcript_items = json.loads(args.transcript)
            if not isinstance(transcript_items, list):
                transcript_items = []
            transcript_speakers = sorted({
                i.get("speaker") for i in transcript_items
                if isinstance(i, dict) and isinstance(i.get("speaker"), str) and i.get("speaker")
            })
        except (json.JSONDecodeError, TypeError):
            transcript_items = []
            transcript_speakers = []

    # ── Step 1: DETERMINISTIC graph ops from distiller output (no LLM needed) ──
    # The distiller already extracted structured facts — conversion is mechanical.
    graph_ops = _facts_to_graph_ops(digest, transcript_speakers=transcript_speakers)
    digest_ts = digest.get("ts", datetime.now(timezone.utc).isoformat())

    # ── Step 1.5: Zero-LLM typed-link + user-attribute extractor ──
    # Topic-robust safety net: weak distillers (phi4-mini, qwen2.5:7b) drop
    # first-person attribute claims when the session is crowded with other
    # content. Run the deterministic regex extractor over the raw transcript
    # to recover degree/occupation/location/duration/name/age/relation facts
    # that match high-signal patterns. Facts merge into graph_ops as ASSERT
    # ops at confidence=0.85 (below LLM-distilled 0.9 — they don't
    # dominate when both are present, but they cover gaps when LLM missed).
    if transcript_items:
        try:
            from link_extraction import extract_user_attributes, extract_auto_edges
            user_facts = extract_user_attributes(transcript_items)
            for f in user_facts:
                graph_ops.append({
                    "op": "assert",
                    "entity": f["entity"],
                    "attribute": f["attribute"],
                    "value": f["value"],
                    "confidence": f["confidence"],
                    "domain": "user",
                    "kind": f.get("kind", "auto-extracted"),
                    # Auto-extracted user attributes inherit batch-level speakers
                    # (the regex extractor doesn't know which speaker uttered
                    # the matched phrase — coarse but consistent).
                    "mentioned_by": transcript_speakers,
                })
            if user_facts:
                print(f"  [zero-llm] user-attribute extractor: +{len(user_facts)} fact(s)",
                      file=sys.stderr)

            # Entity-relationship extractor (gbrain Proposal A) — fires when
            # the distiller's entities list has >=2 entries.
            if digest_entities and len(digest_entities) >= 2:
                edges = extract_auto_edges(transcript_items, [
                    {"id": f"entity:{e.get('name', '').lower().replace(' ', '-')}",
                     "name": e.get("name", ""), "type": e.get("type", "")}
                    for e in digest_entities
                    if isinstance(e, dict) and e.get("name")
                ])
                for edge in edges:
                    graph_ops.append({
                        "op": "assert",
                        "entity": edge["subject_id"].replace("entity:", ""),
                        "attribute": edge["predicate"],
                        "value": edge.get("object_name", edge["object_id"]),
                        "confidence": edge["confidence"],
                        "domain": "entity-relationship",
                        "kind": "auto-extracted",
                        "mentioned_by": transcript_speakers,
                    })
                if edges:
                    print(f"  [zero-llm] entity-relationship extractor: +{len(edges)} edge(s)",
                          file=sys.stderr)
        except Exception as e:
            print(f"  [zero-llm] extractor failed (non-fatal): {e}", file=sys.stderr)

    # Dedup + execute
    graph_stats = _execute_graph_ops(db_path, graph_ops, digest_ts, digest_entities=digest_entities)

    # Option A (PRODUCTION raw-episodic storage): append this batch's raw
    # transcript as a chunk so retrieval can recover detail the lossy distiller
    # dropped (the gold often survives in the transcript even when distillation
    # omits it). Gated SINAIN_RAW_CHUNKS (default on). Skipped for bench temp
    # dirs — bench stores chunks via ingest.py at the cache path (a temp-dir
    # sidecar would be lost in the cache copytree).
    if os.environ.get("SINAIN_RAW_CHUNKS", "1") != "0" and transcript_items \
            and "sinain-bench-" not in str(db_path):
        try:
            from raw_store import append_chunks
            _txt = "\n".join(
                (it.get("text") or it.get("content") or "")
                for it in transcript_items if isinstance(it, dict)
            ).strip()
            if _txt:
                append_chunks(db_path, [_txt])
        except Exception as e:
            print(f"  [raw_store] append failed (non-fatal): {e}", file=sys.stderr)

    # ── Step 1.7: Write-time typed-edge category enrichment (SINAIN_TYPED_EDGES) ──
    # Type user-action objects with their category AT WRITE TIME — reusing the
    # distiller's configured model (category_enrichment.type_categories →
    # call_llm(script="session_distiller"), so ONE model in any mode, never a 2nd
    # resident model / 2nd local stream). Recall: broad SVO over raw ∪ distilled.
    # Precision: the typer's taxonomic labels (bookshelf→furniture) baked in now.
    # Read time (graph_query / reductions) then resolves "how many X" by a pure
    # structural backrefs walk over category:* hubs — no read-time LLM. Fail-open.
    if os.environ.get("SINAIN_TYPED_EDGES") == "1":
        try:
            from category_enrichment import enrich, type_categories, persist_typed_edges
            _raw = [(it.get("text") or it.get("content") or "")
                    for it in transcript_items if isinstance(it, dict)]
            _dist = [(f.get("text") if isinstance(f, dict) else f)
                     for f in (digest.get("facts") or [])]
            _edges = enrich(_dist, _raw, gate=False)
            if _edges:
                _typed = type_categories(_edges)
                n_obj, n_edge = persist_typed_edges(db_path, _typed, digest_ts)
                _ncat = len({c for e in _typed for c in e.get("categories", [])})
                print(f"  [typed-edges] {n_obj} action-objects, {_ncat} categories, "
                      f"{n_edge} membership edges", file=sys.stderr)
        except Exception as e:
            print(f"  [typed-edges] failed (non-fatal): {e}", file=sys.stderr)

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
        # Defensive coercion 2026-05-27: local distillers can emit dict/list
        # facts (typed graph triples) rather than English sentences. Coerce
        # to string so the playbook formatting and log slice don't crash.
        fact_str = fact if isinstance(fact, str) else json.dumps(fact, ensure_ascii=False)
        fact_tags = set(_extract_tags(fact_str))
        # Only add if no existing playbook line covers this
        if not any(set(_extract_tags(l)) & fact_tags for l in playbook_lines if len(fact_tags) > 1):
            new_line = f"- {fact_str} (seen 1)"
            updated_lines.append(new_line)
            changes["added"].append(fact_str[:60])

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
