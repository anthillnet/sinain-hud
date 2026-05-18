#!/usr/bin/env python3
"""Graph Query — entity-based lookup of knowledge graph facts.

Thin wrapper around triplestore.py for querying facts by entity/domain.
Used by sinain-core (via HTTP endpoint) and sinain-mcp-server (via subprocess).

Usage:
    python3 graph_query.py --db memory/knowledge-graph.db \
        --entities '["react-native", "metro-bundler"]' \
        [--max-facts 5] [--format text|json]
"""

import argparse
import json
import sys
from pathlib import Path


def query_facts_by_entities(
    db_path: str,
    entities: list[str],
    max_facts: int = 5,
) -> list[dict]:
    """Query knowledge graph for facts matching keywords via tag index.

    Uses auto-extracted 'tag' attributes for discovery. Results ranked by
    number of matching tags (more matches = more relevant). Falls back to
    domain/entity_id matching for untagged facts.
    """
    if not Path(db_path).exists():
        return []

    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)

        # Normalize keywords for tag matching
        keywords = [e.lower().replace(" ", "-") for e in entities]
        placeholders = ",".join(["?" for _ in keywords])

        # Primary: tag-based ranked search (AVET index)
        rows = store._conn.execute(
            f"""SELECT entity_id, COUNT(*) as matches
                FROM triples
                WHERE attribute = 'tag' AND NOT retracted
                AND value IN ({placeholders})
                GROUP BY entity_id
                ORDER BY matches DESC
                LIMIT ?""",
            (*keywords, max_facts * 3),
        ).fetchall()

        fact_ids = [r["entity_id"] for r in rows]

        # Fallback: if tags found < max_facts, also search domain/entity_id (for untagged facts)
        if len(fact_ids) < max_facts:
            domain_placeholders = ",".join(["?" for _ in keywords])
            like_clauses = " OR ".join([f"entity_id LIKE ?" for _ in keywords])
            entity_likes = [f"fact:{kw}%" for kw in keywords]

            fallback_rows = store._conn.execute(
                f"""SELECT DISTINCT entity_id FROM triples
                    WHERE NOT retracted AND entity_id NOT IN ({','.join(['?' for _ in fact_ids]) or "''"})
                    AND (
                        (attribute = 'domain' AND value IN ({domain_placeholders}))
                        OR ({like_clauses})
                    )
                    LIMIT ?""",
                (*fact_ids, *keywords, *entity_likes, max_facts - len(fact_ids)),
            ).fetchall()
            fact_ids.extend(r["entity_id"] for r in fallback_rows)

        # Load full attributes for each fact
        facts = []
        for fid in fact_ids:
            attrs = store.entity(fid)
            if not attrs:
                continue
            fact = {"entity_id": fid}
            for attr_name, values in attrs.items():
                if attr_name == "tag":
                    continue  # Don't include tags in output (noise)
                fact[attr_name] = values[0] if len(values) == 1 else values
            facts.append(fact)

        # Sort by confidence descending (tag ranking already done in SQL)
        facts.sort(key=lambda f: float(f.get("confidence", "0")), reverse=True)
        store.close()
        return facts[:max_facts]
    except Exception as e:
        print(f"[warn] Graph query failed: {e}", file=sys.stderr)
        return []


def query_top_facts(db_path: str, limit: int = 30) -> list[dict]:
    """Query top-N facts by confidence for knowledge doc rendering."""
    if not Path(db_path).exists():
        return []

    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)

        rows = store._conn.execute(
            """SELECT entity_id, CAST(value AS REAL) as conf
               FROM triples
               WHERE attribute = 'confidence' AND NOT retracted
               AND entity_id LIKE 'fact:%'
               ORDER BY conf DESC
               LIMIT ?""",
            (limit,),
        ).fetchall()

        facts = []
        for row in rows:
            fid = row["entity_id"]
            attrs = store.entity(fid)
            if not attrs:
                continue
            fact = {"entity_id": fid}
            for attr_name, values in attrs.items():
                fact[attr_name] = values[0] if len(values) == 1 else values
            facts.append(fact)

        store.close()
        return facts
    except Exception as e:
        print(f"[warn] Graph top-facts query failed: {e}", file=sys.stderr)
        return []


def query_facts_fts(db_path: str, query: str, max_facts: int = 10) -> list[dict]:
    """Full-text search on fact values via FTS5 index.

    Returns facts whose value field matches the query keywords.
    Falls back to LIKE search if FTS5 is not available.
    """
    if not Path(db_path).exists():
        return []

    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)

        # Try FTS5 first
        try:
            rows = store._conn.execute(
                """SELECT DISTINCT t.entity_id
                   FROM triples_fts fts
                   JOIN triples t ON fts.rowid = t.id
                   WHERE triples_fts MATCH ?
                     AND t.attribute = 'value'
                     AND NOT t.retracted
                   LIMIT ?""",
                (query, max_facts),
            ).fetchall()
        except Exception:
            # FTS5 not available — fall back to LIKE search
            keywords = [w.lower() for w in query.split() if len(w) > 2]
            if not keywords:
                store.close()
                return []
            # Match any keyword in value
            conditions = " OR ".join(["LOWER(value) LIKE ?"] * len(keywords))
            params = [f"%{k}%" for k in keywords] + [max_facts]
            rows = store._conn.execute(
                f"""SELECT DISTINCT entity_id
                    FROM triples
                    WHERE attribute = 'value'
                      AND NOT retracted
                      AND ({conditions})
                    LIMIT ?""",
                params,
            ).fetchall()

        entity_ids = [r["entity_id"] for r in rows]
        if not entity_ids:
            store.close()
            return []

        # Fetch full attributes for matched entities
        facts = []
        for eid in entity_ids:
            attrs = store.entity(eid)
            fact = {"entity_id": eid, "entity": eid.split(":")[-1].rsplit("-", 1)[0] if ":" in eid else eid}
            for attr, values in attrs.items():
                if attr == "tag":
                    continue
                fact[attr] = values[0] if len(values) == 1 else values
            facts.append(fact)

        store.close()
        return facts[:max_facts]
    except Exception:
        return []


def query_facts_by_entity_graph(
    db_path: str,
    entity_name: str,
    max_facts: int = 10,
) -> list[dict]:
    """Find facts about an entity via VAET backref traversal.

    Uses the entity graph layer: entity:* nodes linked to fact:* nodes
    via 'about' ref edges. Also follows 'mentions' ref edges for
    cross-entity context.
    """
    if not Path(db_path).exists():
        return []

    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)

        entity_node_id = f"entity:{entity_name.lower().replace(' ', '-')}"
        if not store.entity(entity_node_id):
            store.close()
            return []

        # Get all facts linked to this entity via "about" ref edge
        fact_refs = store.backrefs(entity_node_id, attribute="about")
        # Also get facts that "mention" this entity
        mention_refs = store.backrefs(entity_node_id, attribute="mentions")
        all_refs = fact_refs + mention_refs

        # Load fact details
        seen = set()
        facts = []
        for fact_eid, _ in all_refs:
            if fact_eid in seen or not fact_eid.startswith("fact:"):
                continue
            seen.add(fact_eid)
            attrs = store.entity(fact_eid)
            if attrs and "value" in attrs:
                fact = {"entity_id": fact_eid}
                for attr, values in attrs.items():
                    if attr == "tag":
                        continue
                    fact[attr] = values[0] if len(values) == 1 else values
                facts.append(fact)

        store.close()
        return facts[:max_facts]
    except Exception:
        return []


def expand_entity_community(
    store,
    entity_name: str,
    max_related: int = 3,
    max_facts_per_entity: int = 30,
) -> list[tuple[str, int]]:
    """Find related entities by following entity → facts → mentioned entities.

    Returns [(entity_name, co_mention_count), ...] sorted by frequency.
    """
    entity_node_id = f"entity:{entity_name.lower().replace(' ', '-')}"
    if not store.entity(entity_node_id):
        return []

    # Collect facts linked to this entity (both about and mentions)
    fact_ids = set()
    for fact_eid, _ in store.backrefs(entity_node_id, attribute="about")[:max_facts_per_entity]:
        if fact_eid.startswith("fact:"):
            fact_ids.add(fact_eid)
    for fact_eid, _ in store.backrefs(entity_node_id, attribute="mentions")[:max_facts_per_entity]:
        if fact_eid.startswith("fact:"):
            fact_ids.add(fact_eid)

    # Follow each fact's outgoing refs to find other entity nodes
    related_counts: dict[str, int] = {}
    for fact_eid in fact_ids:
        attrs = store.entity(fact_eid)
        for ref_attr in ("about", "mentions"):
            targets = attrs.get(ref_attr, [])
            if not isinstance(targets, list):
                targets = [targets]
            for target in targets:
                if isinstance(target, str) and target.startswith("entity:") and target != entity_node_id:
                    name = target[len("entity:"):]
                    related_counts[name] = related_counts.get(name, 0) + 1

    # Sort by frequency, return top N
    ranked = sorted(related_counts.items(), key=lambda x: -x[1])
    return ranked[:max_related]


