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


def format_facts_text(facts: list[dict], max_chars: int = 500) -> str:
    """Format facts as human-readable text for escalation message injection."""
    if not facts:
        return ""

    lines = []
    total = 0
    for f in facts:
        value = f.get("value", "")
        conf = f.get("confidence", "?")
        count = f.get("reinforce_count", "1")
        domain = f.get("domain", "")

        line = f"- {value} (confidence: {conf}, confirmed {count}x)"
        if domain:
            line = f"- [{domain}] {value} (confidence: {conf}, confirmed {count}x)"

        if total + len(line) > max_chars:
            break
        lines.append(line)
        total += len(line)

    return "\n".join(lines)


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
    parser.add_argument("--format", choices=["text", "json"], default="json", help="Output format")
    args = parser.parse_args()

    if args.domain_counts:
        counts = domain_fact_counts(args.db)
        print(json.dumps(counts, indent=2))
        return

    if args.top is not None:
        facts = query_top_facts(args.db, limit=args.top)
    elif args.entities:
        entities = json.loads(args.entities)
        facts = query_facts_by_entities(args.db, entities, max_facts=args.max_facts)
    else:
        facts = query_top_facts(args.db, limit=args.max_facts)

    if args.format == "text":
        print(format_facts_text(facts))
    else:
        print(json.dumps({"facts": facts, "count": len(facts)}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
