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
        tag_matches = {r["entity_id"]: r["matches"] for r in rows}

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

        # Rank by tag-match count first, then confidence. A confidence-only
        # sort let many 1-tag facts at 0.9 bury a fact matching every
        # keyword at 0.7 — match count is the stronger relevance signal.
        facts.sort(
            key=lambda f: (tag_matches.get(f["entity_id"], 0),
                           float(f.get("confidence", "0"))),
            reverse=True,
        )
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
        import numpy as np
        from common import load_sentence_transformer
        from triplestore import TripleStore

        if not hasattr(_expand_keywords_semantic, "_model"):
            _expand_keywords_semantic._model = load_sentence_transformer("all-MiniLM-L6-v2")
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


def query_facts_hybrid(
    db_path: str,
    query: str,
    max_facts: int = 10,
    semantic: bool = True,
) -> list[dict]:
    """Hybrid retrieval with Reciprocal Rank Fusion (Graphiti pattern).

    Runs three independent retrieval methods, fuses via RRF, then
    expands top results with 1-hop graph neighbors.
    """
    import re
    import time
    keywords = [w.lower() for w in re.findall(r"[a-zA-Z][a-zA-Z0-9-]+", query) if len(w) > 2]

    # Change 0: Semantic entity expansion — "ML" → ["ml", "machine-learning", "ai", ...]
    # Skippable: a one-shot CLI invocation pays the full model load (~4s) for
    # this step alone, which blows sinain-core's subprocess timeout — and core
    # re-ranks candidates with its in-process embeddings anyway.
    expanded_keywords = keywords
    if semantic and len(keywords) >= 1:
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

    # Run retrieval methods independently
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

    results = rrf_candidates[:max_facts]
    if not semantic:
        # Caller re-ranks with its own embeddings (sinain-core does this
        # in-process) — loading the model here would cost ~4s per one-shot
        # invocation for work that gets redone anyway.
        return _hybrid_neighbor_expand(results, fact_map, db_path, max_facts)
    try:
        import numpy as np
        from common import load_sentence_transformer
        if not hasattr(query_facts_hybrid, "_embed_model"):
            query_facts_hybrid._embed_model = load_sentence_transformer("all-MiniLM-L6-v2")
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

    return _hybrid_neighbor_expand(results, fact_map, db_path, max_facts)


def _hybrid_neighbor_expand(
    results: list[dict],
    fact_map: dict[str, dict],
    db_path: str,
    max_facts: int,
) -> list[dict]:
    """Final hybrid step: pad short result sets with 1-hop graph neighbors."""
    if results and len(results) < max_facts:
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
    parser.add_argument("--top", type=int, default=None, help="Query top-N facts by confidence")
    parser.add_argument("--domain-counts", action="store_true", help="Show fact counts per domain")
    parser.add_argument("--max-facts", type=int, default=5, help="Maximum facts to return")
    parser.add_argument("--format", choices=["text", "json", "compact"], default="json", help="Output format")
    parser.add_argument("--search-entities", default=None, help="Search query for entity-prioritized lookup")
    parser.add_argument("--search-limit", type=int, default=20, help="Max entity results")
    parser.add_argument("--no-semantic", action="store_true",
                        help="Skip semantic keyword expansion (avoids the in-process model load — use when the caller re-ranks with its own embeddings)")
    parser.add_argument("--graph-children", default=None, help="Entity to expand for graph tree")
    parser.add_argument("--graph-limit", type=int, default=50, help="Max children per parent")
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

    if args.top is not None:
        facts = query_top_facts(args.db, limit=args.top)
    elif args.entities:
        entities = json.loads(args.entities)
        # Use hybrid retrieval (FTS5 + tags + entity graph + RRF) for best results
        query_text = " ".join(entities)
        facts = query_facts_hybrid(args.db, query_text, max_facts=args.max_facts,
                                   semantic=not args.no_semantic)
        # Fallback to tag-only if hybrid returns nothing
        if not facts:
            facts = query_facts_by_entities(args.db, entities, max_facts=args.max_facts)
    else:
        facts = query_top_facts(args.db, limit=args.max_facts)

    if args.format == "text":
        print(format_facts_text(facts))
    elif args.format == "compact":
        print(format_facts_compact(facts))
    else:
        print(json.dumps({"facts": facts, "count": len(facts)}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