def _cooccurring_entities(
    store,
    fact_ids: set[str],
    max_entities: int = 3,
) -> list[str]:
    """Find entities that co-occur in the same distillation pass (shared first_seen timestamp)."""
    if not fact_ids:
        return []

    # Get first_seen timestamps for the input facts
    timestamps = set()
    for fid in list(fact_ids)[:20]:  # cap to avoid huge queries
        attrs = store.entity(fid)
        fs = attrs.get("first_seen", [])
        if isinstance(fs, list) and fs:
            timestamps.add(fs[0])
        elif isinstance(fs, str):
            timestamps.add(fs)

    if not timestamps:
        return []

    # Find other facts with same timestamps and extract their entity names
    placeholders = ",".join("?" for _ in timestamps)
    rows = store._conn.execute(
        f"SELECT DISTINCT t2.value FROM triples t1 "
        f"JOIN triples t2 ON t2.entity_id = t1.entity_id AND t2.attribute = 'entity' AND t2.retracted = 0 "
        f"WHERE t1.attribute = 'first_seen' AND t1.value IN ({placeholders}) "
        f"AND t1.retracted = 0 AND t1.entity_id LIKE 'fact:%' "
        f"AND t1.entity_id NOT IN ({','.join('?' for _ in fact_ids)})",
        list(timestamps) + list(fact_ids),
    ).fetchall()

    # Count co-occurrence per entity name
    counts: dict[str, int] = {}
    for (name,) in rows:
        counts[name] = counts.get(name, 0) + 1
    ranked = sorted(counts, key=lambda x: -counts[x])
    return ranked[:max_entities]


_SEMANTIC_CACHE: dict = {}  # {"db_path": {"names": [...], "embs": ndarray, "ts": float}}


def _expand_keywords_semantic(
    keywords: list[str],
    db_path: str,
    threshold: float = 0.50,
    max_expansions: int = 3,
) -> list[str]:
    """Expand keywords with semantically similar entity names from the graph.

    "AI" → ["ai", "machine-learning", "ai-agents", ...]. Caches model + entity
    embeddings for fast repeated calls (<50ms after first load).
    """
    import time as _t
    try:
        from sentence_transformers import SentenceTransformer
        import numpy as np
        from triplestore import TripleStore

        if not hasattr(_expand_keywords_semantic, "_model"):
            _expand_keywords_semantic._model = SentenceTransformer("all-MiniLM-L6-v2")
        model = _expand_keywords_semantic._model

        # Cache entity names + embeddings (refresh every 5 min)
        cache = _SEMANTIC_CACHE.get(db_path)
        if not cache or _t.time() - cache["ts"] > 300:
            store = TripleStore(db_path)
            entity_names = [n for eid, n in store.entities_with_attr("name")
                            if eid.startswith("entity:") and len(n) >= 4]
            store.close()
            if not entity_names:
                return keywords
            entity_embs = model.encode(entity_names, show_progress_bar=False)
            _SEMANTIC_CACHE[db_path] = {"names": entity_names, "embs": entity_embs, "ts": _t.time()}
            cache = _SEMANTIC_CACHE[db_path]

        entity_names = cache["names"]
        entity_embs = cache["embs"]

        kw_embs = model.encode(keywords, show_progress_bar=False)

        expanded = list(keywords)
        for i, kw in enumerate(keywords):
            # Skip expansion for very short keywords — embeddings are unreliable
            # for abbreviations like "ml", "ai" (use community detection instead)
            if len(kw) < 4:
                continue
            sims = []
            for j, name in enumerate(entity_names):
                if name == kw or name in expanded:
                    continue
                sim = float(np.dot(kw_embs[i], entity_embs[j]) /
                            (np.linalg.norm(kw_embs[i]) * np.linalg.norm(entity_embs[j]) + 1e-9))
                if sim >= threshold:
                    sims.append((name, sim))
            sims.sort(key=lambda x: -x[1])
            expanded.extend(name for name, _ in sims[:max_expansions])

        return expanded
    except (ImportError, Exception):
        return keywords


# Re-export the canonical schema constants from query_params so existing
# imports (tests, callers) keep working. The actual definitions live in
# query_params.py — that's the single source of truth for the parameter API.
from query_params import (
    FORMATS as _FORMATS,
    PRECISION_MODES as _PRECISION_MODES,
    TEMPORAL_MODES as _TEMPORAL_MODES,
    validate_query_params as _validate_query_params,
)


def _apply_confidence_floor(facts: list[dict], floor: float) -> list[dict]:
    """Drop facts whose decayed confidence is below `floor`.

    Uses decayed_confidence so a 0.8 fact that has aged past its half-life
    gets filtered out by a moderate floor — fresh facts get more leeway.
    """
    if floor <= 0.0:
        return facts
    from triplestore import decayed_confidence
    kept = []
    for f in facts:
        try:
            conf = float(f.get("confidence", 0.5))
        except (ValueError, TypeError):
            conf = 0.5
        created = str(f.get("first_seen", "")) or str(f.get("created_at", ""))
        eff = decayed_confidence(conf, created) if created else conf
        if eff >= floor:
            kept.append(f)
    return kept


def _enrich_temporal(facts: list[dict], db_path: str) -> list[dict]:
    """Attach occurred_start / occurred_end / mentioned_at to each fact dict.

    Temporal columns live on triple rows, not in the attribute dict returned by
    store.entity(). Bulk-fetch them here in one query so the filter has the data
    it needs without N round-trips.
    """
    entity_ids = [f.get("entity_id", "") for f in facts if f.get("entity_id")]
    if not entity_ids:
        return facts
    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)
        temporal = store.temporal_fields_for(entity_ids)
        store.close()
    except Exception:
        return facts
    for f in facts:
        eid = f.get("entity_id", "")
        if eid in temporal:
            for k, v in temporal[eid].items():
                # Only fill keys not already present so an explicit override sticks.
                if k not in f:
                    f[k] = v
    return facts


def _apply_temporal_filter(
    facts: list[dict],
    mode: str,
    as_of: str | None,
    db_path: str | None = None,
) -> list[dict]:
    """Filter and boost facts based on temporal_mode.

    - "current": keep facts where occurred_end IS NULL or occurred_end > now()
    - "historical": no filter, but reorder by proximity of occurred_start to
      as_of (when provided) so the most contemporaneous facts surface first.
      Facts without occurred_start are kept but ranked at the tail.
    - "any": no-op
    """
    if mode == "any":
        return facts
    if db_path:
        facts = _enrich_temporal(facts, db_path)
    from datetime import datetime, timezone
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    if mode == "current":
        kept = []
        for f in facts:
            occ_end = f.get("occurred_end")
            if occ_end is None or (isinstance(occ_end, str) and occ_end > now_iso):
                kept.append(f)
        return kept
    if mode == "historical":
        if not as_of:
            return facts  # nothing to anchor against
        try:
            anchor = datetime.fromisoformat(as_of.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            return facts
        # Sort by absolute distance between occurred_start and anchor.
        # Facts without occurred_start get pushed to the tail via a large
        # sentinel — they're still returned, just deprioritized.
        def _distance(f: dict) -> float:
            os = f.get("occurred_start")
            if not os or not isinstance(os, str):
                return 10 ** 9  # tail sentinel
            try:
                d = datetime.fromisoformat(os.replace("Z", "+00:00"))
            except (ValueError, TypeError):
                return 10 ** 9
            return abs((d - anchor).total_seconds())
        return sorted(facts, key=_distance)
    return facts


def _format_results(
    facts: list[dict],
    format: str,
    db_path: str,
) -> list[dict] | str:
    """Format retrieval output for the caller.

    - "facts": current list[dict] shape (default, unchanged).
    - "triples": list of EAV records including temporal columns.
    - "structured": nested dict per fact with provenance, temporal bounds,
       supporting facts, and source session reference. Deterministic — no LLM.
    - "narrative": per-entity LLM-summarized briefs grouped by canonical entity,
       cached by (canonical_id, mentioned_at) with a 1h TTL.
    """
    if format == "facts":
        return facts
    if format == "triples":
        out = []
        for f in facts:
            out.append({
                "entity_id": f.get("entity_id", ""),
                "entity": f.get("entity", ""),
                "attribute": "value",
                "value": f.get("value", ""),
                "value_type": "string",
                "confidence": f.get("confidence", ""),
                "occurred_start": f.get("occurred_start"),
                "occurred_end": f.get("occurred_end"),
                "mentioned_at": f.get("mentioned_at"),
            })
        return out
    if format == "structured":
        return _format_structured(facts, db_path)
    if format == "narrative":
        return _format_narrative(facts, db_path)
    return facts


def _format_structured(facts: list[dict], db_path: str) -> list[dict]:
    """Deterministic rich format: fact + temporal + provenance + linked entities.

    Pulls extra metadata for each fact in two batched queries (one for ref
    edges, one for session references) so this stays cheap even for 10+ facts.
    Designed for OpenClaw-style escalation: the consumer gets enough context
    to reason about provenance and supporting facts without a second round-trip.
    """
    if not facts:
        return []
    fact_ids = [f.get("entity_id", "") for f in facts if f.get("entity_id")]
    if not fact_ids:
        return [dict(f) for f in facts]

    # Bulk-load ref edges (about/mentions/session) for all facts in one query
    refs_by_fact: dict[str, list[tuple[str, str]]] = {}
    sessions_by_fact: dict[str, str | None] = {}
    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)
        placeholders = ",".join("?" for _ in fact_ids)
        rows = store._conn.execute(
            f"SELECT entity_id, attribute, value FROM triples "
            f"WHERE entity_id IN ({placeholders}) "
            f"AND value_type = 'ref' AND retracted = 0",
            tuple(fact_ids),
        ).fetchall()
        for r in rows:
            eid = r["entity_id"]
            attr = r["attribute"]
            val = r["value"]
            if attr == "session":
                sessions_by_fact[eid] = val
            else:
                refs_by_fact.setdefault(eid, []).append((attr, val))
        store.close()
    except Exception:
        pass

    out = []
    for f in facts:
        eid = f.get("entity_id", "")
        out.append({
            "fact_id": eid,
            "text": f.get("value", ""),
            "entity": f.get("entity", ""),
            "confidence": f.get("confidence", ""),
            "kind": f.get("kind", "distilled"),
            "when_occurred": {
                "start": f.get("occurred_start"),
                "end": f.get("occurred_end"),
            },
            "last_mentioned": f.get("mentioned_at"),
            "first_seen": f.get("first_seen"),
            "links": [
                {"relation": rel, "target": tgt}
                for rel, tgt in refs_by_fact.get(eid, [])
            ],
            "source_session": sessions_by_fact.get(eid),
            "reinforce_count": f.get("reinforce_count", "1"),
        })
    return out


