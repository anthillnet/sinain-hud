#!/usr/bin/env python3
"""spike_manifold_data_scaled.py — scale the manifold training set to the WHOLE
LongMemEval bench (500 haystacks) to test whether more training OBJECTS unlocks
the inductive map's generalization (the diagnosed bottleneck).

Optimized batched spaCy (nlp.pipe, NER off) with a per-haystack window cap to
bound cost while covering all 500 haystacks for max object diversity. Types the
global object set (LLM, batched) + specific->general chains, embeds, and writes
/tmp/manifold_data_scaled.json (same schema as spike_manifold_data.py).

The 8 reduction questions are always included (for H1 eval).
Env: WINCAP (per-haystack window cap, default 200), NHAY (default 500).
"""
import json
import os
import re
import sys

import spacy
from shadow_typed_edges import sessions_to_texts, domain_from_question
from category_enrichment import _ACT, _subject_kind, _FIRST_POSS, _singular, type_categories
from embed_client import embed

DS = "/Users/Igor.Gerasimov/IdeaProjects/sinain-hud/sinain-hud-plugin/sinain-memory/eval/benchmarks/data/longmemeval/longmemeval_s_cleaned.json"
REDU = "/tmp/lme_reductions.jsonl"
OUT = "/tmp/manifold_data_scaled.json"

_NLP = spacy.load("en_core_web_sm", disable=["ner"])


def svo_doc(doc):
    """SVO over an already-parsed spaCy Doc (mirrors category_enrichment._svo)."""
    out = []
    for tok in doc:
        if tok.pos_ != "VERB" or tok.lemma_.lower() not in _ACT:
            continue
        kind = _subject_kind(tok)
        if kind == "blocked":
            continue
        for c in tok.children:
            if c.dep_ in ("dobj", "obj") and c.pos_ in ("NOUN", "PROPN"):
                if kind == "none":
                    if not any(m.lemma_.lower() in _FIRST_POSS for m in c.children
                               if m.dep_ in ("poss", "det", "nmod")):
                        continue
                comp = [m.text for m in c.children if m.dep_ == "compound"
                        and m.pos_ in ("NOUN", "PROPN")]
                out.append(" ".join(comp + [c.text]).lower())
    return out


def main():
    wincap = int(os.environ.get("WINCAP", "200"))
    nhay = int(os.environ.get("NHAY", "500"))
    ds = json.load(open(DS))[:nhay]
    redu_ids = {json.loads(l)["question_id"] for l in open(REDU) if l.strip()}
    redu_rows = {json.loads(l)["question_id"]: json.loads(l) for l in open(REDU) if l.strip()}

    # collect windows (capped) + remember which belong to a reduction question
    windows = []          # flat list of text
    win_qid = []          # parallel: qid if reduction-question else None
    for q in ds:
        qid = q.get("question_id") or q.get("id")
        w = sessions_to_texts(q.get("haystack_sessions"))[:wincap]
        rq = qid if qid in redu_ids else None
        windows += w
        win_qid += [rq] * len(w)
    # ensure all 8 reduction haystacks present even beyond nhay
    for qid, q in redu_rows.items():
        if qid not in {(x.get("question_id") or x.get("id")) for x in ds}:
            w = sessions_to_texts(q.get("haystack_sessions"))[:wincap]
            windows += w; win_qid += [qid] * len(w)
    print(f"[scaled] {len(ds)} haystacks, {len(windows)} windows (cap {wincap}); parsing...",
          file=sys.stderr)

    global_objs = set()
    per_q_objs = {qid: set() for qid in redu_ids}
    done = 0
    for doc, rq in zip(_NLP.pipe(windows, batch_size=128), win_qid):
        for o in svo_doc(doc):
            global_objs.add(o)
            if rq:
                per_q_objs[rq].add(o)
        done += 1
        if done % 20000 == 0:
            print(f"  parsed {done}/{len(windows)} windows, {len(global_objs)} objs", file=sys.stderr)
    print(f"[scaled] {len(global_objs)} distinct objects", file=sys.stderr)

    # LLM is-a labels over the global object set (batched inside type_categories)
    print(f"[typing] {len(global_objs)} objects...", file=sys.stderr)
    typed = type_categories([{"object": o} for o in sorted(global_objs)])
    obj_cats = {e["object"]: e.get("categories", []) for e in typed}

    isa = []
    cat_vocab = set()
    for o, cats in obj_cats.items():
        cats = [c for c in cats if c]
        for c in cats:
            isa.append((o, c)); cat_vocab.add(c)
        for a, b in zip(cats[1:], cats):
            isa.append((a, b))
    domains = sorted({_singular(domain_from_question(redu_rows[q]["question"])[1]) for q in redu_ids})
    cat_vocab.update(domains)

    # per-question records for H1
    per_q = []
    for qid in redu_ids:
        q = redu_rows[qid]
        gold = q.get("answer")
        try:
            gold_n = int(re.search(r"\d+", str(gold)).group())
        except Exception:
            gold_n = None
        per_q.append({"qid": qid, "question": q["question"],
                      "domain": domain_from_question(q["question"])[1],
                      "gold": gold, "gold_n": gold_n, "gold_members": [],
                      "objects": sorted(per_q_objs[qid])})

    vocab = sorted(global_objs | cat_vocab)
    print(f"[embed] {len(vocab)} vocab strings...", file=sys.stderr)
    emb = {}
    for s in range(0, len(vocab), 256):
        chunk = vocab[s:s + 256]
        for k, v in zip(chunk, embed(chunk)):
            emb[k] = [float(x) for x in v]

    json.dump({"per_q": per_q, "obj_cats": obj_cats, "isa": isa,
               "objects": sorted(global_objs), "categories": sorted(cat_vocab),
               "domains": domains, "emb": emb}, open(OUT, "w"))
    print(f"\nwrote {OUT}: {len(global_objs)} objs, {len(cat_vocab)} cats, "
          f"{len(isa)} is-a edges")


if __name__ == "__main__":
    main()
