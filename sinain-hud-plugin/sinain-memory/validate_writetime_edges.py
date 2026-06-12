#!/usr/bin/env python3
"""validate_writetime_edges.py — P2 write-time architecture validation.

Exercises the PRODUCTION path the user asked for:
  extract (SVO) -> type_categories (WRITE time, distiller model) -> persist hubs
  -> query_category_members (READ time, structural backrefs, NO LLM) -> count.

This proves the read path needs no LLM and no second stream: all taxonomic work
happens once at write time. Compares the structural count to the gold count on the
reduction fail set.

Usage: python3 validate_writetime_edges.py [dataset.jsonl] [--limit N]
"""
import json
import os
import sys
import tempfile

import category_enrichment as ce
from shadow_typed_edges import domain_from_question, sessions_to_texts


def main():
    path = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else "/tmp/lme_reductions.jsonl"
    limit = None
    for i, a in enumerate(sys.argv):
        if a == "--limit" and i + 1 < len(sys.argv):
            limit = int(sys.argv[i + 1])

    with open(path) as fh:
        rows = [json.loads(l) for l in fh if l.strip()]
    if limit:
        rows = rows[:limit]
    print(f"write-time typed-edge validation: {len(rows)} questions\n")
    hits = 0
    tmp = tempfile.mkdtemp()
    for q in rows:
        qid = q.get("question_id") or q.get("id")
        gold = q.get("answer")
        question = q.get("question", "")
        sessions = sessions_to_texts(q.get("haystack_sessions"))
        kws, phrase = domain_from_question(question)

        # WRITE PATH: extract -> type (distiller model) -> persist hubs
        edges = ce.enrich([], sessions, gate=False)
        typed = ce.type_categories(edges) if edges else []
        store = os.path.join(tmp, f"{qid}.db")
        n_obj, n_edge = ce.persist_typed_edges(store, typed, "2023-01-01T00:00:00Z") if typed else (0, 0)

        # READ PATH: structural backrefs walk — NO LLM
        members = ce.query_category_members(store, phrase)

        try:
            gold_n = int(__import__("re").search(r"\d+", str(gold)).group())
        except Exception:
            gold_n = None
        n = len(members)
        ok = (gold_n is not None and n == gold_n)
        hits += ok
        print(f"[{qid}] {question[:60]}")
        print(f"    gold={str(gold)[:24]!r}  domain={phrase!r}  objs={n_obj} cats_edges={n_edge}  members={n}  {'✓' if ok else ''}")
        print(f"    members: {members[:10]}")
    print(f"\nexact-count match: {hits}/{len(rows)}")


if __name__ == "__main__":
    main()