def _narrative_cache_ttl_seconds() -> int:
    """How long an entity-brief cache entry lives. 1h matches mentioned_at granularity."""
    return 3600


_NARRATIVE_PROMPT = """\
You are summarizing what is currently known about a single entity for an AI agent's \
working context. Produce ONE concise narrative (1-2 sentences) that integrates the \
provided facts.

Rules:
- Lead with the entity's current state. Mention past states only if they add context.
- Preserve temporal evolution explicitly when facts show change over time.
- Cite specific dates/numbers when they appear in source facts.
- Do not invent details not present in the facts.
- Aim for 30-60 words — dense, not exhaustive.

Respond with ONLY the narrative sentence(s). No JSON, no preamble."""


def _format_narrative(facts: list[dict], db_path: str) -> list[dict]:
    """Per-entity LLM-summarized brief with TTL cache.

    Groups facts by entity, renders a 1-2 sentence brief per entity via LLM,
    and caches per (entity_name, latest mentioned_at) so repeated queries on
    the same entity in the same hour don't re-pay the LLM cost.
    """
    if not facts:
        return []
    # Group by entity
    by_entity: dict[str, list[dict]] = {}
    for f in facts:
        ent = f.get("entity") or "unknown"
        if isinstance(ent, list):
            ent = ent[0] if ent else "unknown"
        by_entity.setdefault(str(ent), []).append(f)

    out = []
    for entity_name, group in by_entity.items():
        # Cache key: entity + max(mentioned_at). When any fact about this
        # entity is reinforced, mentioned_at advances and the cache invalidates.
        latest_mention = max(
            (f.get("mentioned_at") or f.get("first_seen") or "" for f in group),
            default="",
        )
        cache_key = (entity_name, latest_mention)
        cached = _narrative_cache_lookup(cache_key)
        if cached is not None:
            out.append({
                "entity": entity_name,
                "brief": cached,
                "fact_count": len(group),
                "cache_hit": True,
            })
            continue

        brief = _generate_narrative_brief(entity_name, group)
        _narrative_cache_store(cache_key, brief)
        out.append({
            "entity": entity_name,
            "brief": brief,
            "fact_count": len(group),
            "cache_hit": False,
        })
    return out


# Process-local TTL cache for narrative briefs. {(entity, mention_ts): (text, expires_at)}
_NARRATIVE_CACHE: dict[tuple, tuple[str, float]] = {}


def _narrative_cache_lookup(key: tuple) -> str | None:
    """Return cached brief if still within TTL, else None."""
    import time as _time
    entry = _NARRATIVE_CACHE.get(key)
    if entry is None:
        return None
    text, expires_at = entry
    if _time.time() < expires_at:
        return text
    # Lazy eviction
    _NARRATIVE_CACHE.pop(key, None)
    return None


def _narrative_cache_store(key: tuple, text: str) -> None:
    """Insert a brief into the TTL cache."""
    import time as _time
    _NARRATIVE_CACHE[key] = (text, _time.time() + _narrative_cache_ttl_seconds())


def _generate_narrative_brief(entity_name: str, facts: list[dict]) -> str:
    """LLM-summarize facts about an entity into a 1-2 sentence brief.

    Falls back to a templated "entity: fact; fact; fact" join when the LLM
    is unavailable — keeps the format usable in sandboxed or offline contexts.
    """
    try:
        from common import call_llm_with_fallback, LLMError
    except Exception:
        return _fallback_brief(entity_name, facts)

    numbered = "\n".join(
        f"- {f.get('value', '')}" + (
            f" [{f.get('occurred_start')} → {f.get('occurred_end') or 'now'}]"
            if f.get("occurred_start") else ""
        )
        for f in facts[:10]
    )
    user_prompt = f"Entity: {entity_name}\n\nFacts:\n{numbered}"
    try:
        return call_llm_with_fallback(
            _NARRATIVE_PROMPT,
            user_prompt,
            script="narrative_brief",
            json_mode=False,
        ).strip()
    except (ValueError, LLMError, Exception):
        return _fallback_brief(entity_name, facts)


def _fallback_brief(entity_name: str, facts: list[dict]) -> str:
    """Deterministic fallback when the LLM isn't reachable."""
    parts = []
    for f in facts[:3]:
        v = f.get("value", "")
        if v:
            parts.append(v if len(v) < 100 else v[:97] + "...")
    return f"{entity_name}: " + " ".join(parts) if parts else entity_name


