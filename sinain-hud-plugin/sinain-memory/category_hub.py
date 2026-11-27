"""category_hub.py — PROTOTYPE of the action-object + predicate category-hub builder.

The multi-session count failures root-cause to salience-over-role entity extraction: facts link to the
flashy proper-noun (entity:moen) not the action-object (faucet). This builds the MISSING structure:
extract the OBJECTS the user acted on (spaCy noun chunks), keep only facts carrying a CHANGE-predicate
(replaced/fixed/got/donated/...), assign objects to a category by proximity to a category PROTOTYPE
(members resemble the category hub, not each other), dedup → the enumerable SET. Count = len(set).

Deterministic, no LLM (spaCy parse + embeddings only). Standalone so it runs post-hoc on existing
stores for validation; the production version moves this typing into the integrator (write-time).
See .planning/INVESTIGATION-unscatter-multisession.md.
"""
from __future__ import annotations
import spacy
from embed_client import embed
from ig.linalg import cosine, unit

_NLP = spacy.load("en_core_web_sm")

# user CHANGE-action lemmas (the predicate that makes an object a countable instance of "things I X")
CHANGE_LEMMAS = {"replace", "fix", "repair", "buy", "purchase", "get", "acquire", "install",
                 "donate", "upgrade", "add", "build", "make", "sell", "attend", "lead", "own",
                 "view", "visit", "complete", "raise"}
CHANGE_KW = {"new", "replaced", "fixed", "repaired", "bought", "purchased", "installed",
             "donated", "upgraded", "acquired", "got"}


def extract_objects(text: str) -> list[str]:
    """The common-noun OBJECTS the fact is about. Crucially DROP PROPER NOUNS — those are the salience
    entities (Moen/IKEA/Goodwill) that the current extractor wrongly anchors on; we want the action-
    object (faucet/mat/coffee maker). Keep only NOUN tokens (+ noun compounds), drop ADJ/PROPN/DET."""
    doc = _NLP(text)
    out = []
    for nc in doc.noun_chunks:
        if nc.root.pos_ != "NOUN":                       # head must be a common noun, not PROPN
            continue
        toks = [t.text for t in nc if t.pos_ == "NOUN"]  # keep only common nouns (drops adj + propn)
        phrase = " ".join(toks).strip().lower()
        if len(phrase) > 2:
            out.append(phrase)
    return out


def question_predicate(question: str) -> set[str]:
    """The verb lemmas the question asks to count ('how many X did I REPLACE or FIX' -> {replace,fix}).
    The question states the predicate; use it instead of a fixed superset."""
    doc = _NLP(question)
    return {t.lemma_.lower() for t in doc if t.pos_ == "VERB" and t.lemma_.lower() not in ("do", "be", "have")}


def extract_user_action_objects(text: str, verbs: set[str] | None = None) -> list[str]:
    """STRICT SVO: direct-objects of a CHANGE-verb whose subject is the user/I. The principled
    'user —verb→ object' edge. Clean (no co-occurrence noise) but requires the fact to actually STATE
    the user's action — which the distiller often drops ('I got a new faucet' → 'the new faucet has a
    sensor'), so this MISSES distillation-damaged instances. That gap is the finding: typing must
    happen at distillation, from raw text, not post-hoc on lossy facts."""
    doc = _NLP(text)
    out = []
    for tok in doc:
        vset = verbs if verbs is not None else CHANGE_LEMMAS
        if tok.pos_ == "VERB" and tok.lemma_.lower() in vset:
            subj = [c for c in tok.children if c.dep_ == "nsubj"]
            if not any(s.lemma_.lower() in ("user", "i") for s in subj):
                continue
            for c in tok.children:
                if c.dep_ in ("dobj", "obj") and c.pos_ == "NOUN":
                    # clean noun phrase: head noun + only its immediate compound/amod NOUN modifiers
                    # (NOT the whole subtree — that swept in "years"/"rhythms" from attached phrases)
                    comp = [m.text for m in c.children if m.dep_ == "compound" and m.pos_ == "NOUN"]
                    phrase = " ".join(comp + [c.text]).lower()
                    out.append(phrase)
    return out


def has_change_predicate(text: str) -> bool:
    doc = _NLP(text)
    if {t.lemma_.lower() for t in doc} & CHANGE_LEMMAS:
        return True
    return any(k in text.lower() for k in CHANGE_KW)


def build_category_set(facts: list[str], category_phrase: str,
                       cat_floor: float = 0.42, dedup_cos: float = 0.80,
                       require_predicate: bool = True) -> list[str]:
    """The enumerable set for '<category> I <changed>': objects in the category region (cosine to the
    category prototype >= cat_floor) drawn from change-predicate facts, deduplicated. Returns the
    distinct member objects; len() is the count."""
    proto = unit(embed([category_phrase])[0])
    members = []  # (object_text, unit_vec)
    for f in facts:
        if require_predicate and not has_change_predicate(f):
            continue
        for obj in extract_objects(f):
            e = unit(embed([obj])[0])
            if cosine(proto, e) < cat_floor:
                continue
            if any(cosine(e, m) >= dedup_cos for _, m in members):
                continue
            members.append((obj, e))
    return [m for m, _ in members]
