#!/usr/bin/env python3
"""Triple Query — read-only utilities for querying the triple store.

Importable module + CLI for generating context from the knowledge graph.

Usage (CLI):
    python3 triple_query.py --memory-dir memory/ --context "OCR pipeline" --max-chars 1500

Usage (import):
    from triple_query import get_related_context
    context = get_related_context("memory/", ["OCR pipeline"], max_chars=1500)
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from triplestore import TripleStore
from common import output_json


def _db_path(memory_dir: str) -> str:
    return str(Path(memory_dir) / "triplestore.db")


def build_entity_text(store: TripleStore, entity_id: str) -> str:
    """Build a readable text representation of an entity."""
    attrs = store.entity(entity_id)
    if not attrs:
        return ""

    etype = entity_id.split(":")[0] if ":" in entity_id else "unknown"
    parts = [f"[{etype}] {entity_id}"]

    for attr, vals in sorted(attrs.items()):
        if attr == "related_to":
            parts.append(f"  links: {', '.join(vals)}")
        elif attr == "belongs_to":
            parts.append(f"  module: {', '.join(vals)}")
        elif len(vals) == 1:
            parts.append(f"  {attr}: {vals[0]}")
        else:
            parts.append(f"  {attr}: {', '.join(vals)}")

    return "\n".join(parts)


def get_related_concepts(
    memory_dir: str, keywords: list[str]
) -> str:
    """Find concepts matching keywords, then follow backrefs to related entities.

    Returns formatted markdown suitable for injection into LLM context.
    """
    db = _db_path(memory_dir)
    if not Path(db).exists():
        return ""

    store = TripleStore(db)
    try:
        parts: list[str] = []
        seen_entities: set[str] = set()

        for keyword in keywords:
            kw_lower = keyword.lower().strip()
            if not kw_lower:
                continue

            # AVET: look up concepts by name
            all_concepts = store.entities_with_attr("name")
            for eid, name in all_concepts:
                if not eid.startswith("concept:"):
                    continue
                if kw_lower in name.lower():
                    if eid in seen_entities:
                        continue
                    seen_entities.add(eid)

                    # VAET: find what references this concept
                    refs = store.backrefs(eid)
                    if refs:
                        ref_parts = []
                        for ref_eid, ref_attr in refs[:10]:  # cap
                            if ref_eid in seen_entities:
                                continue
                            seen_entities.add(ref_eid)
                            text = build_entity_text(store, ref_eid)
                            if text:
                                ref_parts.append(text)
                        if ref_parts:
                            parts.append(f"### {name}\n" + "\n".join(ref_parts))

        return "\n\n".join(parts) if parts else ""
    finally:
        store.close()


def get_related_context(
    memory_dir: str,
    seed_texts: list[str],
    max_chars: int = 1500,
) -> str:
    """Build a context block from the knowledge graph for the given seed texts.

    Phase 1: keyword matching against entity attributes.
    Phase 2 (when embedder available): adds vector search as primary channel.
    """
    db = _db_path(memory_dir)
    if not Path(db).exists():
        return ""

    store = TripleStore(db)
    try:
        context_parts: list[str] = []
        total_chars = 0
        seen: set[str] = set()

        # Phase 2: try vector search first
        try:
            from embedder import Embedder
            embedder = Embedder(db)
            for text in seed_texts:
                vecs = embedder.embed([text])
                if vecs and vecs[0]:
                    results = embedder.vector_search(vecs[0], top_k=5)
                    for eid, score in results:
                        if eid in seen:
                            continue
                        seen.add(eid)
                        ent_text = build_entity_text(store, eid)
                        if ent_text and total_chars + len(ent_text) < max_chars:
                            context_parts.append(f"{ent_text} (relevance: {score:.2f})")
                            total_chars += len(ent_text) + 20
        except (ImportError, Exception):
            pass  # Phase 2 not available, fall through to keyword

        # Phase 1: keyword matching
        if total_chars < max_chars // 2:
            # Extract keywords from seed texts
            keywords: set[str] = set()
            for text in seed_texts:
                for word in text.lower().split():
                    word = word.strip(".,!?;:'\"()[]{}").strip()
                    if len(word) > 3:
                        keywords.add(word)

            # Search patterns and concepts by keyword
            all_text_triples = store.entities_with_attr("text")
            all_name_triples = store.entities_with_attr("name")

            for eid, val in all_text_triples + all_name_triples:
                if eid in seen:
                    continue
                val_lower = val.lower()
                if any(kw in val_lower for kw in keywords):
                    seen.add(eid)
                    ent_text = build_entity_text(store, eid)
                    if ent_text and total_chars + len(ent_text) < max_chars:
                        context_parts.append(ent_text)
                        total_chars += len(ent_text)
                    if total_chars >= max_chars:
                        break

        return "\n\n".join(context_parts) if context_parts else ""
    finally:
        store.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Triple Store Query CLI")
    parser.add_argument("--memory-dir", required=True, help="Path to memory/ directory")
    parser.add_argument("--context", required=True, help="Query text for context generation")
    parser.add_argument("--max-chars", type=int, default=1500, help="Maximum context chars")
    args = parser.parse_args()

    context = get_related_context(args.memory_dir, [args.context], max_chars=args.max_chars)
    output_json({"context": context})


if __name__ == "__main__":
    main()