def query_facts_hybrid(
    db_path: str,
    query: str,
    max_facts: int = 10,
    *,
    precision_mode: str = "balanced",
    temporal_mode: str = "any",
    confidence_floor: float = 0.0,
    hop_depth: int = 1,
    latency_budget_ms: int | None = None,
    format: str = "facts",
    as_of: str | None = None,
) -> list[dict] | str:
    """Hybrid retrieval with Reciprocal Rank Fusion (Graphiti pattern).

    Runs independent retrieval methods (FTS5, tag, top-confidence, entity-graph),
    fuses via RRF, applies temporal/confidence filters, optionally reranks, and
    optionally expands with graph neighbors.

    Parameters (keyword-only, defaults preserve historical behavior):
        precision_mode:     "fast" skips bi-encoder rerank and shrinks the
                            candidate pool. "balanced" (default) keeps current
                            behavior. "precise" runs a cross-encoder rerank
                            over the top RRF candidates for higher precision
                            at ~50-150 ms extra latency.
        temporal_mode:      "current" filters to facts whose occurred_end is NULL
                            or in the future. "historical" reorders by proximity
                            of occurred_start to `as_of` (or no-op without as_of).
                            "any" (default) applies no temporal filter.
        confidence_floor:   Drop facts whose decayed confidence is below this
                            threshold. Default 0.0 (no floor).
        hop_depth:          0 skips graph expansion. 1 (default) does the
                            1-hop fallback. 2/3 activate budget-constrained
                            spreading activation (~50 nodes/hop) through
                            mentions/ref edges; confidence_floor is re-applied
                            to discovered facts.
        latency_budget_ms:  Soft cap. Stages check elapsed wall time and skip
                            later work if exceeded. None = no cap (default).
        format:             "facts" (default), "triples", "structured", or
                            "narrative". structured includes provenance and
                            temporal bounds; narrative produces 1-2 sentence
                            per-entity briefs (LLM, TTL-cached).
        as_of:              ISO timestamp for point-in-time queries — anchors
                            temporal_mode=historical proximity ordering.

    Returns:
        list[dict] for format="facts"/"triples"; downstream formats may return
        other shapes in Phase 3.
    """
    _validate_query_params(precision_mode, temporal_mode, confidence_floor, hop_depth, format)

    import re
    import time
    pipeline_start = time.monotonic()

    def budget_exceeded() -> bool:
        if latency_budget_ms is None:
            return False
        return (time.monotonic() - pipeline_start) * 1000.0 > latency_budget_ms

    keywords = [w.lower() for w in re.findall(r"[a-zA-Z][a-zA-Z0-9-]+", query) if len(w) > 2]

    # Change 0: Semantic entity expansion — "ML" → ["ml", "machine-learning", "ai", ...]
    expanded_keywords = keywords
    if len(keywords) >= 1:
        expanded_keywords = _expand_keywords_semantic(keywords, db_path)

    # Entity graph pre-filter with per-entity tracking for intersection (Change A)
    graph_fact_ids: set[str] = set()
    graph_intersection: set[str] = set()
    community_fact_ids: set[str] = set()
    per_entity_facts: dict[str, set[str]] = {}
    for kw in expanded_keywords:
        kw_facts: set[str] = set()
        for f in query_facts_by_entity_graph(db_path, kw, max_facts=50):
            eid = f.get("entity_id", "")
            if eid:
                kw_facts.add(eid)
                graph_fact_ids.add(eid)
        if kw_facts:
            per_entity_facts[kw] = kw_facts

    # Compute intersection: facts linked to ALL original query keywords
    if len(per_entity_facts) >= 2:
        try:
            graph_intersection = set.intersection(*per_entity_facts.values())
        except TypeError:
            pass

    # Community expansion: follow mentions edges to find related entities
    t0 = time.monotonic()
    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)

        matched_entities = set()
        for kw in expanded_keywords:
            node_id = f"entity:{kw}"
            if store.entity(node_id):
                matched_entities.add(kw)

        for ent in matched_entities:
            if time.monotonic() - t0 > 0.5:
                break
            community = expand_entity_community(store, ent, max_related=3)
            for related_name, _count in community:
                for f in query_facts_by_entity_graph(db_path, related_name, max_facts=20):
                    eid = f.get("entity_id", "")
                    if eid and eid not in graph_fact_ids:
                        community_fact_ids.add(eid)

        store.close()
    except Exception:
        pass

    # Run retrieval methods independently.
    # precision_mode=fast shrinks the candidate pool to keep wall time predictable;
    # precise widens it so cross-encoder rerank (Phase 3) has more to work with.
    if precision_mode == "fast":
        candidate_limit = max(max_facts * 2, max_facts + 5)
    elif precision_mode == "precise":
        candidate_limit = max_facts * 5
    else:
        candidate_limit = max_facts * 3

    # Change C: FTS5 AND mode for multi-keyword queries
    if len(keywords) > 1:
        fts_and_query = " AND ".join(keywords)
        fts_results = query_facts_fts(db_path, fts_and_query, max_facts=candidate_limit)
        if len(fts_results) < candidate_limit:
            fts_or = query_facts_fts(db_path, " OR ".join(keywords), max_facts=candidate_limit)
            fts_results.extend(fts_or)
    else:
        fts_results = query_facts_fts(db_path, query, max_facts=candidate_limit)

    tag_results = query_facts_by_entities(db_path, expanded_keywords, max_facts=candidate_limit) if expanded_keywords else []
    top_results = query_top_facts(db_path, limit=candidate_limit)

    # Change B: Tag intersection tier (facts tagged with ALL keywords)
    intersection_results: list[dict] = []
    if len(keywords) >= 2:
        try:
            from triplestore import TripleStore
            _istore = TripleStore(db_path)
            placeholders = ",".join("?" for _ in keywords)
            rows = _istore._conn.execute(
                f"""SELECT entity_id, COUNT(DISTINCT value) as matches
                    FROM triples WHERE attribute = 'tag' AND NOT retracted
                    AND value IN ({placeholders})
                    GROUP BY entity_id HAVING COUNT(DISTINCT value) >= ?
                    ORDER BY matches DESC LIMIT ?""",
                (*keywords, len(keywords), candidate_limit),
            ).fetchall()
            for r in rows:
                fid = r["entity_id"]
                attrs = _istore.entity(fid)
                if attrs and "value" in attrs:
                    fact = {"entity_id": fid}
                    for attr_name, values in attrs.items():
                        if attr_name != "tag":
                            fact[attr_name] = values[0] if len(values) == 1 else values
                    intersection_results.append(fact)
            _istore.close()
        except Exception:
            pass

    # Build ranked lists by entity_id
    def _ranked_ids(facts: list[dict]) -> list[str]:
        seen = set()
        out = []
        for f in facts:
            eid = f.get("entity_id", "")
            if eid and eid not in seen:
                seen.add(eid)
                out.append(eid)
        return out

    fts_ranked = _ranked_ids(fts_results)
    tag_ranked = _ranked_ids(tag_results)
    top_ranked = _ranked_ids(top_results)
    intersection_ranked = _ranked_ids(intersection_results)

    # Reciprocal Rank Fusion: RRF(d) = Σ 1/(k + rank_i(d))
    K = 60
    rrf_scores: dict[str, float] = {}
    tiers = [fts_ranked, tag_ranked, top_ranked]
    if intersection_ranked:
        tiers.append(intersection_ranked)
    for ranked_list in tiers:
        for rank, eid in enumerate(ranked_list):
            rrf_scores[eid] = rrf_scores.get(eid, 0.0) + 1.0 / (K + rank)

    # Change D: Session co-occurrence for multi-entity queries
    if len(keywords) >= 2 and time.monotonic() - t0 < 1.0:
        try:
            from triplestore import TripleStore
            _sstore = TripleStore(db_path)
            # Find sessions where facts about BOTH keywords exist
            kw_a, kw_b = keywords[0], keywords[1]
            sess_rows = _sstore._conn.execute(
                """SELECT DISTINCT t1.value as ts FROM triples t1
                   JOIN triples t2 ON t2.attribute='first_seen' AND t2.value=t1.value AND t2.retracted=0
                   WHERE t1.attribute='first_seen' AND t1.retracted=0
                   AND t1.entity_id IN (SELECT entity_id FROM triples WHERE attribute='tag' AND value=? AND NOT retracted)
                   AND t2.entity_id IN (SELECT entity_id FROM triples WHERE attribute='tag' AND value=? AND NOT retracted)
                   LIMIT 10""",
                (kw_a, kw_b),
            ).fetchall()
            if sess_rows:
                ts_values = [r[0] for r in sess_rows]
                ph = ",".join("?" for _ in ts_values)
                fact_rows = _sstore._conn.execute(
                    f"SELECT DISTINCT entity_id FROM triples WHERE attribute='first_seen' AND value IN ({ph}) AND NOT retracted AND entity_id LIKE 'fact:%' LIMIT 30",
                    ts_values,
                ).fetchall()
                for r in fact_rows:
                    eid = r[0]
                    if eid not in graph_fact_ids:
                        community_fact_ids.add(eid)
            _sstore.close()
        except Exception:
            pass

    # Graph boost with intersection bonus (Change A continued)
    if graph_fact_ids or community_fact_ids or graph_intersection:
        for eid in rrf_scores:
            if eid in graph_intersection:
                rrf_scores[eid] += 0.10  # intersection: linked to ALL queried entities
            elif eid in graph_fact_ids:
                rrf_scores[eid] += 0.05  # direct graph-linked facts
            elif eid in community_fact_ids:
                rrf_scores[eid] += 0.025  # community-expanded facts

    # Apply confidence decay as secondary signal (fresh facts rank above stale ones)
    from triplestore import decayed_confidence
    for facts_list in [fts_results, tag_results, top_results]:
        for f in facts_list:
            eid = f.get("entity_id", "")
            if eid in rrf_scores:
                conf = 0.5
                created = ""
                try:
                    conf = float(f.get("confidence", 0.5))
                    created = str(f.get("first_seen", ""))
                except (ValueError, TypeError):
                    pass
                if created:
                    effective = decayed_confidence(conf, created)
                    rrf_scores[eid] += effective * 0.01  # small boost, preserves RRF rank

    # Sort by RRF score descending
    sorted_ids = sorted(rrf_scores, key=rrf_scores.get, reverse=True)

    # Build fact lookup from all candidates
    fact_map: dict[str, dict] = {}
    for facts in [fts_results, tag_results, top_results]:
        for f in facts:
            eid = f.get("entity_id", "")
            if eid and eid not in fact_map:
                fact_map[eid] = f

    # Return top RRF candidates, optionally re-ranked by embedding similarity.
    # When called from sinain-core subprocess, embedding re-ranking happens in
    # Node.js (to avoid deadlock). When called standalone (benchmark, CLI),
    # we re-rank in-process if sentence-transformers is available.
    rrf_candidates = [fact_map[eid] for eid in sorted_ids[:max_facts * 2] if eid in fact_map]

    # Cheap filters first — pruning noise before reranking avoids paying
    # encoder cost on facts we'll drop anyway.
    rrf_candidates = _apply_confidence_floor(rrf_candidates, confidence_floor)
    rrf_candidates = _apply_temporal_filter(rrf_candidates, temporal_mode, as_of, db_path=db_path)

    results = rrf_candidates[:max_facts]

    # Bi-encoder rerank — skipped in fast mode (too slow for hot path)
    # and skipped if budget already exceeded.
    if precision_mode != "fast" and not budget_exceeded():
        try:
            from sentence_transformers import SentenceTransformer
            import numpy as np
            if not hasattr(query_facts_hybrid, "_embed_model"):
                query_facts_hybrid._embed_model = SentenceTransformer("all-MiniLM-L6-v2")
            model = query_facts_hybrid._embed_model
            texts = [query] + [f.get("value", "") for f in rrf_candidates]
            embs = model.encode(texts, show_progress_bar=False)
            q_emb = embs[0]
            scored = []
            for i, f in enumerate(rrf_candidates):
                sim = float(np.dot(q_emb, embs[i + 1]) / (np.linalg.norm(q_emb) * np.linalg.norm(embs[i + 1]) + 1e-9))
                scored.append((sim, f))
            scored.sort(key=lambda x: -x[0])
            results = [f for _, f in scored[:max_facts]]
        except ImportError:
            pass  # sentence-transformers not installed — use RRF order

    # precision_mode=precise activates cross-encoder reranking. Cross-encoders
    # score (query, document) pairs jointly, which captures relevance signal
    # the bi-encoder cosine misses. Cost: ~50-150ms on 30 candidates. We
    # respect the latency budget and fall back gracefully when the model is
    # missing from the environment (sandboxed installs without extra weights).
    if precision_mode == "precise" and not budget_exceeded() and len(results) > 1:
        try:
            results = _cross_encoder_rerank(query, results, top_k=max_facts)
        except Exception as e:
            print(f"[warn] cross-encoder rerank failed (non-fatal): {e}", file=sys.stderr)

    # Graph expansion. hop_depth=0 skips entirely. hop_depth=1 = current 1-hop
    # behavior. hop_depth>=2 activates budget-constrained spreading activation
    # across mentions/ref edges. We always need to keep results bounded by
    # max_facts and not_budget_exceeded so a deep query can't blow the budget.
    if hop_depth == 1 and results and len(results) < max_facts and not budget_exceeded():
        seen_ids = {f.get("entity_id", "") for f in results}
        try:
            from triplestore import TripleStore
            store = TripleStore(db_path)
            for fact in list(results):
                eid = fact.get("entity_id", "")
                if not eid:
                    continue
                neighbors = store.neighbors(eid, depth=1)
                for nid, nattrs in neighbors.items():
                    if nid not in seen_ids and len(results) < max_facts:
                        seen_ids.add(nid)
                        nfact = {"entity_id": nid, "entity": nid.split(":")[-1].rsplit("-", 1)[0] if ":" in nid else nid}
                        for attr, values in nattrs.items():
                            if attr != "tag":
                                nfact[attr] = values[0] if len(values) == 1 else values
                        results.append(nfact)
            store.close()
        except Exception:
            pass
    elif hop_depth >= 2 and results and not budget_exceeded():
        try:
            results = _multi_hop_expansion(
                db_path, results, max_facts=max_facts,
                hop_depth=hop_depth, confidence_floor=confidence_floor,
                budget_check=budget_exceeded,
            )
        except Exception as e:
            print(f"[warn] multi-hop expansion failed (non-fatal): {e}", file=sys.stderr)

    final = results[:max_facts]
    return _format_results(final, format, db_path)


