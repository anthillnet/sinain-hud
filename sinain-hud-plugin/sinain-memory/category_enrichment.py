"""category_enrichment.py — ingestion-time typed-edge enrichment for multi-session reductions.

Runs AT INGESTION (after distillation) over RAW CHUNKS (100% info, pre-compression) ∪ distilled facts
(catches raw-window fragments). Produces typed (verb, object, category) edges that the integrator stores
so reductions resolve by a `backrefs()` graph walk instead of the conjunctive-recall gamble.

Stages (each sized to its tool — no load on the distillation LLM):
1. spaCy SVO (deterministic) — (user/I subject, action-verb, dobj object). Pre-filters: only source
   texts that STATE a user-action reach the gate (~tens, not thousands of raw chunks).
2. phi4-mini gate (small SLM, batched) — keep only genuine action-on-a-countable-thing.
3. fact-context category (keyword in source OR source-embed near domain) — NOT object-embedding
   in isolation ("kitchen items" is a contextual grouping that cuts across object types).
4. dedup objects (embedding) → the category hub member set.

Validated: kitchen case 5/5 (raw recovers the donation-phrased coffee maker distillation dropped;
distilled catches the toaster raw-windowing fragments; union is complete). See
.planning/INVESTIGATION-unscatter-multisession.md.
"""
from __future__ import annotations
import json, re, urllib.request
import spacy
from embed_client import embed
from ig.linalg import cosine, unit

_NLP = spacy.load("en_core_web_sm")
_ACT = {"replace", "fix", "repair", "buy", "purchase", "get", "acquire", "install", "donate",
        "upgrade", "build", "add", "sell", "attend", "download", "adopt", "make"}
_OLLAMA = "http://localhost:11434/api/chat"
_FIRST = ("user", "i", "we")
_FIRST_POSS = {"my", "our", "mine", "ours"}


def _subject_kind(verb) -> str:
    """Classify the subject of an action verb by walking the conjunction/clausal
    chain, so a conjoined verb inherits its head's subject:
      'I fixed the sink and installed a disposal' -> 'installed' (conj of 'fixed')
      inherits the 'I' subject.
    Returns:
      'explicit' — a first-person/user subject (direct or inherited),
      'blocked'  — an explicit NON-user subject (don't attribute to the user),
      'none'     — no subject in the chain (sentence-initial implied first person).
    """
    t = verb
    seen: set[int] = set()
    while t is not None and id(t) not in seen:
        seen.add(id(t))
        subs = [c for c in t.children if c.dep_ in ("nsubj", "nsubjpass")]
        if subs:
            return "explicit" if any(s.lemma_.lower() in _FIRST for s in subs) else "blocked"
        if t.dep_ in ("conj", "xcomp", "advcl", "ccomp") and t.head is not t \
                and t.head.pos_ in ("VERB", "AUX"):
            t = t.head
        else:
            break
    return "none"


def _svo(text: str):
    """(action-verb, object) where the user is the subject. Deterministic spaCy.

    The direct object may be a common NOUN (faucet, mat) OR a PROPN instance name
    (Fender Stratocaster, Fitbit). PROPN is kept ONLY as the dobj: salience proper-nouns
    (Moen, IKEA, Goodwill) sit in prep phrases ("donated to Goodwill", "from IKEA") — they
    parse as pobj under a prep, never a dobj — so admitting PROPN objects recovers the
    instance names without leaking the brand/store/donee salience entities. Compound
    modifiers of either POS are folded in so "Korg B1 piano" survives intact.

    Subject handling (recall fix): conjoined verbs inherit the head's user subject;
    a subjectless action verb ('Donated my old coffee maker...') is admitted ONLY when
    its object carries a first-person possessive ('my'/'our') — a high-precision diary
    form — so implied-first-person actions are recovered without leaking imperatives."""
    out = []
    for tok in _NLP(text):
        if tok.pos_ != "VERB" or tok.lemma_.lower() not in _ACT:
            continue
        kind = _subject_kind(tok)
        if kind == "blocked":
            continue
        for c in tok.children:
            if c.dep_ in ("dobj", "obj") and c.pos_ in ("NOUN", "PROPN"):
                if kind == "none":
                    has_poss = any(
                        m.lemma_.lower() in _FIRST_POSS
                        for m in c.children if m.dep_ in ("poss", "det", "nmod")
                    )
                    if not has_poss:
                        continue
                comp = [m.text for m in c.children if m.dep_ == "compound" and m.pos_ in ("NOUN", "PROPN")]
                out.append((tok.lemma_.lower(), " ".join(comp + [c.text]).lower()))
    return out


