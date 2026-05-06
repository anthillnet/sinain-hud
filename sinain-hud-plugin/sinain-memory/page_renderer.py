#!/usr/bin/env python3
"""Page Renderer — synthesize a Confluence-style page for an entity.

Given an entity_id, loads top-K facts from the triplestore, calls an LLM to
group them into themed sections with a summary, and emits validated JSON.

Output schema:
    {
      "entity": "entity:citibank",
      "tx_watermark": 14823,
      "fact_count": 247,
      "facts_used": 247,
      "summary": "Citibank is …",
      "sections": [
        {
          "heading": "Key People",
          "bullets": [
            { "fact_id": "fact:citibank-cto-17yrs",
              "text": "CTO has 17 yrs tenure",
              "confidence": 0.92,
              "domain": "people",
              "first_seen": "2026-04-12" }
          ]
        }
      ],
      "stats": { "tokens_in": 18420, "tokens_out": 1380, "dropped_bullets": 0 }
    }

Hallucinated fact_ids (in LLM output but not in input) are dropped with a
count in stats.dropped_bullets — same defensive pattern as
knowledge_integrator.py.

Usage:
    python3 page_renderer.py --db memory/knowledge-graph.db \
        --entity entity:citibank [--max-facts 1000]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from common import LLMError, call_llm_with_fallback, extract_json


SYSTEM_PROMPT = """\
You are organizing knowledge into a Confluence-style page about a specific entity.
INPUT: a list of facts each with a stable fact_id, value, confidence, domain, and first_seen.
OUTPUT: JSON matching the schema below.

RULES:
- Group facts into 2 to 8 themed sections.
- Section ordering preference: Overview → People → Projects/Work → Decisions → Open Questions → Recent Activity. Only include sections that fit the available facts.
- EVERY bullet MUST reference a real fact_id from the input list. Do not invent fact_ids.
- Each bullet's "text" is at most 140 characters, present-tense, plain English. Rewrite the fact for readability — do NOT just quote it verbatim if it can be tighter.
- The "summary" is 2 to 4 sentences synthesizing the entity at a glance. Cite no fact_ids in the summary.
- If facts contradict, prefer the higher-confidence fact and note the disagreement in the section's optional "notes" field.
- If the entity has very few facts (<5), produce one "Overview" section with all of them.