def _cross_encoder_rerank(query: str, facts: list[dict], top_k: int) -> list[dict]:
    """Pairwise rerank with a cross-encoder. Loads the model lazily on first call.

    Cross-encoders are slow per-pair vs bi-encoders but score query × document
    jointly, so they catch relevance the bi-encoder cosine misses (e.g. query
    asks for "when X happened" but the bi-encoder ranks any mention of X
    equally). We only rerank the top-30 RRF survivors — running cross-encoder
    on a wide candidate pool is what makes it expensive.
    """
    from sentence_transformers import CrossEncoder
    if not hasattr(_cross_encoder_rerank, "_model"):
        # ms-marco-MiniLM-L-6-v2 is the sweet spot: ~80MB, ~50ms/query for
        # 30 candidates on CPU. For tighter bundles, a quantized ONNX
        # variant can be dropped in here without changing the call site.
        _cross_encoder_rerank._model = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")
    model = _cross_encoder_rerank._model

    # Bound the pool — pairwise scoring is O(N), keep it cheap.
    pool = facts[:30]
    pairs = [(query, f.get("value", "")) for f in pool]
    if not pairs:
        return facts
    scores = model.predict(pairs)
    ranked = sorted(zip(scores, pool), key=lambda x: -x[0])
    return [f for _, f in ranked[:top_k]]


def _multi_hop_expansion(
    db_path: str,
    seed_facts: list[dict],
    *,
    max_facts: int,
    hop_depth: int,
    confidence_floor: float,
    budget_check,
) -> list[dict]:
    """Budget-constrained spreading activation through the entity graph.

    Starts from the entities referenced by seed_facts, follows mentions/ref
    edges up to `hop_depth` levels deep, and merges newly discovered facts
    into the result set. Per-query node budget caps the total exploration to
    keep latency predictable on densely-connected graphs.

    Node budget scales with hop_depth: depth=2 visits ~50 nodes, depth=3 ~100.
    We also re-apply confidence_floor on discovered facts so a deep walk
    can't drag in stale low-confidence neighbors.
    """
    from triplestore import TripleStore

    node_budget = 50 * hop_depth  # 100 for depth=2, 150 for depth=3
    visited_entities: set[str] = set()
    seen_fact_ids: set[str] = {f.get("entity_id", "") for f in seed_facts}
    results: list[dict] = list(seed_facts)

    # Seed frontier: pull "about"/"mentions" ref targets from each seed fact
    store = TripleStore(db_path)
    try:
        frontier: set[str] = set()
        for fact in seed_facts:
            eid = fact.get("entity_id", "")
            if not eid:
                continue
            attrs = store.entity(eid)
            for attr_name, values in attrs.items():
                if attr_name in ("about", "mentions"):
                    for v in (values if isinstance(values, list) else [values]):
                        if isinstance(v, str) and v.startswith("entity:"):
                            frontier.add(v)

        for hop in range(hop_depth):
            if not frontier or budget_check() or len(visited_entities) >= node_budget:
                break
            next_frontier: set[str] = set()
            for ent_node in frontier:
                if budget_check() or len(visited_entities) >= node_budget:
                    break
                if ent_node in visited_entities:
                    continue
                visited_entities.add(ent_node)

                # Pull facts that link to this entity via about/mentions
                for src_eid, _attr in store.backrefs(ent_node):
                    if not src_eid.startswith("fact:") or src_eid in seen_fact_ids:
                        continue
                    if len(results) >= max_facts * 2:  # double-budget to leave room for rerank
                        break
                    attrs = store.entity(src_eid)
                    if not attrs:
                        continue
                    nfact = {"entity_id": src_eid}
                    for a, vs in attrs.items():
                        if a != "tag":
                            nfact[a] = vs[0] if len(vs) == 1 else vs
                    # Apply confidence floor on the hop expansion too — a
                    # cheap stale-neighbor filter that compounds over hops.
                    filtered = _apply_confidence_floor([nfact], confidence_floor)
                    if filtered:
                        results.append(filtered[0])
                        seen_fact_ids.add(src_eid)

                # Cooccurring entities feed the next hop
                for cooc_ent, _cnt in store.cooccurring(ent_node, limit=5):
                    if cooc_ent not in visited_entities:
                        next_frontier.add(cooc_ent)

            frontier = next_frontier
    finally:
        store.close()

    return results[:max_facts]


def format_facts_text(facts: list[dict], max_chars: int = 500) -> str:
    """Format facts grouped by entity for better cross-fact reasoning.

    Groups related facts under entity headers so the QA model sees
    connected context (e.g., all Citibank facts together).
    """
    if not facts:
        return ""

    # Group by entity name (strip fact: prefix and hash suffix)
    from collections import OrderedDict
    groups: OrderedDict[str, list[dict]] = OrderedDict()
    for f in facts:
        entity = f.get("entity", "")
        if isinstance(entity, list):
            entity = entity[0] if entity else ""
        if not entity:
            eid = str(f.get("entity_id", ""))
            entity = eid.split(":")[-1].rsplit("-", 1)[0] if ":" in eid else eid
        groups.setdefault(str(entity), []).append(f)

    lines = []
    total = 0
    for entity, group_facts in groups.items():
        for f in group_facts:
            value = f.get("value", "")
            conf = f.get("confidence", "?")
            count = f.get("reinforce_count", "1")

            line = f"- [{entity}] {value} (conf: {conf}, {count}x)"
            if total + len(line) > max_chars:
                return "\n".join(lines)
            lines.append(line)
            total += len(line)

    return "\n".join(lines)


def format_facts_compact(facts: list[dict], max_chars: int = 1200) -> str:
    """Encode facts for efficient escalation context injection.

    Compact format: domain/entity: value (conf, Nx)
    Inspired by mempalace AAAK compression — fits 3-5x more facts per token budget.
    """
    if not facts:
        return ""

    lines = []
    total = 0
    for f in facts:
        entity = f.get("entityId", "").split(":")[-1][:20]
        value = f.get("value", "")
        conf = f.get("confidence", "?")
        count = f.get("reinforce_count", "1")
        domain = f.get("domain", "")

        if domain:
            line = f"{domain}/{entity}: {value} ({conf},{count}x)"
        else:
            line = f"{entity}: {value} ({conf},{count}x)"

        if total + len(line) + 2 > max_chars:
            break
        lines.append(line)
        total += len(line) + 2  # account for "; " separator

    return "; ".join(lines)


def domain_fact_counts(db_path: str) -> dict[str, int]:
    """Count facts per domain for module emergence detection."""
    if not Path(db_path).exists():
        return {}

    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)

        rows = store._conn.execute(
            """SELECT value, COUNT(DISTINCT entity_id) as cnt
               FROM triples
               WHERE attribute = 'domain' AND NOT retracted
               GROUP BY value
               ORDER BY cnt DESC""",
        ).fetchall()

        store.close()
        return {r["value"]: r["cnt"] for r in rows}
    except Exception:
        return {}


_STAGE2_BOOKKEEPING = (
    "tag", "attribute", "confidence", "entity", "first_seen", "kind",
    "last_reinforced", "reinforce_count", "session", "value", "name", "type",
    "about", "mentions", "domain",
)


