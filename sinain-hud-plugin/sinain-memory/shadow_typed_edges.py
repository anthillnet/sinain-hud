#!/usr/bin/env python3
"""shadow_typed_edges.py — P2 shadow validation (no QA, no ingestion wiring).

The gating experiment per .planning/research-2026-06-08-multisession-memory.md:
does typed action-edge extraction (category_enrichment.enrich) recover the
COMPLETE member set for multi-session reduction questions — i.e. does the deduped
member count match the gold count? If yes, typed edges are worth wiring into
ingestion (P2b) + the reduction path (P3). If no, the approach is coverage-bound
and we learn that before investing.

Runs over the FULL haystack of each question (production-realistic: we don't know
which sessions are relevant), local-only (spaCy + optional phi4-mini gate), so it
does not contend with the cloud bench.

Usage:
    python3 shadow_typed_edges.py <dataset.jsonl> [--gate] [--limit N]
"""
import json
import re
import sys

import spacy
import category_enrichment as ce
from raw_store import _window_split

_NLP = spacy.load("en_core_web_sm")
_STOP_DOMAIN = {"did", "have", "has", "do", "does", "are", "is", "was", "were",
                "i", "you", "the", "a", "an", "in", "on", "to", "of", "my"}


def domain_from_question(q: str):
    """Derive (keywords, domain_phrase) from a 'how many/much X' question.
    Pulls the noun phrase between the quantifier and the first verb/aux — the
    category the user is counting. Universal (no per-question tuning)."""
    ql = q.lower().strip()
    m = re.search(r"how many\s+(?:different\s+)?(.+?)\s+(did|have|has|do|does|are|is|was|were|that|in|on|over|during|will)\b", ql)
    if not m:
        m = re.search(r"how many\s+(?:different\s+)?([a-z\s]+?)[\?\.]", ql)
    if m:
        phrase = m.group(1).strip()
    else:
        # fallback: longest noun chunk
        chunks = [c.text for c in _NLP(ql).noun_chunks]
        phrase = max(chunks, key=len) if chunks else ql
    kws = [w for w in re.findall(r"[a-z]{3,}", phrase) if w not in _STOP_DOMAIN]
    # singularize crude plurals so 'plants' matches 'plant'
    kws = list({re.sub(r"s$", "", w) for w in kws} | set(kws))
    return kws, phrase


def sessions_to_texts(haystack_sessions):
    """Flatten each session, then window it (~700c) so the category-context
    source is sentence-level — a whole-session source would let any edge in a
    plant-mentioning session count as a 'plant' member (over-admit). Windowing
    mirrors raw_store's chunking, the real production excerpt granularity."""
    out = []
    for sess in haystack_sessions or []:
        parts = []
        for turn in sess if isinstance(sess, list) else []:
            if isinstance(turn, dict):
                parts.append(turn.get("content") or turn.get("text") or "")
        t = "\n".join(p for p in parts if p).strip()
        if t:
            out.extend(_window_split(t))
    return out


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/lme_reductions.jsonl"
    gate = "--gate" in sys.argv
    limit = None
    for i, a in enumerate(sys.argv):
        if a == "--limit":
            limit = int(sys.argv[i + 1])

    rows = [json.loads(l) for l in open(path) if l.strip()]
    if limit:
        rows = rows[:limit]
    print(f"shadow typed-edge validation: {len(rows)} questions, gate={'ON' if gate else 'OFF'}\n")
    hits = 0
    for q in rows:
        qid = q.get("question_id") or q.get("id")
        gold = q.get("answer")
        question = q.get("question", "")
        sessions = sessions_to_texts(q.get("haystack_sessions"))
        kws, phrase = domain_from_question(question)
        # Window long sessions so spaCy stays fast; enrich over raw sessions only
        # (distilled facts aren't available here — pure raw-recovery measurement).
        edges = ce.enrich([], sessions, gate=gate)
        # SVO (recall) -> per-object membership gate (precision). Membership gate
        # judges the OBJECT taxonomically ('is X a <category>?'), the precision
        # layer source-context count_category lacked. --no-member-gate for A/B.
        mg = "--no-member-gate" not in sys.argv
        members = ce.category_members(edges, phrase, member_gate=mg) if edges else []
        try:
            gold_n = int(re.search(r"\d+", str(gold)).group())
        except Exception:
            gold_n = None
        n = len(members)
        ok = (gold_n is not None and n == gold_n)
        hits += ok
        print(f"[{qid}] {question[:62]}")
        print(f"    gold={gold!r}  domain={phrase!r}  edges={len(edges)}  members={n}  {'✓' if ok else ''}")
        print(f"    members: {members[:10]}")
    print(f"\nexact-count match: {hits}/{len(rows)}")


if __name__ == "__main__":
    main()
