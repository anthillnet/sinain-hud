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
import json, os, re, urllib.request
import spacy
from embed_client import embed
from ig.linalg import cosine, unit

_NLP = spacy.load("en_core_web_sm")
# Broad user-action verbs. Recall-oriented: the per-object membership gate
# (category_members) provides precision, so extraction can cast wide across the
# predicate families reduction questions actually use — acquire/change AND
# use/consume/experience ("how many citrus fruits did I USE", "how many museums
# did I VISIT") — rather than acquisition only. Universal (not per-question).
_ACT = {
    # acquire / change / dispose
    "replace", "fix", "repair", "buy", "purchase", "get", "acquire", "install",
    "donate", "upgrade", "build", "add", "sell", "adopt", "make", "order", "rent",
    "find", "receive", "own",
    # use / consume / experience
    "use", "try", "eat", "drink", "cook", "plant", "grow", "read", "watch", "play",
    "take", "attend", "visit", "download", "join", "start", "complete", "finish",
    "tour", "explore", "taste", "wear",
}
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
    domain keyword) OR source-embed near the domain phrase — NOT bare-object geometry. Dedup by emb.

    NOTE: source-context membership over-admits (any action in a domain-mentioning window counts).
    Prefer category_members() below, which judges the OBJECT taxonomically via a small-model gate."""
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


def _singular(phrase: str) -> str:
    """Crude singularization of the category head ('plants' -> 'plant',
    'citrus fruits' -> 'citrus fruit') so the membership prompt reads naturally."""
    words = phrase.strip().split()
    if words:
        w = words[-1]
        if w.endswith("ies"):
            words[-1] = w[:-3] + "y"
        elif w.endswith("ses") or w.endswith("xes") or w.endswith("zes"):
            words[-1] = w[:-2]
        elif w.endswith("s") and not w.endswith("ss"):
            words[-1] = w[:-1]
    return " ".join(words)


def _member_gate(objects: list[str], category_phrase: str,
                 model=None, sz=10) -> list[str]:
    """Per-object TAXONOMIC membership judgment: 'is <object> a kind of <category>?'.

    This is the precision layer embeddings cannot provide — 'bookshelf' is NOT near
    'furniture' in cosine space, yet a capable small model KNOWS it (handoff: qwen2.5
    ≈ 93% on real-sentence categorization; phi4-mini was unreliable). Model is
    configurable via SINAIN_MEMBER_MODEL (default qwen2.5:7b). One-shot prompt +
    singular category. Batched yes/no; returns the affirmed subset, order preserved.
    Fail-open: on SLM error the batch passes through unfiltered (a dead gate degrades
    to over-admitting, never silently drops members)."""
    model = model or os.environ.get("SINAIN_MEMBER_MODEL", "qwen2.5:7b")
    cat = _singular(category_phrase)
    keep: list[str] = []
    for s in range(0, len(objects), sz):
        ch = objects[s:s + sz]
        p = (f"For each numbered item, answer 'N. yes' if the item itself is a kind of "
             f"{cat}, otherwise 'N. no'. Judge the item only, ignore context.\n"
             f"Example for category 'fruit': '1. apple' -> '1. yes'; '2. spoon' -> '2. no'.\n\n"
             + "\n".join(f"{i+1}. {o}" for i, o in enumerate(ch)))
        body = json.dumps({"model": model, "messages": [{"role": "user", "content": p}],
                           "stream": False, "options": {"temperature": 0, "num_predict": 160}}).encode()
        try:
            out = json.load(urllib.request.urlopen(urllib.request.Request(
                _OLLAMA, data=body, headers={"Content-Type": "application/json"}),
                timeout=60))["message"]["content"]
        except Exception:
            keep.extend(ch)  # fail-open: don't drop on gate failure
            continue
        verdict = {}
        for ln in out.splitlines():
            m = re.match(r"\s*(\d+)", ln)
            if m:
                verdict[int(m.group(1)) - 1] = ("yes" in ln.lower())
        for i, o in enumerate(ch):
            if verdict.get(i, False):
                keep.append(o)
    return keep


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")


def _ctokens(phrase: str) -> set[str]:
    """Singularized content tokens of a category phrase, for read-time matching
    a query ('plants') against stored hub labels ('plant', 'houseplant')."""
    toks = set()
    for w in re.findall(r"[a-z]{3,}", (phrase or "").lower()):
        if w in _STOP_CAT:
            continue
        toks.add(w)
        toks.add(re.sub(r"s$", "", w))  # crude singular
    return toks


_STOP_CAT = {"the", "different", "types", "type", "kind", "kinds", "piece", "pieces",
             "many", "much", "have", "did", "related", "various"}


def type_categories(edges, model_script: str = "session_distiller"):
    """WRITE-TIME category typing. Assign 1-3 hypernym category labels to each
    distinct user-action object, REUSING the distiller's configured model
    (call_llm(script=...) → one model in any mode, never a 2nd resident model;
    in local mode it's the local distiller, cloud mode the cloud distiller).

    The taxonomic knowledge ('bookshelf' is furniture; 'fender stratocaster' is a
    musical instrument) is baked in HERE, once per ingestion, with the GPU already
    warm — so read time (query_category_members) is a pure structural walk with no
    LLM and no second stream. Returns edges annotated with `categories: [...]`.
    Deterministic (temp 0, seed). Fail-open: returns edges with empty categories."""
    objs = sorted({e["object"] for e in edges if e.get("object")})
    if not objs:
        return []
    from common import call_llm
    sys_p = ("You label everyday objects with their general categories for a personal "
             "memory index. For each numbered item output 'N: cat1, cat2' — 1 to 3 broad "
             "category nouns the item is a KIND OF (general to specific), lowercased and "
             "singular. Examples: 'peace lily' -> '1: plant, houseplant'; 'fender "
             "stratocaster' -> '2: musical instrument, guitar'; 'fitbit versa' -> "
             "'3: device, fitness tracker'. Judge the item itself.")
    cats: dict[str, list[str]] = {}
    sz = 20  # batch so the response can't truncate on a big haystack's object set
    for s in range(0, len(objs), sz):
        chunk = objs[s:s + sz]
        user_p = "\n".join(f"{i+1}. {o}" for i, o in enumerate(chunk))
        try:
            out = call_llm(sys_p, user_p, script=model_script, temperature=0.0,
                           seed=42, max_tokens=600)
        except Exception:
            out = ""
        for ln in out.splitlines():
            m = re.match(r"\s*(\d+)\s*[:.)\-]\s*(.+)", ln)
            if not m:
                continue
            idx = int(m.group(1)) - 1
            if 0 <= idx < len(chunk):
                labels = [c.strip().lower() for c in re.split(r"[,;/|]", m.group(2)) if c.strip()]
                cats[chunk[idx]] = labels[:3]
    return [{**e, "categories": cats.get(e.get("object"), [])} for e in edges]


def persist_typed_edges(db_path: str, typed_edges, occurred_at: str):
    """Persist write-time typed edges as a structural category-hub index:
        entity:<obj>  value=<name> kind=action-object user_action=<verb> occurred_at
        entity:<obj>  member_of -> category:<label>   (ref)
        category:<label>  kind=category-hub value=<label>
    Read-time counting is then backrefs(category:<label>, 'member_of'). Returns
    (n_objects, n_membership_edges)."""
    from triplestore import TripleStore
    store = TripleStore(db_path)
    n_obj = n_edge = 0
    try:
        tx = store.begin_tx("typed-edges", metadata=json.dumps({"occurred_at": occurred_at}))
        for e in typed_edges:
            obj = (e.get("object") or "").strip()
            if not obj:
                continue
            oid = "entity:" + _slug(obj)
            store.assert_triple(tx, oid, "value", obj)
            store.assert_triple(tx, oid, "kind", "action-object")
            if e.get("relation"):
                store.assert_triple(tx, oid, "user_action", e["relation"])
            store.assert_triple(tx, oid, "occurred_at", occurred_at)
            n_obj += 1
            for cat in e.get("categories", []):
                cat = (cat or "").strip().lower()
                if not cat:
                    continue
                cid = "category:" + _slug(cat)
                store.assert_triple(tx, cid, "kind", "category-hub")
                store.assert_triple(tx, cid, "value", cat)
                store.assert_triple(tx, oid, "member_of", cid, value_type="ref")
                n_edge += 1
        store.commit_tx(tx)
    finally:
        store.close()
    return n_obj, n_edge


def query_category_members(db_path: str, category_phrase: str,
                           sim_floor: float = 0.55) -> list[str]:
    """READ-TIME structural walk (NO heavy LLM): distinct action-objects whose
    stored category hub MATCHES the query phrase, by token overlap OR embedding
    similarity. The hard taxonomic work (object->category) was done at write time,
    so read-time matching is only category-query <-> category-label ('plants' vs
    'houseplant'/'flower'), where embeddings ARE reliable — a cheap MiniLM compare,
    already on the retrieval hot path, not a second LLM stream."""
    from triplestore import TripleStore
    store = TripleStore(db_path)
    try:
        want = _ctokens(category_phrase)
        if not want:
            return []
        hubs = [(cid, label) for cid, label in store.entities_with_attr("value")
                if cid.startswith("category:")]
        if not hubs:
            return []
        # token-overlap matches (free) + embedding matches (cheap MiniLM)
        matched = {cid for cid, label in hubs if want & _ctokens(label)}
        try:
            qv = unit(embed([category_phrase])[0])
            lvs = embed([label for _, label in hubs])
            for (cid, _label), lv in zip(hubs, lvs):
                if cosine(qv, unit(lv)) >= sim_floor:
                    matched.add(cid)
        except Exception:
            pass  # token-overlap still applies if embeddings are unavailable
        members: dict[str, str] = {}
        for cid in matched:
            for oid, _attr in store.backrefs(cid, "member_of"):
                attrs = store.entity(oid)
                name = (attrs.get("value") or [""])[0]
                if name:
                    members[oid] = name
        return list(members.values())
    finally:
        store.close()


def category_members(edges, category_phrase: str, model=None,
                     dedup_cos=0.80, member_gate: bool = True) -> list[str]:
    """Resolve the distinct member set for `category_phrase` from typed edges.

    Coverage: dedup ALL candidate objects by embedding (no source-context prefilter,
    so members whose window doesn't name the category aren't dropped).
    Precision: a per-object membership gate (_member_gate) keeps only true members.
    This is the coverage×precision synthesis the prior count_category lacked."""
    objs = [e["object"] for e in edges if e.get("object")]
    if not objs:
        return []
    try:
        embs = [unit(v) for v in embed(objs)]
    except Exception:
        embs = [None] * len(objs)
    members, names = [], []
    for o, oe in zip(objs, embs):
        if oe is not None and any(cosine(oe, m) >= dedup_cos for m in members):
            continue
        if oe is not None:
            members.append(oe)
        names.append(o)
    if member_gate and names:
        names = _member_gate(names, category_phrase, model)
    return names