def query_stage2_triples(db_path: str, query: str, max_facts: int = 30) -> list[dict]:
    """Stage 4 retrieval: walk direct S-P-O triples + alias resolution.

    Bridges the post-Stage-2 graph shape to the bench's QA path. Two discovery
    paths feed into one ranked list:
      - FTS5 across triples_fts where entity_id starts with 'entity:' and
        attribute is not a bookkeeping predicate (i.e., a domain relation)
      - Alias resolution: each query token → entity_aliases lookup → walk all
        non-bookkeeping triples about each resolved canonical id

    Returns fact-shaped dicts that format_facts_compact / format_facts_text
    can render. The `value` field carries a readable "predicate object" string
    (e.g., "isSuitableFor commute") so the QA model sees the relationship
    without needing to understand the graph encoding.
    """
    if not Path(db_path).exists():
        return []

    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)
        bookkeeping_placeholders = ",".join("?" for _ in _STAGE2_BOOKKEEPING)
        rows: list = []

        # Tokenize once, used by all three paths.
        import re as _re
        _STOPWORDS = {
            "the", "is", "in", "on", "for", "and", "or", "of", "to", "a", "an",
            "it", "was", "not", "how", "what", "when", "does", "did", "do", "my",
            "your", "their", "have", "has", "had", "are", "were", "been", "being",
            "about", "from", "with", "that", "this", "which", "who", "whom",
            "where", "why", "can", "could", "would", "should", "any", "many",
            "long", "much", "before", "after",
        }
        # Single-word tokens (alphanumeric, len >= 3, not stopword).
        # NB: \b boundaries ensure individual words rather than the whole phrase.
        raw_tokens = _re.findall(r"\b[a-zA-Z][a-zA-Z0-9]{2,}\b", query.lower())
        query_tokens = [t for t in raw_tokens if t not in _STOPWORDS]

        # Path 1 (fixed): FTS5 across direct triples. The raw bench query ends with
        # "?" which FTS5 parses as a syntax error. Build an OR-query from sanitized
        # significant tokens instead. This both fixes the crash AND broadens recall.
        if query_tokens:
            fts_match = " OR ".join(query_tokens)
            try:
                fts_rows = store._conn.execute(
                    f"""SELECT t.entity_id, t.attribute, t.value, t.value_type
                        FROM triples_fts fts
                        JOIN triples t ON fts.rowid = t.id
                        WHERE triples_fts MATCH ?
                          AND t.entity_id LIKE 'entity:%'
                          AND t.attribute NOT IN ({bookkeeping_placeholders})
                          AND NOT t.retracted
                        LIMIT ?""",
                    (fts_match, *_STAGE2_BOOKKEEPING, max_facts * 2),
                ).fetchall()
                rows.extend(fts_rows)
            except Exception:
                pass

        # Path 2 (fixed): alias resolution → walk all triples about resolved
        # canonicals. Previously the regex greedily matched the entire phrase
        # as one "token" because the character class included spaces. Now we
        # iterate individual words AND adjacent 2-word pairs (for compound
        # entity names like "city bank").
        resolved_canonicals: set[str] = set()
        lookup_phrases: list[str] = list(raw_tokens)  # include stopwords for slug fallback
        # Two-word adjacent pairs (e.g., "city bank", "team city")
        for i in range(len(raw_tokens) - 1):
            lookup_phrases.append(f"{raw_tokens[i]} {raw_tokens[i+1]}")
        for phrase in lookup_phrases:
            if len(phrase) < 2:
                continue
            for canonical_id, _conf in store.resolve_alias(phrase):
                resolved_canonicals.add(canonical_id)
            slug = phrase.replace(" ", "-")
            ent_id = slug if slug.startswith("entity:") else f"entity:{slug}"
            cur = store._conn.execute(
                "SELECT 1 FROM triples WHERE entity_id = ? AND NOT retracted LIMIT 1",
                (ent_id,),
            ).fetchone()
            if cur:
                resolved_canonicals.add(ent_id)
        if resolved_canonicals:
            entity_placeholders = ",".join("?" for _ in resolved_canonicals)
            extra_rows = store._conn.execute(
                f"""SELECT entity_id, attribute, value, value_type
                    FROM triples
                    WHERE entity_id IN ({entity_placeholders})
                      AND attribute NOT IN ({bookkeeping_placeholders})
                      AND NOT retracted""",
                (*resolved_canonicals, *_STAGE2_BOOKKEEPING),
            ).fetchall()
            rows.extend(extra_rows)

        # Path 3 (fixed): predicate-name search. FTS5 indexes (entity_id, value)
        # but NOT attribute, so the predicate slot itself isn't searchable. For
        # each significant query token, match the attribute column via LIKE —
        # AND also try a stemmed singular form so "subscriptions" (plural query)
        # matches "subscriptionCount" (singular predicate).
        if query_tokens:
            stemmed: list[str] = []
            for t in query_tokens:
                stemmed.append(t)
                if len(t) > 4 and t.endswith("ies"):
                    stemmed.append(t[:-3] + "y")
                elif len(t) > 4 and t.endswith("es") and t[-3] not in "aeiou":
                    stemmed.append(t[:-2])
                elif len(t) > 3 and t.endswith("s") and not t.endswith("ss"):
                    stemmed.append(t[:-1])
            stemmed = list(dict.fromkeys(stemmed))  # dedup, preserve order
            attr_clauses = " OR ".join(["LOWER(attribute) LIKE ?"] * len(stemmed))
            like_params = [f"%{t}%" for t in stemmed]
            attr_rows = store._conn.execute(
                f"""SELECT entity_id, attribute, value, value_type
                    FROM triples
                    WHERE entity_id LIKE 'entity:%'
                      AND attribute NOT IN ({bookkeeping_placeholders})
                      AND NOT retracted
                      AND ({attr_clauses})
                    LIMIT ?""",
                (*_STAGE2_BOOKKEEPING, *like_params, max_facts * 2),
            ).fetchall()
            rows.extend(attr_rows)

        if not rows:
            store.close()
            return []

        # Resolve display names for entity references (both subject and ref-object)
        all_entities: set[str] = set()
        for r in rows:
            all_entities.add(r["entity_id"])
            if r["value_type"] == "ref" and isinstance(r["value"], str) and r["value"].startswith("entity:"):
                all_entities.add(r["value"])
        name_map: dict[str, str] = {}
        if all_entities:
            name_placeholders = ",".join("?" for _ in all_entities)
            name_rows = store._conn.execute(
                f"""SELECT entity_id, value FROM triples
                    WHERE entity_id IN ({name_placeholders})
                      AND attribute = 'schema:name'
                      AND NOT retracted""",
                tuple(all_entities),
            ).fetchall()
            name_map = {r["entity_id"]: r["value"] for r in name_rows}

        def _display(eid: str) -> str:
            if eid in name_map:
                return name_map[eid]
            return eid.split(":", 1)[1] if ":" in eid else eid

        # Render each triple as a fact-shaped dict, dedup by (subj, pred, obj)
        facts: list[dict] = []
        seen: set[tuple] = set()
        for r in rows:
            key = (r["entity_id"], r["attribute"], r["value"])
            if key in seen:
                continue
            seen.add(key)
            subj_label = _display(r["entity_id"])
            if r["value_type"] == "ref" and r["value"] in name_map:
                obj_label = name_map[r["value"]]
            elif r["value_type"] == "ref" and r["value"].startswith("entity:"):
                obj_label = r["value"].split(":", 1)[1]
            else:
                obj_label = r["value"]
            facts.append({
                "entity_id": r["entity_id"],
                "entityId": r["entity_id"],
                "entity": subj_label,
                "attribute": r["attribute"],
                "value": f"{r['attribute']} {obj_label}",
                "confidence": "1.0",
                "reinforce_count": "1",
                "kind": "stage2_triple",
                "domain": "stage2",
                "_predicate": r["attribute"],
                "_object": r["value"],
                "_value_type": r["value_type"],
            })
        store.close()
        return facts[:max_facts]
    except Exception as e:
        print(f"[warn] Stage 2 triple retrieval failed: {e}", file=sys.stderr)
        return []


def _slug_variants(query: str) -> set[str]:
    """Generate slug variations to handle 'Al Futaim' / 'al-futaim' / 'alfutaim'.

    The web search bar accepts free text but the knowledge graph stores
    content-addressed slugs. We normalize aggressively: lowercase, then
    produce hyphenated, underscored, and no-separator variants so a slug
    match works regardless of how the user typed it.
    """
    norm = "-".join(w for w in query.lower().split() if w)
    if not norm:
        return set()
    return {
        norm,
        norm.replace("-", ""),
        norm.replace("-", "_"),
        query.lower().replace(" ", ""),
    }


# English stopwords + a few internet-noise words. Per-token passes (prefix
# wildcards, tag-exact) skip these because they false-positive against the
# whole corpus — "not*" matched 518 rows in our test DB, "real*" matched 88.
# We don't filter them from the main FTS5 query because phrase-style
# multi-word matches benefit from preserving them.
_STOPWORDS = frozenset({
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "did",
    "does", "for", "from", "had", "has", "have", "he", "her", "him", "his",
    "how", "i", "if", "in", "is", "it", "its", "me", "my", "no", "not", "of",
    "on", "or", "our", "she", "so", "than", "that", "the", "their", "them",
    "then", "there", "these", "they", "this", "to", "was", "we", "were",
    "what", "when", "where", "which", "who", "why", "will", "with", "you",
    "your", "yes", "real", "true", "false",
})


def _fts5_safe_tokens(query: str) -> list[str]:
    """Strip FTS5-special chars, return clean lowercase tokens (>=2 chars).

    FTS5 treats ``"()*+-^|`` and AND/OR/NOT/NEAR as operators; raw user input
    can produce confusing results or syntax errors. We defang to a plain
    token list and re-build queries from there.
    """
    import re
    cleaned = re.sub(r"[^\w\s]", " ", query.lower(), flags=re.UNICODE)
    return [t for t in cleaned.split() if len(t) >= 2]


def _significant_tokens(query: str) -> list[str]:
    """Tokens worth running per-token passes on: non-stopword, >=3 chars."""
    return [t for t in _fts5_safe_tokens(query)
            if t not in _STOPWORDS and len(t) >= 3]