def _gate(sources, model="phi4-mini:latest", sz=6):
    """Batched action-item gate over the SVO-bearing source texts. Returns the kept set of indices."""
    keep = set()
    for s in range(0, len(sources), sz):
        ch = sources[s:s + sz]
        p = ("For each line answer the number then yes or no: did the user obtain, change, fix, give "
             "away, or attend a specific thing?\n" + "\n".join(f"{i+1}. {f}" for i, f in enumerate(ch)))
        body = json.dumps({"model": model, "messages": [{"role": "user", "content": p}],
                           "stream": False, "options": {"temperature": 0, "num_predict": 120}}).encode()
        try:
            out = json.load(urllib.request.urlopen(urllib.request.Request(
                _OLLAMA, data=body, headers={"Content-Type": "application/json"}), timeout=60))["message"]["content"]
        except Exception:
            continue
        for ln in out.splitlines():
            m = re.match(r"\s*(\d+)", ln)
            if m and "yes" in ln.lower():
                keep.add(s + int(m.group(1)) - 1)
    return keep


def enrich(distilled_facts: list[str], raw_chunks: list[str],
           gate_model="phi4-mini:latest", gate: bool = True):
    """Return typed evidence edges for gate-passing user-action-on-object events,
    extracted over RAW CHUNKS ∪ distilled facts. Each edge:
        {subject:'user', relation:<verb>, verb:<verb>, object:<obj>,
         source:<text>, origin:'raw'|'distilled', confidence:float}
    The integrator (SINAIN_TYPED_EDGES) stores these as evidence:* triples;
    count_category() consumes `source`/`object` for query-relative category
    filtering at read time. `verb` is retained for backward compatibility.

    gate=False bypasses the phi4-mini precision gate — used to measure raw SVO
    recall separately from gate precision during shadow validation."""
    triples = []  # (verb, object, source_text, origin)
    for t in list(raw_chunks):
        for v, o in _svo(t):
            triples.append((v, o, t, "raw"))
    for t in list(distilled_facts):
        for v, o in _svo(t):
            triples.append((v, o, t, "distilled"))
    if not triples:
        return []
    if gate:
        keep = _gate([t for _, _, t, _ in triples], gate_model)
    else:
        keep = set(range(len(triples)))
    return [
        {"subject": "user", "relation": v, "verb": v, "object": o,
         "source": t, "origin": origin,
         "confidence": 0.85 if origin == "distilled" else 0.8}
        for i, (v, o, t, origin) in enumerate(triples) if i in keep
    ]


def count_category(edges, domain_keywords: list[str], domain_phrase: str,
                   ctx_floor=0.32, dedup_cos=0.80):
    """Count distinct objects in the queried category. Category = FACT CONTEXT (source mentions a
    domain keyword) OR source-embed near the domain phrase — NOT bare-object geometry. Dedup by emb."""
    dv = unit(embed([domain_phrase])[0])
    members, names = [], []
    for e in edges:
        src = e["source"].lower()
        in_cat = any(k in src for k in domain_keywords) or cosine(dv, unit(embed([e["source"]])[0])) > ctx_floor
        if not in_cat:
            continue
        oe = unit(embed([e["object"]])[0])
        if any(cosine(oe, m) >= dedup_cos for m in members):
            continue
        members.append(oe); names.append(e["object"])
    return names
