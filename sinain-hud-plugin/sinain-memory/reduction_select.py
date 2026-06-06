"""reduction_select.py — query-time selection of scattered instance spans for reduction
("how many X …") questions, so the COMPLETE instance set reaches the QA call within budget.
No extra LLM call here (the QA call that already runs does the reasoning/precision).

Why this exists. For a reduction the answer-bearing raw chunks are already stored (raw_store
sidecar), but top-k SIMILARITY retrieval buries the scattered tail: a clothing item to "pick
up" is mentioned in a dry-cleaning chunk that sits far from "items of clothing"; a second
aquarium is crowded out by the heavily-discussed first one. Measured: gpt-4o answered the
clothing count as 1 (only the retrieved boots) when gold is 3 — blazer + boots-return are in
the raw store but never retrieved. Hand gpt-4o the right chunks and it answers 3.

How (the lesson from the failed v1, which ranked by object-class cosine and MISSED the gold).
The scattered tail is surfaced by the QUESTION'S OWN PREDICATE, not by topic similarity: the
blazer chunk carries "pick up", the boots chunk "return" — the exact verbs the question counts.
So selection = (A) chunks where the user performs a question-predicate action [the tail
similarity misses] UNION (B) top chunks by object-class embedding [topical coverage], each
reduced to its most relevant SHORT sentence so the whole set fits the budget and LEADs past the
excerpt cap. Recall-oriented; generous noise is fine because the (strong) reader does precision.
Deterministic spaCy + the free in-process embedder only. Generalizes COST_QUERY's altitude-LEAD
lever from spending-sums to all reductions.
"""
from __future__ import annotations
import json
import spacy
from raw_store import _sidecar_path

_NLP = spacy.load("en_core_web_sm")
_SUBJ_RE = None  # lazy
# light/auxiliary verbs that are not the counted ACTION ("do I need to pick up or return")
_SKIP_VERBS = {"do", "be", "have", "need", "want", "can", "will", "would", "should",
               "go", "use", "make", "take", "think", "plan", "try"}


def object_class(question: str) -> str | None:
    """The object-class noun phrase a 'how many X …' question counts. Deterministic: the span
    after 'many' up to the first verb/aux/subject-pronoun (skipping punctuation)."""
    doc = _NLP(question)
    toks = list(doc)
    mi = next((i for i, t in enumerate(toks) if t.lower_ == "many"), None)
    if mi is None:
        return None
    out: list[str] = []
    for t in toks[mi + 1:]:
        if t.pos_ in ("VERB", "AUX") or t.lower_ in ("do", "did", "have", "has", "i", "i've"):
            break
        if t.is_punct:
            continue
        # carry "items OF clothing", "types OF citrus" — a bare head noun ("items", "types",
        # "pieces") is too generic; the prep complement is the real class.
        if t.pos_ in ("NOUN", "PROPN", "ADJ", "CCONJ") or t.lower_ in ("or", "of"):
            out.append(t.text)
        elif out:
            break
    return " ".join(out).strip().lower() or None


def question_action_verbs(question: str) -> set[str]:
    """The action-verb lemmas the question counts ('pick up or return' -> {pick, return};
    'own' -> {own}). Light/aux verbs dropped. Empty for stative questions ('how many fish are
    there'), which then lean on the class-noun signal instead."""
    doc = _NLP(question)
    return {t.lemma_.lower() for t in doc
            if t.pos_ == "VERB" and t.lemma_.lower() not in _SKIP_VERBS}


_CLASS_STOP = {"many", "total", "number", "kind", "kinds", "type", "types", "item", "items",
               "piece", "pieces", "day", "days", "time", "times", "store"}


def question_class_tokens(question: str) -> set[str]:
    """The content nouns the question is ABOUT — its object class and container ('fish',
    'aquariums', 'clothing', 'instruments'). A user-sentence that mentions one of these is a
    candidate even with no action verb (the stative 'how many fish in my aquariums' case, where
    the 10-gallon tank surfaces via 'my … fish'). Generic counting nouns are dropped so they
    don't match everything."""
    doc = _NLP(question)
    toks = list(doc)
    mi = next((i for i, t in enumerate(toks) if t.lower_ == "many"), None)
    after = toks[mi + 1:] if mi is not None else toks
    return {t.lemma_.lower() for t in after
            if t.pos_ in ("NOUN", "PROPN") and t.lemma_.lower() not in _CLASS_STOP and len(t) > 2}


def _sentences(text: str) -> list[str]:
    return [s.text.strip() for s in _NLP(text).sents if s.text.strip()]


