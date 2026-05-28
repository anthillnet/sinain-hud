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

        keywords = [e.lower().replace(" ", "-") for e in entities]

        # Primary: tag-based ranked search.
        ranked = store.tag_ranked_search(keywords, limit=max_facts * 3)
        fact_ids = [eid for eid, _ in ranked]

        # Fallback: if tag matches < max_facts, search by domain / entity_id slug.
        if len(fact_ids) < max_facts:
            fallback = store.entity_id_or_domain_search(
                keywords, exclude_ids=fact_ids, limit=max_facts - len(fact_ids),
            )
            fact_ids.extend(fallback)

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

        # Sort by confidence descending (tag ranking already done above)
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

        top = store.top_facts_by_confidence(limit=limit)
        facts = []
        for fid, _conf in top:
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
    """Substring search across fact `value` triples (Oxigraph backend).

    Replaces the SQLite FTS5 path with a CONTAINS-style scan in the SPARQL/RDF
    layer. Accepts the same "term1 AND term2" / "term1 OR term2" syntax the
    callers used to feed FTS5; default is AND across whitespace-split tokens.
    """
    if not Path(db_path).exists():
        return []

    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)

        entity_ids = store.fts_search(query, limit=max_facts)
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
    """Find entities that co-occur in the same distillation pass (shared first_seen timestamp).

    Dead-code path retained for API parity; query_facts_hybrid uses
    expand_entity_community / session_co_occurrence instead.
    """
    if not fact_ids:
        return []

    # Get first_seen timestamps for the input facts
    timestamps: set[str] = set()
    for fid in list(fact_ids)[:20]:  # cap to avoid huge queries
        attrs = store.entity(fid)
        fs = attrs.get("first_seen", [])
        if isinstance(fs, list) and fs:
            timestamps.add(fs[0])
        elif isinstance(fs, str):
            timestamps.add(fs)

    if not timestamps:
        return []

    # Walk facts that share these timestamps; collect their `entity` attribute values.
    fact_ids_set = set(fact_ids)
    counts: dict[str, int] = {}
    co_facts = store.facts_by_first_seen(list(timestamps), limit=200)
    rows: list[tuple[str]] = []
    for f_eid in co_facts:
        if f_eid in fact_ids_set:
            continue
        attrs = store.entity(f_eid)
        names = attrs.get("entity", [])
        if isinstance(names, str):
            names = [names]
        for name in names:
            rows.append((name,))

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