def search_entities(db_path: str, query: str, limit: int = 20) -> list[dict]:
    """High-recall entity search for the web UI search bar.

    The triplestore has **5× more FTS signal** than my first version exploited:
    FTS5 indexes the ``value`` column of *every* triple (not just facts'
    ``value`` attribute), so tags, refs (their stringified target), and
    everything else are searchable. The original predicate
    ``AND t.attribute = 'value'`` was a recall killer — most facts have ~10
    tag triples and 1 value triple, so we were dropping the bulk of the index.

    Six passes union into a ranked list:
      1. Exact entity_id slug match (variants: hyphen / underscore / no-sep)
         → score 2.0. Top of the list.
      2. entity_id LIKE substring for each variant → score 1.0. Catches
         ``fact:al-futtaim-cto-...`` when user types ``al futtaim``.
      3. FTS5 over the FULL index (no attribute filter) for the raw query.
         Per-hit score weighted by attribute: tag=0.3, value=0.2, other=0.1.
         Tags are the strongest single signal because they're auto-extracted
         keywords — a tag match is essentially "the fact is *about* this term."
      4. FTS5 prefix wildcard (``term*``) for each long token. Catches partial
         words: typing ``intel`` should reach ``intellij``.
      5. Direct tag-exact match: ``attribute='tag' AND LOWER(value) = ?``.
         Cheap, high-precision boost (+0.4) for entities deeply tagged.
      6. Snippet backfill for top-K results that landed via slug-only paths.

    Score is uncapped during accumulation but final score is rounded to 3 dp.
    Returns: [{entity, type, fact_count, snippet, score, last_seen}].
    """
    if not Path(db_path).exists() or not query.strip():
        return []

    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)

        candidates: dict[str, dict] = {}
        # Cache outgoing-ref lookups — many FTS hits hit the same fact_eid.
        ref_cache: dict[str, str | None] = {}

        def lookup_outbound_ref(fact_eid: str) -> str | None:
            if fact_eid in ref_cache:
                return ref_cache[fact_eid]
            ref_row = store._conn.execute(
                """SELECT value FROM triples
                   WHERE entity_id = ? AND value_type = 'ref' AND retracted = 0
                   LIMIT 1""",
                (fact_eid,),
            ).fetchone()
            v = ref_row["value"] if ref_row else None
            ref_cache[fact_eid] = v if v and str(v).startswith("entity:") else None
            return ref_cache[fact_eid]

        def upsert(eid: str, *, score: float = 0.0, snippet: str = "",
                   ts: str | None = None) -> dict:
            entry = candidates.setdefault(eid, {
                "entity": eid,
                "type": eid.split(":", 1)[0] if ":" in eid else "unknown",
                "score": 0.0, "fact_count": 0,
                "snippet": "", "last_seen": None,
            })
            # For exact-match scores (>=1.0) take the max; for evidence
            # contributions (<1.0) accumulate so multiple weak hits stack.
            if score >= 1.0:
                entry["score"] = max(entry["score"], score)
            else:
                entry["score"] += score
            if snippet and not entry["snippet"]:
                entry["snippet"] = snippet[:140]
            if ts and (entry["last_seen"] is None or ts > entry["last_seen"]):
                entry["last_seen"] = ts
            return entry

        # ── Pass 1: exact slug match for each variant ────────────────────
        variants = _slug_variants(query)
        for variant in variants:
            for prefix in ("entity:", "fact:"):
                eid = f"{prefix}{variant}"
                row = store._conn.execute(
                    "SELECT 1 FROM triples WHERE entity_id = ? AND retracted = 0 LIMIT 1",
                    (eid,),
                ).fetchone()
                if row:
                    upsert(eid, score=2.0)

        # ── Pass 2: entity_id substring LIKE ─────────────────────────────
        for variant in variants:
            if len(variant) < 2:
                continue
            rows = store._conn.execute(
                """SELECT DISTINCT entity_id FROM triples
                   WHERE retracted = 0
                     AND (entity_id LIKE ? OR entity_id LIKE ?)
                   LIMIT 200""",
                (f"entity:%{variant}%", f"fact:%{variant}%"),
            ).fetchall()
            for r in rows:
                upsert(r["entity_id"], score=1.0)

        # ── Pass 3: FTS5 over the FULL index (the big recall fix) ────────
        # Per-hit score weighted by attribute: tags carry the strongest
        # topical signal because they're auto-extracted keywords.
        attr_weight = {"tag": 0.3, "value": 0.2}
        try:
            fts_rows = store._conn.execute(
                """SELECT t.entity_id, t.attribute, t.value, t.created_at
                   FROM triples_fts fts
                   JOIN triples t ON fts.rowid = t.id
                   WHERE triples_fts MATCH ? AND t.retracted = 0
                   LIMIT 500""",
                (query,),
            ).fetchall()
        except Exception:
            # Defang the query and retry with cleaned tokens; fall back to
            # LIKE if FTS5 itself is unavailable.
            tokens = _fts5_safe_tokens(query)
            if tokens:
                try:
                    fts_rows = store._conn.execute(
                        """SELECT t.entity_id, t.attribute, t.value, t.created_at
                           FROM triples_fts fts JOIN triples t ON fts.rowid = t.id
                           WHERE triples_fts MATCH ? AND t.retracted = 0
                           LIMIT 500""",
                        (" ".join(tokens),),
                    ).fetchall()
                except Exception:
                    conds = " OR ".join(["LOWER(value) LIKE ?"] * len(tokens))
                    params = [f"%{t}%" for t in tokens]
                    fts_rows = store._conn.execute(
                        f"""SELECT entity_id, attribute, value, created_at FROM triples
                            WHERE retracted = 0 AND ({conds}) LIMIT 500""",
                        params,
                    ).fetchall()
            else:
                fts_rows = []

        for r in fts_rows:
            fact_eid = r["entity_id"]
            attr = r["attribute"]
            value = r["value"] or ""
            ts = r["created_at"]
            # Don't double-count: refs themselves match FTS as their target
            # entity name, but we'll surface them via the ref-following step.
            target_eid = lookup_outbound_ref(fact_eid) or fact_eid
            weight = attr_weight.get(attr, 0.1)
            # Only feed snippets from real value text — tags are noisy as
            # snippets ("citibank", "cto", ...).
            snippet_text = value if attr == "value" else ""
            entry = upsert(target_eid, score=weight,
                          snippet=snippet_text, ts=ts)
            if attr == "value":
                entry["fact_count"] += 1

        # ── Pass 4: prefix wildcards — only when Pass 3 was dry ─────────
        # "intel" → "intellij", "intelligence", etc. FTS5 prefix is
        # forward-only, so this is for partial input (still typing). For
        # multi-word queries we trust FTS5's implicit AND in Pass 3 for
        # precision; running OR'd per-token prefix here would give common
        # nouns like "real" enough hits (88+ rows) to drown signal.
        sig_tokens = _significant_tokens(query)
        if len(fts_rows) < 5 and sig_tokens:
            for token in sig_tokens:
                if len(token) < 4:
                    continue  # 3-char prefixes match too broadly
                try:
                    # Use FTS5 rank ordering so the top 300 are the most
                    # relevant by bm25, not arbitrary insertion order. This
                    # matters when a prefix like 'intel*' has thousands of
                    # matches but only ~200 are about IntelliJ/Intelligence.
                    prefix_rows = store._conn.execute(
                        """SELECT t.entity_id, t.attribute, t.value, t.created_at
                           FROM triples_fts fts JOIN triples t ON fts.rowid = t.id
                           WHERE triples_fts MATCH ? AND t.retracted = 0
                           ORDER BY rank
                           LIMIT 300""",
                        (token + "*",),
                    ).fetchall()
                except Exception:
                    prefix_rows = []
                for r in prefix_rows:
                    fact_eid = r["entity_id"]
                    target_eid = lookup_outbound_ref(fact_eid) or fact_eid
                    upsert(target_eid, score=0.05,
                          snippet=(r["value"] if r["attribute"] == "value" else ""),
                          ts=r["created_at"])

        # ── Pass 5: direct tag exact-match (high-precision boost) ────────
        # Stopword guard prevents "not"/"are"/"with" from blanket-boosting
        # entities tagged with those (which they shouldn't be, but real
        # auto-tag pipelines occasionally produce them).
        for token in sig_tokens:
            rows = store._conn.execute(
                """SELECT DISTINCT entity_id FROM triples
                   WHERE attribute = 'tag' AND LOWER(value) = ? AND retracted = 0
                   LIMIT 200""",
                (token,),
            ).fetchall()
            for r in rows:
                fact_eid = r["entity_id"]
                target_eid = lookup_outbound_ref(fact_eid) or fact_eid
                upsert(target_eid, score=0.4)

        # Compute fact_count for slug-match candidates that weren't seen via FTS.
        for eid, entry in candidates.items():
            if entry["fact_count"] == 0:
                # Count facts that reference this entity via any ref attribute.
                cnt_row = store._conn.execute(
                    """SELECT COUNT(DISTINCT entity_id) AS n FROM triples
                       WHERE value = ? AND value_type = 'ref' AND retracted = 0""",
                    (eid,),
                ).fetchone()
                entry["fact_count"] = int(cnt_row["n"]) if cnt_row else 0
                # If no incoming refs but the entity itself has triples, count
                # that as 1 for display (it's at least a real entity).
                if entry["fact_count"] == 0:
                    self_row = store._conn.execute(
                        "SELECT 1 FROM triples WHERE entity_id = ? AND retracted = 0 LIMIT 1",
                        (eid,),
                    ).fetchone()
                    if self_row:
                        entry["fact_count"] = 1

        # Round for display; no hard cap — exact matches start at 2.0 and
        # evidence accumulation below 1.0 should be allowed to sum freely so
        # entities with many independent hit types out-rank one-trick hits.
        for c in candidates.values():
            c["score"] = round(c["score"], 3)

        results = sorted(candidates.values(),
                        key=lambda x: (-x["score"], -x["fact_count"]))[:limit]

        # Backfill snippets for top results that came from slug-only matches
        # (no FTS hit on value text). Bounded to `limit` queries — cheap.
        for c in results:
            if c["snippet"]:
                continue
            if c["entity"].startswith("entity:"):
                row = store._conn.execute(
                    """SELECT t.value, t.created_at FROM triples t
                       WHERE t.attribute = 'value' AND t.retracted = 0
                         AND t.entity_id IN (
                           SELECT entity_id FROM triples
                           WHERE value = ? AND value_type = 'ref' AND retracted = 0
                           LIMIT 5
                         ) LIMIT 1""",
                    (c["entity"],),
                ).fetchone()
                if row:
                    c["snippet"] = (row["value"] or "")[:140]
                    if row["created_at"] and not c["last_seen"]:
                        c["last_seen"] = row["created_at"]
            elif c["entity"].startswith("fact:"):
                row = store._conn.execute(
                    """SELECT value, created_at FROM triples
                       WHERE entity_id = ? AND attribute = 'value' AND retracted = 0
                       LIMIT 1""",
                    (c["entity"],),
                ).fetchone()
                if row:
                    c["snippet"] = (row["value"] or "")[:140]
                    if row["created_at"] and not c["last_seen"]:
                        c["last_seen"] = row["created_at"]

        store.close()
        return results
    except Exception as e:
        sys.stderr.write(f"search_entities error: {e}\n")
        return []


