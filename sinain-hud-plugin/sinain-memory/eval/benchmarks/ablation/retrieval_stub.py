"""Retrieval ablation stub. Replaces query_facts_hybrid (FTS + tag + RRF +
rerank) with a deterministic alternative.

Modes:
    passthrough: SELECT first N triples in insertion order (ignores question).
                 Tests: "what if retrieval was random/oblivious?"
    oracle:      keyword filter — rows where any value-token matches a
                 gold-keyword token. Tests: "what's the accuracy ceiling if
                 retrieval was perfect keyword lookup?"
"""
from __future__ import annotations
import sqlite3
import sys
from pathlib import Path

_koog_dir = str(Path(__file__).resolve().parent.parent.parent.parent)
if _koog_dir not in sys.path:
    sys.path.insert(0, _koog_dir)


def stub_retrieve(
    db_path: str,
    question: str,
    max_facts: int = 10,
    mode: str = "passthrough",
    gold_keywords: list[str] | None = None,
) -> list[dict]:
    """Return a list of fact dicts matching query_facts_hybrid output shape.

    Output dict shape: {entity_id, attribute, value, confidence}.
    """
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
    except sqlite3.Error:
        return []

    try:
        if mode == "oracle" and gold_keywords:
            clauses = " OR ".join(["LOWER(value) LIKE ?"] * len(gold_keywords))
            params = [f"%{kw.lower()}%" for kw in gold_keywords]
            sql = (
                f"SELECT entity_id, attribute, value, confidence "
                f"FROM triples WHERE {clauses} LIMIT ?"
            )
            params.append(max_facts)
            cur = conn.execute(sql, params)
        else:
            cur = conn.execute(
                "SELECT entity_id, attribute, value, confidence "
                "FROM triples LIMIT ?",
                (max_facts,),
            )
        rows = [dict(r) for r in cur.fetchall()]
    except sqlite3.Error:
        rows = []
    finally:
        conn.close()
    return rows
