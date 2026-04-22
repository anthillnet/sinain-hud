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
            fact = {"entityId": fid}
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
            fact = {"entityId": fid}
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


def query_facts_hybrid(
    db_path: str,
    query: str,
    max_facts: int = 10,
) -> list[dict]:
    """Hybrid retrieval with Reciprocal Rank Fusion (Graphiti pattern).

    Runs three independent retrieval methods, fuses via RRF, then
    expands top results with 1-hop graph neighbors.
    """
    import re
    keywords = [w.lower() for w in re.findall(r"[a-zA-Z][a-zA-Z0-9-]+", query) if len(w) > 2]

    # Entity graph pre-filter: find facts linked to mentioned entities via backrefs.
    # Used to BOOST relevant facts in RRF, not as a separate tier (avoids dilution).
    graph_fact_ids: set[str] = set()
    for kw in keywords:
        for f in query_facts_by_entity_graph(db_path, kw, max_facts=50):
            eid = f.get("entity_id", "")
            if eid:
                graph_fact_ids.add(eid)

    # Run three retrieval methods independently
    candidate_limit = max_facts * 3
    fts_results = query_facts_fts(db_path, query, max_facts=candidate_limit)
    tag_results = query_facts_by_entities(db_path, keywords, max_facts=candidate_limit) if keywords else []
    top_results = query_top_facts(db_path, limit=candidate_limit)

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

    # Reciprocal Rank Fusion: RRF(d) = Σ 1/(k + rank_i(d))
    K = 60  # standard RRF constant
    rrf_scores: dict[str, float] = {}
    for ranked_list in [fts_ranked, tag_ranked, top_ranked]:
        for rank, eid in enumerate(ranked_list):
            rrf_scores[eid] = rrf_scores.get(eid, 0.0) + 1.0 / (K + rank)

    # Graph boost: facts linked to mentioned entities via backrefs get priority
    if graph_fact_ids:
        for eid in rrf_scores:
            if eid in graph_fact_ids:
                rrf_scores[eid] += 0.02  # significant boost — graph-linked facts rank higher

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

    # Return top RRF candidates. Embedding re-ranking is done by the caller
    # (sinain-core Node.js) to avoid deadlock — the Python subprocess can't call
    # back to sinain-core's /embed endpoint while sinain-core is blocked waiting
    # for the subprocess.
    results = [fact_map[eid] for eid in sorted_ids[:max_facts] if eid in fact_map]

    # Expand top results with 1-hop graph neighbors
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


def main() -> None:
    parser = argparse.ArgumentParser(description="Graph Query")
    parser.add_argument("--db", required=True, help="Path to knowledge-graph.db")
    parser.add_argument("--entities", default=None, help="JSON array of entity/domain names")
    parser.add_argument("--top", type=int, default=None, help="Query top-N facts by confidence")
    parser.add_argument("--domain-counts", action="store_true", help="Show fact counts per domain")
    parser.add_argument("--max-facts", type=int, default=5, help="Maximum facts to return")
    parser.add_argument("--format", choices=["text", "json", "compact"], default="json", help="Output format")
    args = parser.parse_args()

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