def _apply_confidence_floor(facts: list[dict], floor: float) -> list[dict]:
    """Drop facts whose decayed confidence is below `floor`.

    Uses decayed_confidence so a 0.8 fact past its half-life gets filtered
    by a moderate floor — fresh facts get more leeway.
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


def _cross_encoder_rerank(query: str, facts: list[dict], top_k: int) -> list[dict]:
    """Pairwise query×document rerank with a cross-encoder. Loads lazily.

    Cross-encoders are slow per-pair vs bi-encoders but score (query, doc)
    jointly, so they catch relevance the cosine misses (e.g. "when X happened"
    where bi-encoder treats every mention of X equally). Bounded to top-30
    RRF survivors — pairwise scoring is O(N), keep it cheap.

    Graceful fallback: if `cross-encoder/ms-marco-MiniLM-L-6-v2` isn't
    available (sandboxed installs without the extra weights), return the
    input list unchanged.
    """
    from sentence_transformers import CrossEncoder
    if not hasattr(_cross_encoder_rerank, "_model"):
        _cross_encoder_rerank._model = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")
    model = _cross_encoder_rerank._model
    pool = facts[:30]
    pairs = [(query, f.get("value", "")) for f in pool]
    if not pairs:
        return facts
    scores = model.predict(pairs)
    ranked = sorted(zip(scores, pool), key=lambda x: -x[0])
    return [f for _, f in ranked[:top_k]]


def _format_results(facts: list[dict], format: str) -> list[dict]:
    """Format dispatcher for query_facts_hybrid output.

    Phase D Tier 1: "facts" (default list[dict]) and "triples" (EAV records).
    "structured" and "narrative" formats are deferred (Tier 2 — require
    temporal columns + LLM-summarized briefs that the RDF backend doesn't
    yet expose). Until those land, structured/narrative return "facts" shape.
    """
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
            })
        return out
    return facts  # facts (default), structured/narrative fall through


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
) -> list[dict]:
    """Hybrid retrieval with Reciprocal Rank Fusion (Graphiti pattern).

    Runs FTS5, tag, top-confidence, and entity-graph retrievals independently,
    fuses via RRF, applies confidence_floor, optionally reranks (bi- or
    cross-encoder per precision_mode), and optionally expands via graph
    neighbors.

    Phase D parameter API (Tier 1 implemented 2026-05-28):
        precision_mode:     "fast" shrinks candidate pool and skips bi-encoder
                            rerank entirely. "balanced" (default) keeps
                            bi-encoder rerank. "precise" widens the pool and
                            adds cross-encoder rerank (~50-150ms extra) on
                            top of bi-encoder.
        temporal_mode:      ACCEPTED BUT NOT HONORED (Tier 2 — requires
                            occurred_start/occurred_end/mentioned_at on the
                            RDF backend). Defaults to "any" behavior.
        confidence_floor:   Drop facts whose decayed confidence is below
                            this value before rerank. Default 0.0 = no floor.
        hop_depth:          0 skips 1-hop graph expansion entirely. 1
                            (default) does the existing 1-hop fallback.
                            >=2 ACCEPTED BUT NOT HONORED (Tier 2 — multi-hop
                            spreading activation deferred).
        latency_budget_ms:  Soft cap. Rerank + expansion stages check elapsed
                            time and skip later work if exceeded. None = no
                            cap (default).
        format:             "facts" (default), "triples". "structured" /
                            "narrative" ACCEPTED but fall through to "facts"
                            shape (Tier 2).
        as_of:              ISO timestamp for point-in-time queries.
                            ACCEPTED BUT NOT HONORED (Tier 2).

    Returns list[dict] always — format-dependent shape variants are Tier 2.
    """
    import re
    import time
    pipeline_start = time.monotonic()

    def budget_exceeded() -> bool:
        if latency_budget_ms is None:
            return False
        return (time.monotonic() - pipeline_start) * 1000.0 > latency_budget_ms

    if precision_mode not in ("fast", "balanced", "precise"):
        precision_mode = "balanced"
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

    # Run retrieval methods independently. precision_mode tunes the pool:
    #   fast    — narrow pool (2x) so wall-time stays predictable, no rerank
    #   balanced— current default 3x (keeps existing behavior on default path)
    #   precise — wide pool 5x so cross-encoder rerank has more to work with
    if precision_mode == "fast":
        candidate_limit = max(max_facts * 2, max_facts + 5)
    elif precision_mode == "precise":
        candidate_limit = max_facts * 5
    else:
        candidate_limit = max_facts * 3

    # Phase D Tier 2: question-typed pool sizing per PLAN.md.
    # Counting / listing / temporal questions need a broader recall pool —
    # the answer aggregates over multiple facts, so cutting at top-30 may
    # leave out facts that belong in the answer. Heuristic prefix check on
    # the question text — light-weight, no LLM. Only WIDENS the pool (never
    # narrows below the precision_mode default) so this can only improve
    # recall for matching question shapes; single-lookup defaults are
    # preserved unchanged.
    q_lc = query.lower()
    if any(p in q_lc for p in (
        "how many", "count of", "number of", "how often",
        "list all", "list every", "all of the", "list the",
    )):
        candidate_limit = max(candidate_limit, max_facts * 8)
        question_class = "counting"
    elif any(p in q_lc for p in (
        "when did", "when was", "what year", "what time",
        "what date", "how long ago", "since when", "the date when",
    )):
        candidate_limit = max(candidate_limit, max_facts * 4)
        question_class = "temporal"
    else:
        question_class = "default"

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
            inter = _istore.tag_intersection(
                keywords, min_matches=len(keywords), limit=candidate_limit,
            )
            for fid, _matches in inter:
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
            kw_a, kw_b = keywords[0], keywords[1]
            ts_values = _sstore.session_co_occurrence(kw_a, kw_b, limit=10)
            if ts_values:
                fact_ids = _sstore.facts_by_first_seen(ts_values, limit=30)
                for eid in fact_ids:
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

    # Phase D Tier 2 (first slice 2026-05-28): recency boost via
    # `last_reinforced`. Distillation/reinforcement writes a timestamp every
    # time a fact is re-asserted. Facts mentioned recently get a small
    # additive boost so the "what did the user just say" use case stays
    # responsive to the freshest context without dominating long-tail
    # retrieval. 7-day half-life keeps the boost meaningful for current-
    # week conversations and decays to near-zero for monthly-old facts.
    # Bench gate: must NOT regress cloud q1+q2 (currently 2/2 100% recall).
    import math
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    for facts_list in [fts_results, tag_results, top_results]:
        for f in facts_list:
            eid = f.get("entity_id", "")
            if eid not in rrf_scores:
                continue
            ts = (
                f.get("last_reinforced")
                or f.get("first_seen")
                or ""
            )
            if isinstance(ts, list):
                ts = ts[0] if ts else ""
            if not ts or not isinstance(ts, str):
                continue
            try:
                t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                age_days = max(0.0, (now - t).total_seconds() / 86400.0)
                recency = math.exp(-0.693 * age_days / 7.0)
                rrf_scores[eid] += recency * 0.02  # boost ≤ 0.02, comparable to RRF rung
            except (ValueError, TypeError):
                pass

    # Sort by RRF score descending
    sorted_ids = sorted(rrf_scores, key=rrf_scores.get, reverse=True)

    # Build fact lookup from all candidates
    fact_map: dict[str, dict] = {}
    for facts in [fts_results, tag_results, top_results]:
        for f in facts:
            eid = f.get("entity_id", "")
            if eid and eid not in fact_map:
                fact_map[eid] = f

    # Return top RRF candidates. Cheap filters first — pruning noise before
    # rerank avoids paying encoder cost on facts we'd drop anyway.
    rrf_candidates = [fact_map[eid] for eid in sorted_ids[:max_facts * 2] if eid in fact_map]
    rrf_candidates = _apply_confidence_floor(rrf_candidates, confidence_floor)

    results = rrf_candidates[:max_facts]

    # Bi-encoder rerank — skipped in fast mode (too slow for hot path) and
    # if the latency budget already blew. Falls back silently when
    # sentence-transformers is missing.
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

    # precision_mode=precise: cross-encoder rerank on top of bi-encoder.
    # Cost is bounded (pool=30, top_k=max_facts) and we respect the latency
    # budget. Falls back gracefully if the cross-encoder model isn't
    # available locally (no extra weights downloaded).
    if precision_mode == "precise" and not budget_exceeded() and len(results) > 1:
        try:
            results = _cross_encoder_rerank(query, results, top_k=max_facts)
        except Exception as e:
            print(f"[warn] cross-encoder rerank failed (non-fatal): {e}", file=sys.stderr)

    # Graph expansion: hop_depth=0 skips entirely, hop_depth=1 = current 1-hop
    # behavior. hop_depth>=2 is Tier 2 (multi-hop spreading activation
    # deferred — would need store.cooccurring + budgeted BFS over ref edges).
    if hop_depth >= 1 and results and len(results) < max_facts and not budget_exceeded():
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

    return _format_results(results[:max_facts], format)


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

    2026-05-28: Switched from "; "-separated single-line to newline-per-fact
    output. The single-line form caused gemini-2.5-flash to lose the first
    fact under attention pressure from later longer facts — verified on
    LongMemEval-S q1 e47becba: BA fact first + full sports fact last → "I
    don't know"; same facts newline-separated → correct answer. Token cost
    is unchanged (\\n is one character, "; " is two).
    """
    if not facts:
        return ""

    # 2026-05-28 follow-up fix: removed (conf,Nx) metadata + entity/entity
    # prefix from the line format. Isolation test against gemini-2.5-flash
    # showed the metadata-laden form
    #   "- user/user: degree in Business Administration (0.85,1x)"
    # produced "I don't know" while the cleaner form
    #   "- user: degree in Business Administration"
    # produced the correct answer. The compact format had been actively
    # sabotaging QA for every bench: noise tokens (conf, count, doubled
    # entity prefix) made gemini parse the line as opaque structured data
    # rather than as a fact statement.
    lines = []
    total = 0
    for f in facts:
        entity = (
            f.get("entity")
            or f.get("entity_id", "").split(":")[-1].rsplit("-", 1)[0]
            or "?"
        )
        if isinstance(entity, list):
            entity = entity[0] if entity else "?"
        entity = str(entity)[:30]
        value = (f.get("value", "") or "").strip()
        if not value:
            continue

        line = f"- {entity}: {value}"
        if total + len(line) + 1 > max_chars:
            break
        lines.append(line)
        total += len(line) + 1

    return "\n".join(lines)


def domain_fact_counts(db_path: str) -> dict[str, int]:
    """Count facts per domain for module emergence detection."""
    if not Path(db_path).exists():
        return {}

    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)
        counts = store.domain_fact_counts()
        store.close()
        return counts
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
        facts = query_facts_hybrid(args.db, query_text, max_facts=args.max_facts)
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
