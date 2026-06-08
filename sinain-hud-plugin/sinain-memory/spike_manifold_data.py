#!/usr/bin/env python3
"""spike_manifold_data.py — one-time data prep for the mixed-curvature manifold spike.

Builds the LLM-supervised is-a graph + MiniLM features over the reduction-question
objects, and caches to /tmp/manifold_data.json so the torch training/eval can
iterate without re-calling the LLM or re-parsing haystacks.

Outputs per question: candidate objects (enrich SVO), the query domain, gold.
Global: is-a edges (object->category + specific->general chains from the typer's
general-to-specific labels), and MiniLM(384) embeddings for every vocab string.
"""
import json
import re
import sys

import category_enrichment as ce
from shadow_typed_edges import domain_from_question, sessions_to_texts
from embed_client import embed

DATA = "/tmp/lme_reductions.jsonl"
OUT = "/tmp/manifold_data.json"


def parse_gold_members(gold) -> list[str]:
    """Extract an explicit member list from a sentence-form gold answer, if any.
    'I replaced ... the kitchen faucet, the kitchen mat, the toaster, ...' -> [...]."""
    g = str(gold)
    if ":" in g:
        g = g.split(":", 1)[1]
    # split on commas / 'and'
    parts = re.split(r",|\band\b", g)
    members = []
    for p in parts:
        p = re.sub(r"\(.*?\)", "", p).strip(" .\t")
        p = re.sub(r"^(the|a|an|my|our|\d+[- ]?\w*)\s+", "", p, flags=re.I).strip()
        if 2 < len(p) < 50 and not p.lower().startswith(("i ", "i've", "for ", "unspecified")):
            members.append(p.lower())
    return members


def main():
    rows = [json.loads(l) for l in open(DATA) if l.strip()]
    per_q = []
    global_objs: set[str] = set()
    for q in rows:
        qid = q.get("question_id") or q.get("id")
        question = q.get("question", "")
        gold = q.get("answer")
        sessions = sessions_to_texts(q.get("haystack_sessions"))
        kws, domain = domain_from_question(question)
        edges = ce.enrich([], sessions, gate=False)
        objs = sorted({e["object"] for e in edges if e.get("object")})
        global_objs.update(objs)
        try:
            gold_n = int(re.search(r"\d+", str(gold)).group())
        except Exception:
            gold_n = None
        per_q.append({"qid": qid, "question": question, "domain": domain,
                      "gold": gold, "gold_n": gold_n,
                      "gold_members": parse_gold_members(gold),
                      "objects": objs})
        print(f"[{qid}] domain={domain!r} objs={len(objs)} gold_n={gold_n} "
              f"gold_members={per_q[-1]['gold_members'][:5]}", file=sys.stderr)

    # LLM is-a supervision: type the GLOBAL object set once (amortizable).
    print(f"\n[typing] {len(global_objs)} global objects via distiller model...", file=sys.stderr)
    obj_edges = ce.type_categories([{"object": o} for o in sorted(global_objs)])
    obj_cats = {e["object"]: e.get("categories", []) for e in obj_edges}

    # is-a edges: object -> each category; specific -> general within a chain.
    isa = []                      # (hyponym, hypernym)
    cat_vocab: set[str] = set()
    for o, cats in obj_cats.items():
        cats = [c for c in cats if c]
        for c in cats:
            isa.append((o, c)); cat_vocab.add(c)
        for a, b in zip(cats[1:], cats):   # labels are general->specific; specific is-a general
            isa.append((a, b))
    # also expose the query domains as category nodes (singularized head)
    domains = sorted({ce._singular(p["domain"]) for p in per_q})
    cat_vocab.update(domains)

    vocab = sorted(global_objs | cat_vocab)
    print(f"[embed] {len(vocab)} vocab strings via MiniLM...", file=sys.stderr)
    vecs = embed(vocab)
    emb = {s: [float(x) for x in v] for s, v in zip(vocab, vecs)}

    json.dump({"per_q": per_q, "obj_cats": obj_cats, "isa": isa,
               "objects": sorted(global_objs), "categories": sorted(cat_vocab),
               "domains": domains, "emb": emb}, open(OUT, "w"))
    print(f"\nwrote {OUT}: {len(global_objs)} objs, {len(cat_vocab)} cats, "
          f"{len(isa)} is-a edges, {len(vocab)} embedded")


if __name__ == "__main__":
    main()