OUTPUT ONLY a JSON object, no other text:
{
  "summary": "2-4 sentence summary",
  "sections": [
    {
      "heading": "Section title",
      "bullets": [
        { "fact_id": "fact:...", "text": "...", "confidence": 0.0 }
      ],
      "notes": "optional: contradictions or caveats"
    }
  ]
}
"""


def load_entity_facts(db_path: str, entity_id: str, max_facts: int) -> tuple[list[dict], int]:
    """Load facts for an entity. Returns (facts, tx_watermark).

    Resolution strategy:
      1. If entity_id starts with `entity:` — find all facts referencing it
         via (attribute='entity', value=entity_id, value_type='ref'),
         then return their full attribute sets.
      2. If entity_id starts with `fact:` — return its own attributes as a
         single-fact "page" (the fact IS the page).
      3. Otherwise — try entity:<slug> first, then fall back to all fact:<slug>-*.
    """
    from triplestore import TripleStore

    store = TripleStore(db_path)
    fact_ids: list[str] = []

    if entity_id.startswith("fact:"):
        fact_ids = [entity_id]
    elif entity_id.startswith("entity:"):
        # Find ANY incoming ref (any attribute), matching the same broad
        # predicate that graph_children uses. Filtering to attribute='entity'
        # was too narrow — real data references entities via many attribute
        # names (related_to, parent_org, employed_by, etc.).
        rows = store._conn.execute(
            """SELECT DISTINCT entity_id FROM triples
               WHERE value = ? AND value_type = 'ref' AND retracted = 0
               LIMIT ?""",
            (entity_id, max_facts),
        ).fetchall()
        fact_ids = [r["entity_id"] for r in rows]
        # Some installs store the entity-pointer as value_type='string' (the
        # slug, not a typed ref). Match those too via the slugified entity name
        # against the 'entity' attribute (the most common holder for that
        # legacy shape).
        slug_part = entity_id.split(":", 1)[1] if ":" in entity_id else entity_id
        legacy_rows = store._conn.execute(
            """SELECT DISTINCT entity_id FROM triples
               WHERE attribute = 'entity' AND value = ?
                 AND value_type = 'string' AND retracted = 0
               LIMIT ?""",
            (slug_part, max_facts),
        ).fetchall()
        for r in legacy_rows:
            if r["entity_id"] not in fact_ids:
                fact_ids.append(r["entity_id"])
        # Always include the entity itself's own attributes as a "self" fact.
        self_attrs_count = store._conn.execute(
            "SELECT COUNT(*) AS n FROM triples WHERE entity_id = ? AND retracted = 0",
            (entity_id,),
        ).fetchone()["n"]
        if self_attrs_count > 0:
            fact_ids.insert(0, entity_id)
        fact_ids = fact_ids[:max_facts]
    else:
        # Bare slug — try entity: first, then fact: prefix scan, then
        # broader substring match across both prefixes (handles cases where
        # the slug is a fragment of the actual entity_id).
        eid = f"entity:{entity_id}"
        exists = store._conn.execute(
            "SELECT 1 FROM triples WHERE entity_id = ? AND retracted = 0 LIMIT 1",
            (eid,),
        ).fetchone()
        if exists:
            return load_entity_facts(db_path, eid, max_facts)
        # Try fact:<slug>* (prefix), then *<slug>* (substring) across both prefixes.
        rows = store._conn.execute(
            """SELECT DISTINCT entity_id FROM triples
               WHERE entity_id LIKE ? AND retracted = 0
               LIMIT ?""",
            (f"fact:{entity_id}%", max_facts),
        ).fetchall()
        fact_ids = [r["entity_id"] for r in rows]
        if not fact_ids:
            rows = store._conn.execute(
                """SELECT DISTINCT entity_id FROM triples
                   WHERE (entity_id LIKE ? OR entity_id LIKE ?) AND retracted = 0
                   LIMIT ?""",
                (f"fact:%{entity_id}%", f"entity:%{entity_id}%", max_facts),
            ).fetchall()
            fact_ids = [r["entity_id"] for r in rows]

    # Load full attribute sets for each fact
    facts: list[dict] = []
    tx_watermark = 0
    for fid in fact_ids:
        attrs = store.entity(fid)
        if not attrs:
            continue
        # Compute tx_watermark across all triples for this fact
        max_tx_row = store._conn.execute(
            "SELECT MAX(tx_id) AS m FROM triples WHERE entity_id = ? AND retracted = 0",
            (fid,),
        ).fetchone()
        if max_tx_row and max_tx_row["m"] is not None:
            tx_watermark = max(tx_watermark, max_tx_row["m"])

        fact = {"fact_id": fid}
        for attr, values in attrs.items():
            v = values[0] if len(values) == 1 else values
            if attr == "tag":
                fact["tags"] = values
            else:
                fact[attr] = v
        # Coerce confidence to float
        try:
            fact["confidence"] = float(fact.get("confidence", 0.5))
        except (ValueError, TypeError):
            fact["confidence"] = 0.5
        facts.append(fact)

    store.close()

    # Sort by composite score: confidence * recency-bonus
    facts.sort(key=lambda f: (
        -float(f.get("confidence", 0.5)),
        f.get("first_seen", ""),
    ))
    return facts[:max_facts], tx_watermark


def build_user_prompt(entity_id: str, facts: list[dict]) -> str:
    """Compact representation for the LLM. Strips noise, keeps essential fields."""
    parts = [f"Entity: {entity_id}", f"Total facts: {len(facts)}", "", "Facts:"]
    for f in facts:
        fid = f.get("fact_id", "?")
        value = (f.get("value") or "").strip().replace("\n", " ")[:300]
        conf = f.get("confidence", "?")
        domain = f.get("domain", "")
        first_seen = f.get("first_seen", "")[:10]  # YYYY-MM-DD
        tags = ",".join(f.get("tags", [])[:5]) if f.get("tags") else ""
        meta_bits = []
        if domain: meta_bits.append(f"domain={domain}")
        if first_seen: meta_bits.append(f"first_seen={first_seen}")
        if tags: meta_bits.append(f"tags={tags}")
        meta = " | ".join(meta_bits)
        parts.append(f"- [{fid}] (conf={conf}{', ' + meta if meta else ''}): {value}")
    return "\n".join(parts)


def render_page(db_path: str, entity_id: str, max_facts: int = 1000) -> dict:
    facts, tx_watermark = load_entity_facts(db_path, entity_id, max_facts)
    fact_count_total = len(facts)

    if not facts:
        return {
            "entity": entity_id,
            "tx_watermark": tx_watermark,
            "fact_count": 0,
            "facts_used": 0,
            "summary": "No knowledge captured for this entity yet.",
            "sections": [],
            "stats": {"tokens_in": 0, "tokens_out": 0, "dropped_bullets": 0,
                      "from_cache": False},
        }

    # Single-fact short-circuit (no LLM needed)
    if fact_count_total == 1:
        f = facts[0]
        return {
            "entity": entity_id,
            "tx_watermark": tx_watermark,
            "fact_count": 1,
            "facts_used": 1,
            "summary": (f.get("value") or "")[:200],
            "sections": [{
                "heading": "Overview",
                "bullets": [{
                    "fact_id": f["fact_id"],
                    "text": (f.get("value") or "")[:140],
                    "confidence": f.get("confidence", 0.5),
                    "domain": f.get("domain"),
                    "first_seen": f.get("first_seen"),
                }],
            }],
            "stats": {"tokens_in": 0, "tokens_out": 0, "dropped_bullets": 0,
                      "from_cache": False},
        }

    # Multi-fact: LLM rendering
    user_prompt = build_user_prompt(entity_id, facts)

    try:
        raw = call_llm_with_fallback(
            SYSTEM_PROMPT, user_prompt, script="page_renderer",
            json_mode=True, retries=1,
        )
        parsed = extract_json(raw)
    except Exception as e:
        # Catch broad — covers LLMError, ValueError, missing API key
        # (RuntimeError), JSON parse errors, network errors, etc. The web UI
        # always wants a renderable response; degraded > broken.
        sys.stderr.write(f"page_renderer LLM failed: {e}\n")
        return _fallback_page(entity_id, facts, tx_watermark, error=str(e))

    if not isinstance(parsed, dict):
        return _fallback_page(entity_id, facts, tx_watermark, error="LLM did not return object")

    # Validate fact_ids — drop hallucinated ones
    valid_fids = {f["fact_id"] for f in facts}
    fact_meta = {f["fact_id"]: f for f in facts}
    sections_in = parsed.get("sections", []) or []
    sections_out: list[dict] = []
    dropped = 0

    for sec in sections_in:
        if not isinstance(sec, dict): continue
        heading = (sec.get("heading") or "").strip()[:80]
        if not heading: continue
        bullets_in = sec.get("bullets", []) or []
        bullets_out: list[dict] = []
        for b in bullets_in:
            if not isinstance(b, dict): continue
            fid = b.get("fact_id")
            if not fid or fid not in valid_fids:
                dropped += 1
                continue
            meta = fact_meta[fid]
            bullets_out.append({
                "fact_id": fid,
                "text": (b.get("text") or meta.get("value") or "")[:200],
                "confidence": meta.get("confidence", 0.5),
                "domain": meta.get("domain"),
                "first_seen": meta.get("first_seen"),
            })
        if bullets_out:
            sec_out = {"heading": heading, "bullets": bullets_out}
            if sec.get("notes"):
                sec_out["notes"] = str(sec["notes"])[:300]
            sections_out.append(sec_out)

    summary = (parsed.get("summary") or "").strip()[:1000]
    if not summary:
        summary = f"Knowledge about {entity_id}: {fact_count_total} facts."

    return {
        "entity": entity_id,
        "tx_watermark": tx_watermark,
        "fact_count": fact_count_total,
        "facts_used": fact_count_total - dropped,
        "summary": summary,
        "sections": sections_out,
        "stats": {
            "tokens_in": 0,  # tracked in stderr; aggregating here would require parser
            "tokens_out": 0,
            "dropped_bullets": dropped,
            "from_cache": False,
        },
    }


def _fallback_page(entity_id: str, facts: list[dict], tx_watermark: int, error: str = "") -> dict:
    """Ungrouped fallback when LLM fails or returns garbage."""
    bullets = [{
        "fact_id": f["fact_id"],
        "text": (f.get("value") or "")[:140],
        "confidence": f.get("confidence", 0.5),
        "domain": f.get("domain"),
        "first_seen": f.get("first_seen"),
    } for f in facts]
    return {
        "entity": entity_id,
        "tx_watermark": tx_watermark,
        "fact_count": len(facts),
        "facts_used": len(facts),
        "summary": f"Knowledge about {entity_id} ({len(facts)} facts). LLM rendering unavailable.",
        "sections": [{"heading": "All Facts", "bullets": bullets}],
        "stats": {"tokens_in": 0, "tokens_out": 0, "dropped_bullets": 0,
                  "from_cache": False, "fallback": True, "error": error[:200]},
    }


def lookup_cache(web_db_path: str, entity_id: str, tx_watermark: int) -> dict | None:
    """Read page_cache row matching (entity, tx_watermark). Returns parsed JSON or None."""
    import sqlite3
    if not Path(web_db_path).exists():
        return None
    try:
        conn = sqlite3.connect(web_db_path)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT page_json, generated_at FROM page_cache WHERE entity_id = ? AND tx_watermark = ?",
            (entity_id, tx_watermark),
        ).fetchone()
        conn.close()
        if row:
            page = json.loads(row["page_json"])
            page.setdefault("stats", {})["from_cache"] = True
            page["generated_at"] = row["generated_at"]
            return page
    except Exception as e:
        sys.stderr.write(f"page_renderer cache lookup failed: {e}\n")
    return None


def write_cache(web_db_path: str, entity_id: str, page: dict) -> None:
    """Persist a freshly-rendered page to web.db.page_cache."""
    import sqlite3
    import time
    try:
        conn = sqlite3.connect(web_db_path)
        stats = page.get("stats", {})
        conn.execute(
            """INSERT OR REPLACE INTO page_cache
               (entity_id, tx_watermark, page_json, generated_at, tokens_in, tokens_out, cost_usd)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                entity_id,
                page.get("tx_watermark", 0),
                json.dumps(page, ensure_ascii=False),
                int(time.time() * 1000),
                stats.get("tokens_in"),
                stats.get("tokens_out"),
                stats.get("cost_usd"),
            ),
        )
        conn.commit()
        conn.close()
    except Exception as e:
        sys.stderr.write(f"page_renderer cache write failed: {e}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Page Renderer")
    parser.add_argument("--db", required=True, help="Path to knowledge-graph.db")
    parser.add_argument("--entity", required=True, help="Entity id (entity:* or fact:* or bare slug)")
    parser.add_argument("--max-facts", type=int, default=1000, help="Max facts to consider")
    parser.add_argument("--web-db", default=None,
                        help="Path to web.db for page cache (optional). If provided, hits and writes cache.")
    parser.add_argument("--refresh", action="store_true",
                        help="Bypass cache and always re-render via LLM.")
    args = parser.parse_args()

    if not Path(args.db).exists():
        print(json.dumps({"error": f"db not found: {args.db}"}))
        sys.exit(1)

    # Determine tx_watermark cheaply for the cache key, before we commit to LLM.
    facts, tx_watermark = load_entity_facts(args.db, args.entity, args.max_facts)

    # Cache hit fast-path
    if args.web_db and not args.refresh:
        cached = lookup_cache(args.web_db, args.entity, tx_watermark)
        if cached:
            print(json.dumps(cached, ensure_ascii=False))
            return

    # Render (uses already-loaded facts via a thin reuse path)
    if not facts:
        page = {
            "entity": args.entity,
            "tx_watermark": tx_watermark,
            "fact_count": 0,
            "facts_used": 0,
            "summary": "No knowledge captured for this entity yet.",
            "sections": [],
            "stats": {"tokens_in": 0, "tokens_out": 0, "dropped_bullets": 0, "from_cache": False},
        }
    else:
        page = render_page(args.db, args.entity, max_facts=args.max_facts)
        # render_page reloads facts internally; the load above is duplicated. Keep
        # the cleaner separation rather than threading state — the second load
        # hits the in-process SQLite page cache, so the cost is negligible.

    if args.web_db and page.get("fact_count", 0) > 0:
        write_cache(args.web_db, args.entity, page)

    print(json.dumps(page, ensure_ascii=False))


if __name__ == "__main__":
    main()