def graph_children(db_path: str, entity: str, limit: int = 200) -> dict:
    """Lazy-load children of an entity for the web UI graph tree.

    Uses VAET index (backreferences via `value_type='ref'`) to find facts
    that reference this entity. Two-level grouping:

      • Top level: by edge attribute (the "kind" of relation — employed_by,
        related_to, etc.). Most data uses just one attribute, so this collapses.
      • When fact:* children dominate a group, sub-group by `domain` (people,
        projects, decisions, ...) — this is the natural Confluence-page
        taxonomy and produces a useful tree even when all edges share a name.

    Plus a "string-typed legacy refs" pass that handles installs storing the
    entity-pointer as value_type='string' (the slug) rather than as a typed ref.

    Returns: { entity, groups: [{ label, edge_attr, children: [...] }] }
    """
    if not Path(db_path).exists():
        return {"entity": entity, "groups": []}

    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)

        # Find all triples where value=entity (backref via VAET)
        rows = store._conn.execute(
            """SELECT entity_id, attribute FROM triples
               WHERE value = ? AND value_type = 'ref' AND retracted = 0
               LIMIT ?""",
            (entity, limit),
        ).fetchall()
        children_by_attr: dict[str, set[str]] = {}
        for r in rows:
            children_by_attr.setdefault(r["attribute"] or "related", set()) \
                .add(r["entity_id"])

        # Legacy string-typed refs: facts with attribute='entity', value=<slug>.
        slug_part = entity.split(":", 1)[1] if ":" in entity else entity
        legacy_rows = store._conn.execute(
            """SELECT DISTINCT entity_id FROM triples
               WHERE attribute = 'entity' AND value = ?
                 AND value_type = 'string' AND retracted = 0
               LIMIT ?""",
            (slug_part, limit),
        ).fetchall()
        for r in legacy_rows:
            children_by_attr.setdefault("entity", set()).add(r["entity_id"])

        # Pre-fetch per-child metadata (fact_count, domain, value snippet,
        # has-its-own-backrefs) in a tight loop — this is hot for big graphs.
        all_children = {c for cs in children_by_attr.values() for c in cs}
        meta: dict[str, dict] = {}
        for child_eid in all_children:
            cnt = store._conn.execute(
                "SELECT COUNT(*) AS n FROM triples WHERE entity_id = ? AND retracted = 0",
                (child_eid,),
            ).fetchone()["n"]
            domain_row = store._conn.execute(
                """SELECT value FROM triples WHERE entity_id = ?
                   AND attribute = 'domain' AND retracted = 0 LIMIT 1""",
                (child_eid,),
            ).fetchone()
            value_row = store._conn.execute(
                """SELECT value FROM triples WHERE entity_id = ?
                   AND attribute = 'value' AND retracted = 0 LIMIT 1""",
                (child_eid,),
            ).fetchone()
            backref_row = store._conn.execute(
                """SELECT 1 FROM triples WHERE value = ? AND value_type = 'ref'
                   AND retracted = 0 LIMIT 1""",
                (child_eid,),
            ).fetchone()
            meta[child_eid] = {
                "entity": child_eid,
                "fact_count": cnt,
                "domain": (domain_row["value"] if domain_row else None),
                "snippet": ((value_row["value"] or "")[:80] if value_row else ""),
                "expandable": bool(backref_row),
            }

        out_groups: list[dict] = []
        for attr, child_set in sorted(children_by_attr.items()):
            entries = [meta[c] for c in child_set if c in meta]
            attr_label = attr.replace("_", " ").title()
            fact_share = sum(1 for e in entries if e["entity"].startswith("fact:")) / max(1, len(entries))

            # Only sub-group by domain when (a) the group is big enough that
            # flat would be unwieldy, (b) it's mostly facts, AND (c) we have at
            # least one usable domain signal — otherwise everything ends up in
            # an "Uncategorized" bucket that hides the parent attribute label
            # ("About", "Mentions") which IS useful structure.
            if (len(entries) >= 8 and fact_share >= 0.7
                    and any(e.get("domain") for e in entries)):
                by_domain: dict[str, list[dict]] = {}
                for e in entries:
                    d = (e["domain"] or "other").lower()
                    by_domain.setdefault(d, []).append(e)
                for domain, group_entries in sorted(by_domain.items(),
                                                    key=lambda x: -len(x[1])):
                    out_groups.append({
                        "label": f"{attr_label}: {domain.replace('_', ' ').title()}",
                        "edge_attr": f"{attr}:{domain}",
                        "children": sorted(group_entries, key=lambda x: -x["fact_count"]),
                    })
            else:
                out_groups.append({
                    "label": f"{attr_label} ({len(entries)})",
                    "edge_attr": attr,
                    "children": sorted(entries, key=lambda x: -x["fact_count"]),
                })

        store.close()
        return {"entity": entity, "groups": out_groups}
    except Exception as e:
        sys.stderr.write(f"graph_children error: {e}\n")
        return {"entity": entity, "groups": []}


def main() -> None:
    parser = argparse.ArgumentParser(description="Graph Query")
    parser.add_argument("--db", required=True, help="Path to knowledge-graph.db")
    parser.add_argument("--entities", default=None, help="JSON array of entity/domain names")
    parser.add_argument("--query", default=None, help="Free-text query string (preferred over --entities for hybrid retrieval)")
    parser.add_argument("--top", type=int, default=None, help="Query top-N facts by confidence")
    parser.add_argument("--domain-counts", action="store_true", help="Show fact counts per domain")
    parser.add_argument("--max-facts", type=int, default=5, help="Maximum facts to return")
    parser.add_argument("--format", choices=["text", "json", "compact"], default="json", help="CLI output rendering")
    parser.add_argument("--search-entities", default=None, help="Search query for entity-prioritized lookup")
    parser.add_argument("--search-limit", type=int, default=20, help="Max entity results")
    parser.add_argument("--graph-children", default=None, help="Entity to expand for graph tree")
    parser.add_argument("--graph-limit", type=int, default=50, help="Max children per parent")

    # Phase 1-3 retrieval parameters. Defaults preserve historical behavior so
    # existing callers (sinain-core, the MCP server, eval) keep working unless
    # they explicitly opt in to a new mode.
    parser.add_argument(
        "--precision-mode", choices=sorted(_PRECISION_MODES), default="balanced",
        help="fast | balanced | precise — controls reranking cost",
    )
    parser.add_argument(
        "--temporal-mode", choices=sorted(_TEMPORAL_MODES), default="any",
        help="current | historical | any — filters/reorders by fact temporal validity",
    )
    parser.add_argument(
        "--confidence-floor", type=float, default=0.0,
        help="Drop facts with decayed confidence below this threshold (0.0-1.0)",
    )
    parser.add_argument(
        "--hop-depth", type=int, default=1,
        help="Graph expansion depth: 0=skip, 1=fallback, 2-3=spreading activation",
    )
    parser.add_argument(
        "--latency-budget-ms", type=int, default=None,
        help="Soft cap on pipeline wall time; later stages skip if exceeded",
    )
    parser.add_argument(
        "--result-format", choices=sorted(_FORMATS), default="facts",
        help="facts | triples | structured | narrative — result shape",
    )
    parser.add_argument("--as-of", default=None, help="ISO date anchor for temporal-mode=historical")
    parser.add_argument(
        "--profile", default=None,
        help="Apply a named caller profile (overridden by other flags). "
             "See query_params.QUERY_PROFILES.",
    )

    args = parser.parse_args()

    if args.search_entities is not None:
        results = search_entities(args.db, args.search_entities, limit=args.search_limit)
        score_max = max((r["score"] for r in results), default=0.0)
        print(json.dumps({"results": results, "topic_fallback": score_max < 0.4}, ensure_ascii=False))
        return

    if args.graph_children is not None:
        result = graph_children(args.db, args.graph_children, limit=args.graph_limit)
        print(json.dumps(result, ensure_ascii=False))
        return

    if args.domain_counts:
        counts = domain_fact_counts(args.db)
        print(json.dumps(counts, indent=2))
        return

    # Resolve named profile (if given) and overlay CLI flag overrides on top.
    # Order: profile defaults → explicit CLI flags. Explicit flags always win.
    hybrid_kwargs: dict = {
        "precision_mode": args.precision_mode,
        "temporal_mode": args.temporal_mode,
        "confidence_floor": args.confidence_floor,
        "hop_depth": args.hop_depth,
        "latency_budget_ms": args.latency_budget_ms,
        "format": args.result_format,
        "as_of": args.as_of,
    }
    if args.profile:
        from query_params import resolve_profile
        profile = resolve_profile(args.profile)
        # CLI flags override profile only when the user supplied a non-default
        # value. We detect this by comparing to the argparse defaults below.
        _PROFILE_OVERRIDABLE_DEFAULTS = {
            "precision_mode": "balanced",
            "temporal_mode": "any",
            "confidence_floor": 0.0,
            "hop_depth": 1,
            "latency_budget_ms": None,
            "format": "facts",
            "as_of": None,
        }
        for key, default_val in _PROFILE_OVERRIDABLE_DEFAULTS.items():
            cli_val = hybrid_kwargs[key]
            if cli_val == default_val and key in profile:
                hybrid_kwargs[key] = profile[key]

    if args.top is not None:
        facts = query_top_facts(args.db, limit=args.top)
    elif args.query is not None:
        # Preferred path — free-text query into hybrid retrieval
        facts = query_facts_hybrid(args.db, args.query, max_facts=args.max_facts, **hybrid_kwargs)
    elif args.entities:
        entities = json.loads(args.entities)
        # Use hybrid retrieval (FTS5 + tags + entity graph + RRF) for best results
        query_text = " ".join(entities)
        facts = query_facts_hybrid(args.db, query_text, max_facts=args.max_facts, **hybrid_kwargs)
        # Fallback to tag-only if hybrid returns nothing AND we used legacy defaults.
        # If the caller asked for a specific format/mode, respect the empty result.
        used_defaults = (
            args.precision_mode == "balanced" and args.temporal_mode == "any"
            and args.confidence_floor == 0.0 and args.result_format == "facts"
            and not args.profile
        )
        if not facts and used_defaults:
            facts = query_facts_by_entities(args.db, entities, max_facts=args.max_facts)
    else:
        facts = query_top_facts(args.db, limit=args.max_facts)

    if args.format == "text":
        print(format_facts_text(facts))
    elif args.format == "compact":
        print(format_facts_compact(facts))
    else:
        # facts may be a list[dict] or already a formatted structure (when
        # --result-format=narrative/structured returns nested shapes).
        print(json.dumps(
            {"facts": facts, "count": len(facts) if isinstance(facts, list) else 1},
            indent=2, ensure_ascii=False,
        ))


if __name__ == "__main__":
    main()