def _has_user(text: str) -> bool:
    tl = " " + text.lower() + " "
    return any(p in tl for p in (" i ", " i'", " my ", " mine ", " we ", " our ", "user"))


def _user_candidate_sentence(sent: str, verbs: set[str], class_tokens: set[str]) -> bool:
    """The sentence is about the user (I/my/we) AND carries a question-predicate verb OR a
    question class noun. Deliberately NOT requiring the verb to have a direct nsubj=I child — the
    subject often attaches to a matrix verb ("I need to RETURN…", "I'll take a break and PICK
    up…"), so that strict check drops the real tail. The class-noun branch catches stative
    questions ("…upgraded my old 10-gallon tank, which has my betta fish"). Recall-oriented; the
    QA reader sorts out who did/has what."""
    if not _has_user(sent):
        return False
    lemmas = {t.lemma_.lower() for t in _NLP(sent)}
    return bool((verbs and (verbs & lemmas)) or (class_tokens & lemmas))


def _load_recs(db_path: str) -> list[dict]:
    side = _sidecar_path(db_path)
    if not side.exists():
        return []
    return [json.loads(l) for l in side.read_text().splitlines() if l.strip()]


def select_instance_spans(db_path: str, question: str,
                          max_spans: int = 12, span_chars: int = 220) -> list[str]:
    """Short instance sentences for a reduction question. Predicate-matching user-action
    sentences (the scattered tail) LEAD; object-class-topical chunks fill. Recall-oriented;
    the QA reader does precision. Empty if not 'how many' or no sidecar."""
    cls = object_class(question)
    if not cls:
        return []
    recs = _load_recs(db_path)
    if not recs:
        return []
    verbs = question_action_verbs(question)
    class_tokens = question_class_tokens(question)

    from embed_client import embed
    from ig.linalg import cosine, unit
    import numpy as np

    clsv = np.array(unit(embed([cls])[0]), dtype=float)

    # (A) RECALL tail — user-sentences carrying a question-predicate verb (the blazer "pick up",
    # the boots "return") OR a question class noun (stative: "…my old 10-gallon tank, which has my
    # betta fish"). These are exactly the scattered mentions similarity retrieval ranks too low.
    _pre = verbs | class_tokens
    tail: list[str] = []
    seen_t = set()
    for r in recs:
        tl = r["text"].lower()
        if _pre and not any(w in tl for w in _pre):   # cheap lexical prefilter before the parse
            continue
        for s in _sentences(r["text"]):
            if _user_candidate_sentence(s, verbs, class_tokens):
                key = s[:80].lower()
                if key not in seen_t:
                    seen_t.add(key)
                    tail.append(s[:span_chars])

    # (B) TOPICAL coverage — top chunks by object-class cosine (precomputed chunk embeddings).
    mat = np.array([r["emb"] for r in recs], dtype=float)
    sims = mat @ clsv / (np.linalg.norm(mat, axis=1) * (np.linalg.norm(clsv) + 1e-9) + 1e-9)
    topical: list[str] = []
    for i in list(np.argsort(sims)[::-1])[: max_spans * 2]:
        # the user-sentence in this chunk closest to the object class (keep it short)
        cand = [s for s in _sentences(recs[i]["text"]) if _has_user(s)] or _sentences(recs[i]["text"])
        if cand:
            topical.append(cand[0][:span_chars])

    # Rank the recall tail so the highest-signal mentions lead (it can be large): a
    # question-predicate verb is the strongest signal, a class noun next, and a DIGIT marks the
    # count-bearing inventory sentences ("10 neon tetras", "10-gallon tank") over generic chatter.
    import re as _re
    def _tail_score(s: str) -> float:
        lem = {t.lemma_.lower() for t in _NLP(s)}
        return (2.0 * len(verbs & lem) + 1.0 * len(class_tokens & lem)
                + (1.5 if _re.search(r"\d", s) else 0.0))
    tail = sorted(tail, key=_tail_score, reverse=True)[: max_spans]

    # Merge: recall tail FIRST (LEADs — it's the recall the reader is missing), then topical.
    ordered = tail + topical
    out: list[str] = []
    vecs: list = []
    seen_text: set[str] = set()
    for s in ordered:
        if len(out) >= max_spans:
            break
        k = s[:80].lower()
        if k in seen_text:
            continue
        ev = unit(embed([s])[0])
        if any(cosine(ev, v) >= 0.93 for v in vecs):   # near-duplicate sentence
            continue
        seen_text.add(k)
        vecs.append(ev)
        out.append(s)
    return out
