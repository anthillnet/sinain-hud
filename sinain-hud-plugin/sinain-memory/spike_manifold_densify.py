#!/usr/bin/env python3
"""spike_manifold_densify.py — attack manifold data-sparsity by mining is-a from
the RAW CHUNKS + building a rooted category backbone.

Two levers (ablatable via env):
  HEARST=1   — mine (hyponym, hypernym) edges from raw chunks with Hearst patterns
               (zero-LLM, user-grounded, accumulates over time = the runtime idea).
  BACKBONE=1 — connect the flat category set into a rooted tree via LLM hypernym
               chains (houseplant->plant->living thing->entity), one batched pass.

Reads /tmp/manifold_data.json + the raw haystacks; writes /tmp/manifold_data_dense.json.
"""
import json
import os
import re
import sys

import category_enrichment as ce
from shadow_typed_edges import sessions_to_texts
from embed_client import embed
from common import call_llm

DATA = "/tmp/lme_reductions.jsonl"
IN = "/tmp/manifold_data.json"
OUT = "/tmp/manifold_data_dense.json"

# Hearst lexico-syntactic patterns (Hearst 1992). group order varies by pattern.
_HEARST = [
    (re.compile(r"\b([a-z][a-z ]{2,30}?)\s+such as\s+([a-z][a-z ,]+?[a-z])\b"), "H_first"),
    (re.compile(r"\bsuch\s+([a-z][a-z ]{2,30}?)\s+as\s+([a-z][a-z ,]+?[a-z])\b"), "H_first"),
    (re.compile(r"\b([a-z][a-z ,]+?[a-z])\s+and other\s+([a-z][a-z ]{2,30}?)\b"), "H_last"),
    (re.compile(r"\b([a-z][a-z ,]+?[a-z])\s+or other\s+([a-z][a-z ]{2,30}?)\b"), "H_last"),
    (re.compile(r"\b([a-z][a-z ]{2,30}?)\s+including\s+([a-z][a-z ,]+?[a-z])\b"), "H_first"),
    (re.compile(r"\b([a-z][a-z ]{2,30}?)\s+especially\s+([a-z][a-z ,]+?[a-z])\b"), "H_first"),
]
_STOP = {"the", "a", "an", "my", "our", "some", "many", "any", "other", "this",
         "that", "these", "those", "it", "them", "stuff", "things", "thing"}


def _clean(np: str) -> str:
    np = re.sub(r"\b(the|a|an|my|our|some|several|few|other)\b", "", np).strip(" ,.")
    return np if 2 < len(np) < 30 and np not in _STOP else ""


def hearst_edges(chunks) -> list[tuple[str, str]]:
    edges = []
    for t in chunks:
        tl = " " + t.lower().replace("\n", " ") + " "
        for pat, kind in _HEARST:
            for m in pat.finditer(tl):
                a, b = m.group(1), m.group(2)
                hypernym = _clean(a if kind == "H_first" else b)
                hypo_blob = b if kind == "H_first" else a
                if not hypernym:
                    continue
                for hypo in re.split(r",|\band\b|\bor\b", hypo_blob):
                    hypo = _clean(hypo)
                    if hypo and hypo != hypernym:
                        edges.append((hypo, hypernym))
    return edges


def backbone_chains(categories) -> list[tuple[str, str]]:
    """LLM hypernym chains to a root, connecting the flat category set into a tree."""
    edges = []
    sys_p = ("For each numbered category, give its chain of broader categories up to a "
             "root, separated by ' > ', from the item to most general. Lowercase singular. "
             "Example: '1. houseplant' -> '1: houseplant > plant > living thing > entity'; "
             "'2. guitar' -> '2: guitar > musical instrument > device > artifact > object'.")
    cats = sorted(set(categories))
    for s in range(0, len(cats), 20):
        chunk = cats[s:s + 20]
        up = "\n".join(f"{i+1}. {c}" for i, c in enumerate(chunk))
        try:
            out = call_llm(sys_p, up, script="session_distiller", temperature=0.0,
                           seed=42, max_tokens=700)
        except Exception:
            continue
        for ln in out.splitlines():
            m = re.match(r"\s*(\d+)\s*[:.)\-]\s*(.+)", ln)
            if not m:
                continue
            chain = [c.strip().lower() for c in m.group(2).split(">") if c.strip()]
            for a, b in zip(chain, chain[1:]):   # specific > general => a is-a b
                if a != b:
                    edges.append((a, b))
    return edges


def main():
    D = json.load(open(IN))
    isa = [tuple(e) for e in D["isa"]]
    n0 = len(isa)
    new_strings = set()

    if os.environ.get("HEARST", "1") == "1":
        rows = [json.loads(l) for l in open(DATA) if l.strip()]
        chunks = []
        for q in rows:
            chunks += sessions_to_texts(q.get("haystack_sessions"))
        he = hearst_edges(chunks)
        # keep edges whose hyponym is a known object OR hypernym is a known category
        objs = set(D["objects"]); cats = set(D["categories"])
        kept = [(u, v) for u, v in he if u in objs or v in cats or len(he) < 5000]
        isa += kept
        for u, v in kept:
            new_strings.add(u); new_strings.add(v)
        print(f"[hearst] mined {len(he)} raw edges, kept {len(kept)}", file=sys.stderr)

    if os.environ.get("BACKBONE", "1") == "1":
        bb = backbone_chains(D["categories"])
        isa += bb
        for u, v in bb:
            new_strings.add(u); new_strings.add(v)
        print(f"[backbone] +{len(bb)} category->root chain edges", file=sys.stderr)

    # dedup edges
    isa = sorted(set((u, v) for u, v in isa if u and v and u != v))
    # embed any new vocab strings
    emb = dict(D["emb"])
    todo = sorted(s for s in new_strings if s and s not in emb)
    if todo:
        print(f"[embed] +{len(todo)} new strings", file=sys.stderr)
        for v, vec in zip(todo, embed(todo)):
            emb[v] = [float(x) for x in vec]
    cats = sorted(set(D["categories"]) | {v for _, v in isa} | {v for u, v in isa if v in new_strings})
    D2 = dict(D)
    D2["isa"] = isa
    D2["emb"] = emb
    D2["categories"] = sorted(set(c for c in cats if c in emb))
    json.dump(D2, open(OUT, "w"))
    print(f"\nwrote {OUT}: is-a {n0} -> {len(isa)} edges, {len(D2['categories'])} categories")


if __name__ == "__main__":
    main()
