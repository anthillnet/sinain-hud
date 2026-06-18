#!/usr/bin/env python3
"""Graph Query — entity-based lookup of knowledge graph facts.

Thin wrapper around triplestore.py for querying facts by entity/domain.
Used by sinain-core (via HTTP endpoint) and sinain-mcp-server (via subprocess).

Usage:
    python3 graph_query.py --db memory/knowledge-graph.db \
        --entities '["react-native", "metro-bundler"]' \
        [--max-facts 5] [--format text|json]
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

# all-MiniLM is pre-cached locally; never phone HuggingFace Hub at runtime. An
# unguarded hub-check on cold store rebuilds hung the bench (iter 6). All our
# embeddings are local or via OpenRouter — HF is only the model's distribution
# origin, not a runtime service. setdefault lets a first-time setup override.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

# Preference-shape detection (shared by the dd0c94c preference augmentation and the #7-PREF
# scaffold). NOTE: _USER_REF was referenced at the preference-augment site but never defined or
# imported here — the surrounding `except Exception: pass` silently swallowed the NameError, so
# that augmentation had been DEAD since dd0c94c. Defining it here revives it. Mirrors
# knowledge_integrator._USER_REF.
_USER_REF = re.compile(r"\b(?:the user(?:'s|s')?|the user is|user's)\b", re.IGNORECASE)
_PREF_PRED = re.compile(r"\b(prefer|prefers|like|likes|love|loves|enjoy|enjoys|"
                        r"favou?rite|interested in|into|a fan of|want|wants|own|owns|"
                        r"use[sd]?|dislike|dislikes|avoid|avoids|hate|hates)\b", re.IGNORECASE)


def _preference_scaffold(results: list[dict], max_constraints: int = 8):
    """#7-PREF: the sufficient statistic for a recommendation request is the user's domain-relevant
    preference CONSTRAINT-SET. The failure here is answer-side, not retrieval (on 0edc2aef the gold
    preference WAS retrieved yet QA answered "no info about your preferences") — so the fix is
    framing: collect the preference facts already in `results` and present them as an explicit,
    labelled constraint list with an anti-abstention directive, so the QA model recognises it HAS
    the preferences and must apply them. Deterministic-fill-only: every constraint is verbatim from
    a retrieved fact. Returns None when no preference facts are present (fail-safe off)."""
    seen = set(); cons = []
    for f in results:
        if f.get("kind") == "scaffold" or f.get("source") == "raw-excerpt":
            continue
        _v = f.get("value", "")
        _v = _v[0] if isinstance(_v, list) else _v
        _v = str(_v).strip()
        if _v and _USER_REF.search(_v) and _PREF_PRED.search(_v):
            key = _v[:60].lower()
            if key not in seen:
                seen.add(key); cons.append(_v[:160])
        if len(cons) >= max_constraints:
            break
    if not cons:
        return None
    _lst = "; ".join(f"{i + 1}. {c}" for i, c in enumerate(cons))
    return {"entity_id": "scaffold:preference", "kind": "scaffold",
            "value": ("You DO have information about the user's preferences — base your "
                      "recommendation on them; do NOT reply that you lack preference information. "
                      f"Known user preferences relevant to this request: {_lst}.")}


def query_facts_by_entities(
    db_path: str,
    entities: list[str],
    max_facts: int = 5,
) -> list[dict]:
    """Query knowledge graph for facts matching keywords via tag index.

    Uses auto-extracted 'tag' attributes for discovery. Results ranked by
    number of matching tags (more matches = more relevant). Falls back to
    domain/entity_id matching for untagged facts.
    """
    if not Path(db_path).exists():
        return []

    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)

        keywords = [e.lower().replace(" ", "-") for e in entities]

        # Primary: tag-based ranked search.
        ranked = store.tag_ranked_search(keywords, limit=max_facts * 3)
        fact_ids = [eid for eid, _ in ranked]
        tag_matches = dict(ranked)

        # Fallback: if tag matches < max_facts, search by domain / entity_id slug.
        if len(fact_ids) < max_facts:
            fallback = store.entity_id_or_domain_search(
                keywords, exclude_ids=fact_ids, limit=max_facts - len(fact_ids),
            )
            fact_ids.extend(fallback)

        # Load full attributes for each fact
        facts = []
        for fid in fact_ids:
            attrs = store.entity(fid)
            if not attrs:
                continue
            fact = {"entity_id": fid}
            for attr_name, values in attrs.items():
                if attr_name == "tag":
                    continue  # Don't include tags in output (noise)
                fact[attr_name] = values[0] if len(values) == 1 else values
            facts.append(fact)

        # Rank by tag-match count first, then confidence. A confidence-only
        # sort let many 1-tag facts at 0.9 bury a fact matching every
        # keyword at 0.7 — match count is the stronger relevance signal.
        facts.sort(
            key=lambda f: (tag_matches.get(f["entity_id"], 0),
                           float(f.get("confidence", "0"))),
            reverse=True,
        )
        store.close()
        return facts[:max_facts]
    except Exception as e:
        print(f"[warn] Graph query failed: {e}", file=sys.stderr)
        return []


def query_top_facts(db_path: str, limit: int = 30) -> list[dict]:
    """Query top-N facts by confidence for knowledge doc rendering."""
    if not Path(db_path).exists():
        return []

    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)

        top = store.top_facts_by_confidence(limit=limit)
        facts = []
        for fid, _conf in top:
            attrs = store.entity(fid)
            if not attrs:
                continue
            fact = {"entity_id": fid}
            for attr_name, values in attrs.items():
                fact[attr_name] = values[0] if len(values) == 1 else values
            facts.append(fact)

        store.close()
        return facts
    except Exception as e:
        print(f"[warn] Graph top-facts query failed: {e}", file=sys.stderr)
        return []


def query_facts_fts(db_path: str, query: str, max_facts: int = 10,
                    with_scores: bool = False) -> list[dict]:
    """Substring search across fact `value` triples (Oxigraph backend).

    Replaces the SQLite FTS5 path with a CONTAINS-style scan in the SPARQL/RDF
    layer. Accepts the same "term1 AND term2" / "term1 OR term2" syntax the
    callers used to feed FTS5; default is AND across whitespace-split tokens.

    With ``with_scores=True`` each returned fact carries ``_fts_score`` (its Okapi
    BM25 relevance) so the entropy-weighted fusion (#4) can measure how peaked this
    query's keyword match is. Default leaves the score off (no caller impact).
    """
    if not Path(db_path).exists():
        return []

    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)

        ranked = store.fts_search(query, limit=max_facts, with_scores=with_scores)
        if not ranked:
            store.close()
            return []

        # Fetch full attributes for matched entities
        facts = []
        for item in ranked:
            eid, score = item if with_scores else (item, None)
            attrs = store.entity(eid)
            fact = {"entity_id": eid, "entity": eid.split(":")[-1].rsplit("-", 1)[0] if ":" in eid else eid}
            for attr, values in attrs.items():
                if attr == "tag":
                    continue
                fact[attr] = values[0] if len(values) == 1 else values
            if with_scores:
                fact["_fts_score"] = score
            facts.append(fact)

        store.close()
        return facts[:max_facts]
    except Exception:
        return []


def query_facts_by_entity_graph(
    db_path: str,
    entity_name: str,
    max_facts: int = 10,
) -> list[dict]:
    """Find facts about an entity via VAET backref traversal.

    Uses the entity graph layer: entity:* nodes linked to fact:* nodes
    via 'about' ref edges. Also follows 'mentions' ref edges for
    cross-entity context.
    """
    if not Path(db_path).exists():
        return []

    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)

        entity_node_id = f"entity:{entity_name.lower().replace(' ', '-')}"
        if not store.entity(entity_node_id):
            store.close()
            return []

        # Get all facts linked to this entity via "about" ref edge
        fact_refs = store.backrefs(entity_node_id, attribute="about")
        # Also get facts that "mention" this entity
        mention_refs = store.backrefs(entity_node_id, attribute="mentions")
        all_refs = fact_refs + mention_refs

        # Load fact details
        seen = set()
        facts = []
        for fact_eid, _ in all_refs:
            if fact_eid in seen or not fact_eid.startswith("fact:"):
                continue
            seen.add(fact_eid)
            attrs = store.entity(fact_eid)
            if attrs and "value" in attrs:
                fact = {"entity_id": fact_eid}
                for attr, values in attrs.items():
                    if attr == "tag":
                        continue
                    fact[attr] = values[0] if len(values) == 1 else values
                facts.append(fact)

        store.close()
        return facts[:max_facts]
    except Exception:
        return []


def expand_entity_community(
    store,
    entity_name: str,
    max_related: int = 3,
    max_facts_per_entity: int = 30,
) -> list[tuple[str, int]]:
    """Find related entities by following entity → facts → mentioned entities.

    Returns [(entity_name, co_mention_count), ...] sorted by frequency.
    """
    entity_node_id = f"entity:{entity_name.lower().replace(' ', '-')}"
    if not store.entity(entity_node_id):
        return []

    # Collect facts linked to this entity (both about and mentions)
    fact_ids = set()
    for fact_eid, _ in store.backrefs(entity_node_id, attribute="about")[:max_facts_per_entity]:
        if fact_eid.startswith("fact:"):
            fact_ids.add(fact_eid)
    for fact_eid, _ in store.backrefs(entity_node_id, attribute="mentions")[:max_facts_per_entity]:
        if fact_eid.startswith("fact:"):
            fact_ids.add(fact_eid)

    # Follow each fact's outgoing refs to find other entity nodes
    related_counts: dict[str, int] = {}
    for fact_eid in fact_ids:
        attrs = store.entity(fact_eid)
        for ref_attr in ("about", "mentions"):
            targets = attrs.get(ref_attr, [])
            if not isinstance(targets, list):
                targets = [targets]
            for target in targets:
                if isinstance(target, str) and target.startswith("entity:") and target != entity_node_id:
                    name = target[len("entity:"):]
                    related_counts[name] = related_counts.get(name, 0) + 1

    # Sort by frequency, return top N
    ranked = sorted(related_counts.items(), key=lambda x: -x[1])
    return ranked[:max_related]


def _cooccurring_entities(
    store,
    fact_ids: set[str],
    max_entities: int = 3,
) -> list[str]:
    """Find entities that co-occur in the same distillation pass (shared first_seen timestamp).

    Dead-code path retained for API parity; query_facts_hybrid uses
    expand_entity_community / session_co_occurrence instead.
    """
    if not fact_ids:
        return []

    # Get first_seen timestamps for the input facts
    timestamps: set[str] = set()
    for fid in list(fact_ids)[:20]:  # cap to avoid huge queries
        attrs = store.entity(fid)
        fs = attrs.get("first_seen", [])
        if isinstance(fs, list) and fs:
            timestamps.add(fs[0])
        elif isinstance(fs, str):
            timestamps.add(fs)

    if not timestamps:
        return []

    # Walk facts that share these timestamps; collect their `entity` attribute values.
    fact_ids_set = set(fact_ids)
    counts: dict[str, int] = {}
    co_facts = store.facts_by_first_seen(list(timestamps), limit=200)
    rows: list[tuple[str]] = []
    for f_eid in co_facts:
        if f_eid in fact_ids_set:
            continue
        attrs = store.entity(f_eid)
        names = attrs.get("entity", [])
        if isinstance(names, str):
            names = [names]
        for name in names:
            rows.append((name,))

    for (name,) in rows:
        counts[name] = counts.get(name, 0) + 1
    ranked = sorted(counts, key=lambda x: -counts[x])
    return ranked[:max_entities]


_SEMANTIC_CACHE: dict = {}  # {"db_path": {"names": [...], "embs": ndarray, "ts": float}}


def _expand_keywords_semantic(
    keywords: list[str],
    db_path: str,
    threshold: float = 0.50,
    max_expansions: int = 3,
) -> list[str]:
    """Expand keywords with semantically similar entity names from the graph.

    "AI" → ["ai", "machine-learning", "ai-agents", ...]. Caches model + entity
    embeddings for fast repeated calls (<50ms after first load).
    """
    import time as _t
    try:
        import numpy as np
        from common import load_sentence_transformer
        from triplestore import TripleStore

        if not hasattr(_expand_keywords_semantic, "_model"):
            _expand_keywords_semantic._model = load_sentence_transformer("all-MiniLM-L6-v2")
        model = _expand_keywords_semantic._model

        # Cache entity names + embeddings (refresh every 5 min)
        cache = _SEMANTIC_CACHE.get(db_path)
        if not cache or _t.time() - cache["ts"] > 300:
            store = TripleStore(db_path)
            entity_names = [n for eid, n in store.entities_with_attr("name")
                            if eid.startswith("entity:") and len(n) >= 4]
            store.close()
            if not entity_names:
                return keywords
            entity_embs = model.encode(entity_names, show_progress_bar=False)
            _SEMANTIC_CACHE[db_path] = {"names": entity_names, "embs": entity_embs, "ts": _t.time()}
            cache = _SEMANTIC_CACHE[db_path]

        entity_names = cache["names"]
        entity_embs = cache["embs"]

        kw_embs = model.encode(keywords, show_progress_bar=False)

        expanded = list(keywords)
        for i, kw in enumerate(keywords):
            # Skip expansion for very short keywords — embeddings are unreliable
            # for abbreviations like "ml", "ai" (use community detection instead)
            if len(kw) < 4:
                continue
            sims = []
            for j, name in enumerate(entity_names):
                if name == kw or name in expanded:
                    continue
                sim = float(np.dot(kw_embs[i], entity_embs[j]) /
                            (np.linalg.norm(kw_embs[i]) * np.linalg.norm(entity_embs[j]) + 1e-9))
                if sim >= threshold:
                    sims.append((name, sim))
            sims.sort(key=lambda x: -x[1])
            expanded.extend(name for name, _ in sims[:max_expansions])

        return expanded
    except (ImportError, Exception):
        return keywords


def _apply_confidence_floor(facts: list[dict], floor: float) -> list[dict]:
    """Drop facts whose decayed confidence is below `floor`.

    Uses decayed_confidence so a 0.8 fact past its half-life gets filtered
    by a moderate floor — fresh facts get more leeway.
    """
    if floor <= 0.0:
        return facts
    from triplestore import decayed_confidence
    kept = []
    for f in facts:
        try:
            conf = float(f.get("confidence", 0.5))
        except (ValueError, TypeError):
            conf = 0.5
        created = str(f.get("first_seen", "")) or str(f.get("created_at", ""))
        eff = decayed_confidence(conf, created) if created else conf
        if eff >= floor:
            kept.append(f)
    return kept


def _cross_encoder_rerank(query: str, facts: list[dict], top_k: int) -> list[dict]:
    """Pairwise query×document rerank with a cross-encoder. Loads lazily.

    Cross-encoders are slow per-pair vs bi-encoders but score (query, doc)
    jointly, so they catch relevance the cosine misses (e.g. "when X happened"
    where bi-encoder treats every mention of X equally). Bounded to top-30
    RRF survivors — pairwise scoring is O(N), keep it cheap.

    Graceful fallback: if `cross-encoder/ms-marco-MiniLM-L-6-v2` isn't
    available (sandboxed installs without the extra weights), return the
    input list unchanged.
    """
    from sentence_transformers import CrossEncoder
    if not hasattr(_cross_encoder_rerank, "_model"):
        _cross_encoder_rerank._model = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")
    model = _cross_encoder_rerank._model
    pool = facts[:30]
    pairs = [(query, f.get("value", "")) for f in pool]
    if not pairs:
        return facts
    scores = model.predict(pairs)
    ranked = sorted(zip(scores, pool), key=lambda x: -x[0])
    return [f for _, f in ranked[:top_k]]


def _format_results(facts: list[dict], format: str) -> list[dict]:
    """Format dispatcher for query_facts_hybrid output.

    Phase D Tier 1: "facts" (default list[dict]) and "triples" (EAV records).
    "structured" and "narrative" formats are deferred (Tier 2 — require
    temporal columns + LLM-summarized briefs that the RDF backend doesn't
    yet expose). Until those land, structured/narrative return "facts" shape.
    """
    if format == "triples":
        out = []
        for f in facts:
            out.append({
                "entity_id": f.get("entity_id", ""),
                "entity": f.get("entity", ""),
                "attribute": "value",
                "value": f.get("value", ""),
                "value_type": "string",
                "confidence": f.get("confidence", ""),
            })
        return out
    return facts  # facts (default), structured/narrative fall through


# Option D — state supersession (latest-value select). When a fact about the
# same subject/property is revised across sessions (e.g. a 5K personal best
# 27:00 → 25:50), `_fact_id` hashes entity:attribute:value so each value is a
# DISTINCT fact. Both are stored and both reach the top-k (recall@10=1.0), and
# the position-sensitive QA model then picks the STALE value. This is a
# presentation problem, not a retrieval-recall one: collapse the evolving-state
# cluster to its LATEST member at read time. Conservative AND-gate guards
# against collapsing genuinely-distinct facts (catastrophic on the n=6 bench).
# Read-time only, non-destructive to the store. See
# .planning/phases/discourse-reconstruction/00-PLAN.md § Option D.
# "Strong" value tokens — a measured/quantitative value that can EVOLVE (a 5K
# time, a price, a count, a date). Deliberately EXCLUDES bare single digits so a
# category marker like the "5" in "5K" — or an age like "son is 5" — never
# counts as an evolving value (those would cause false collapses).
_STRONG_VALUE_PATTERNS = [
    re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b"),  # clock times / durations (25:50)
    re.compile(r"\b\d{4}-\d{2}-\d{2}\b"),          # ISO dates
    re.compile(r"\$\s?\d[\d,]*(?:\.\d+)?"),        # currency ($1,200.00)
    re.compile(r"\b\d+\.\d+\b"),                    # decimals (3.14)
    re.compile(r"\b\d{2,}\b"),                      # multi-digit integers (27, 1200)
    # word-numbers (count evolutions distill as words: "tried three"->"four").
    # Normalized to digits below so "three"!="3" never blocks a real collapse.
    re.compile(r"\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b"),
]
_WORDNUM = {"zero":"0","one":"1","two":"2","three":"3","four":"4","five":"5","six":"6",
            "seven":"7","eight":"8","nine":"9","ten":"10","eleven":"11","twelve":"12"}
# Category markers — alphanumeric tokens that IDENTIFY which quantity is meant
# (5k vs 10k, q3 vs q4, v2 vs v3, gpt4). If two facts carry DIFFERENT category
# markers they describe DIFFERENT quantities → never collapse. This is what
# separates "5K PB 27:12 → 25:50" (same 5k, evolves) from "5K 25:50 vs 10K
# 52:00" (different races) — the case embedding similarity gets WRONG (0.80 >
# the true pair's 0.76).
_CATEGORY_TOKEN_RE = re.compile(r"\b(?:\d+[a-z]+|[a-z]+\d+)\b")


def _strong_value_tokens(text: str) -> frozenset:
    """Evolving-value tokens (times, dates, currency, multi-digit numbers)."""
    toks: set = set()
    low = (text or "").lower()
    for pat in _STRONG_VALUE_PATTERNS:
        for m in pat.findall(low):
            m = m.strip()
            toks.add(_WORDNUM.get(m, m))  # normalize word-numbers to digits
    return frozenset(toks)


def _category_tokens(text: str) -> frozenset:
    """Alphanumeric category markers (5k, q3, v2, gpt4) that name the quantity."""
    return frozenset(_CATEGORY_TOKEN_RE.findall((text or "").lower()))


def _parse_iso_ts(ts) -> "object | None":
    """Parse first_seen / last_reinforced (ISO, possibly a 1-elem list) → datetime."""
    if isinstance(ts, list):
        ts = ts[0] if ts else ""
    if not ts or not isinstance(ts, str):
        return None
    try:
        from datetime import datetime
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _supersede_evolving_facts(
    results: list[dict],
    embs_by_eid: dict | None = None,
    sim_threshold: float = 0.75,
) -> list[dict]:
    """Collapse evolving-state fact clusters to their latest member (Option D).

    Drops the OLDER fact of a pair only when ALL hold:
      (a) evolving value — BOTH ``value``s carry a "strong" value token (clock
          time / date / currency / multi-digit number) and those token sets
          DIFFER. Single digits (the "5" in "5K", "son is 5") are excluded, so
          category markers and small ages never look like evolving values.
      (b) same quantity — the alphanumeric CATEGORY markers (5k, q3, v2…) match
          between the two facts. ``5k``≠``10k`` ⇒ different quantities ⇒ keep
          both. (Embedding similarity gets this WRONG: 5K-vs-10K sims 0.80 >
          the true 5K-evolution pair's 0.76 — only the category guard separates
          them.)
      (c) topical match — value-embedding cosine sim >= sim_threshold. Floors
          out structural twins of DIFFERENT subjects (Alice-30/Bob-45 ≈ 0.48,
          rent/mortgage ≈ 0.68) while admitting the true pair (≈ 0.76).
      (d) clear temporal order — both timestamps parse and differ; the LATER one
          survives. Ties / unparseable → keep both (fail-safe).

    No entity-string gate: the distiller files related facts under different
    ``entity`` values ("5k run" vs "personal best time"), so an exact-match gate
    would miss every real case. Subject discrimination comes from (a)+(b)+(c).

    Raw excerpts (Option A) are never clustered. Reuses the bi-encoder vectors
    in ``embs_by_eid`` when present; otherwise encodes the surviving values once
    via the cached model, or no-ops if no embedding model is available.
    """
    if len(results) < 2:
        return results

    idxs = [
        i for i, f in enumerate(results)
        if f.get("source") != "raw-excerpt" and f.get("entity") != "excerpt"
    ]
    if len(idxs) < 2:
        return results

    try:
        import numpy as np
    except ImportError:
        return results

    embs_by_eid = embs_by_eid or {}
    vecs: dict[int, object] = {}
    need: list[int] = []
    for i in idxs:
        v = embs_by_eid.get(results[i].get("entity_id", ""))
        if v is None:
            need.append(i)
        else:
            vecs[i] = v
    if need:
        model = getattr(query_facts_hybrid, "_embed_model", None)
        if model is None:
            try:
                from sentence_transformers import SentenceTransformer
                model = SentenceTransformer("all-MiniLM-L6-v2")
                query_facts_hybrid._embed_model = model
            except Exception:
                return results  # no embeddings → can't safely cluster → no-op
        enc = model.encode(
            [results[i].get("value", "") for i in need], show_progress_bar=False
        )
        for k, i in enumerate(need):
            vecs[i] = enc[k]

    def _cos(a, b) -> float:
        return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))

    dropped: set[int] = set()
    for a in range(len(idxs)):
        i = idxs[a]
        if i in dropped:
            continue
        for b in range(a + 1, len(idxs)):
            j = idxs[b]
            if j in dropped:
                continue
            fi, fj = results[i], results[j]
            vi, vj = fi.get("value", ""), fj.get("value", "")
            # (a) both carry a strong value, and the values differ
            si = _strong_value_tokens(vi)
            sj = _strong_value_tokens(vj)
            if not si or not sj or si == sj:
                continue
            # (b) same quantity — block ONLY when BOTH facts carry category
            # markers that differ (5k vs 10k ⇒ different distances ⇒ keep both).
            # An ASYMMETRIC pair — one fact has a marker, the other omits it
            # ("27:12 in a charity 5K run" {5k} vs "personal best is 25:50" {}) —
            # is NOT evidence of different quantities: absence of a marker can't
            # disprove same-subject evolution, so defer to the topical-sim guard
            # (c). Verified 2026-05-30 on q1 6a1eabeb: the stale 27:12 (2023-05-23,
            # {5k}) vs gold 25:50 (2023-05-30, {}) pair was wrongly kept apart.
            ci, cj = _category_tokens(vi), _category_tokens(vj)
            if ci and cj and ci != cj:
                continue
            # (c) topical match
            if _cos(vecs[i], vecs[j]) < sim_threshold:
                continue
            # (d) clear temporal order — later survives
            pi = _parse_iso_ts(fi.get("last_reinforced") or fi.get("first_seen"))
            pj = _parse_iso_ts(fj.get("last_reinforced") or fj.get("first_seen"))
            if pi is None or pj is None or pi == pj:
                continue
            older = i if pi < pj else j
            dropped.add(older)
            if older == i:
                break  # i is gone — advance the outer cursor

    if not dropped:
        return results
    return [f for k, f in enumerate(results) if k not in dropped]


_RECON_ROLE = {
    "mom", "mother", "dad", "father", "sister", "brother", "wife", "husband", "son",
    "daughter", "grandma", "grandmother", "grandpa", "grandfather", "friend", "boss",
    "colleague", "partner", "girlfriend", "boyfriend", "aunt", "uncle", "cousin",
    "neighbor", "neighbour", "manager", "roommate", "coworker", "sibling", "parent",
    "spouse", "fiance", "fiancee", "landlord", "doctor", "therapist", "dog", "cat", "pet",
}
_RECON_ENT_STOP = {
    "the", "user", "users", "this", "that", "their", "they", "there", "then", "what",
    "when", "where", "who", "why", "how", "and", "but", "for", "with", "from", "also",
    "new", "most", "now", "yes", "i", "my", "me", "it",
}
_RECON_CURRENT_MARKERS = (
    "currently", "now ", "recently", "most recently", "current ", "latest",
    "no longer", "these days", "has switched", "switched to", "moved to", "moved back",
)


def _recon_entity_tokens(text: str) -> set[str]:
    """Salient SUBJECT tokens of a fact: proper nouns (Capitalized) + kin/role words,
    minus generics. 'The user's mom ...' -> {mom}; 'Rachel ...' -> {rachel}. Excludes
    the generic 'user' so a recon fact about one person can't retract the user's own
    (or another person's) facts."""
    toks = {m.lower() for m in re.findall(r"\b[A-Z][a-z]{2,}\b", text or "")}
    toks -= _RECON_ENT_STOP
    low = (text or "").lower()
    for r in _RECON_ROLE:
        if re.search(r"\b" + re.escape(r) + r"\b", low):
            toks.add(r)
    return toks


def _recon_supersede_contradictions(
    results: list[dict],
    embs_by_eid: dict | None = None,
    topic_lo: float = 0.70,
    agree_hi: float = 0.88,
) -> list[dict]:
    """#3b: drop a STALE distilled fact when a kind=recon CURRENT-STATE fact asserts a
    DIFFERENT value for the same entity+attribute. The existing evolving-value supersede
    (_supersede_evolving_facts) fires only on STRONG value tokens (numbers/dates), so it
    misses CATEGORICAL changes (Rachel Chicago->suburbs, mom paper->app) — which then leave
    the stale distilled fact in the prompt, out-ranking the correct recon fact, and the QA
    model answers with the stale value (root cause of 830ce83f / d7c942c3 regressions).

    We anchor on the recon current-state fact R and drop a distilled fact D when:
      (1) D shares a SPECIFIC entity with R (proper noun / kin role; generic 'user' excluded);
      (2) value-embedding cosine(R,D) is in the MIDDLE band [topic_lo, agree_hi):
            >= agree_hi -> D restates the SAME value (agrees) -> keep;
            <  topic_lo -> unrelated attribute -> keep;
            middle      -> same attribute, DIFFERENT value -> stale -> drop.
    Bounds are empirically set (Chicago 0.851 / paper 0.739 land in-band; the agreeing
    suburbs restatement 0.919 and the user's own app facts stay out). Read-side, reversible,
    deterministic. Toggle SINAIN_RECON_RETRACT=0."""
    embs_by_eid = embs_by_eid or {}
    recon = [
        i for i, f in enumerate(results)
        if str(f.get("kind", "")) == "recon"
        and any(m in str(f.get("value", "")).lower() for m in _RECON_CURRENT_MARKERS)
        and embs_by_eid.get(f.get("entity_id", "")) is not None
    ]
    if not recon:
        return results
    try:
        import numpy as np
    except ImportError:
        return results

    def _cos(a, b) -> float:
        return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))

    drop: set[int] = set()
    for ri in recon:
        R = results[ri]
        r_emb = embs_by_eid[R.get("entity_id", "")]
        r_ents = _recon_entity_tokens(R.get("value", "")) - {"user"}
        if not r_ents:
            continue  # no specific entity to anchor on → too risky, skip
        for j, D in enumerate(results):
            if j == ri or j in drop:
                continue
            if str(D.get("kind", "")) == "recon":
                continue
            if D.get("source") == "raw-excerpt" or D.get("entity") == "excerpt":
                continue
            d_emb = embs_by_eid.get(D.get("entity_id", ""))
            if d_emb is None:
                continue
            if not (r_ents & _recon_entity_tokens(D.get("value", ""))):
                continue  # different subject → never retract
            if _strong_value_tokens(D.get("value", "")):
                continue  # carries a date/time/number → temporal/numeric ANCHOR, not a
                          # categorical value; leave it (numeric supersede handles those
                          # with proper temporal-order guards). Protects dated event facts.
            if topic_lo <= _cos(r_emb, d_emb) < agree_hi:
                drop.add(j)
    if not drop:
        return results
    return [f for k, f in enumerate(results) if k not in drop]


def _recon_topical_guard(results, query_text=None):
    """Topical-fallback guard for kind=recon consolidated current-state facts.

    Consolidated (kind=recon) facts summarize an entity's *current state*
    (residence, job, status). They help ONLY questions about that
    entity/attribute; for unrelated questions they are noise that occupies the
    final max_facts slots and pushes precise distilled facts out of the prompt
    (the 6a1eabeb / 6aeb4375 regression: gold sat behind irrelevant recon facts).

    Rule (deterministic, token-based -- no embeddings, no LLM): a recon fact keeps
    its rank only when topically relevant to the query, i.e. a salient non-generic
    subject token, an attribute token, or a value content token appears in the
    query. Otherwise it is demoted below all other facts so the max_facts cut
    drops it first. Relevant recon facts (subject "rachel" for "where does Rachel
    live") keep rank, preserving the 830ce83f / d7c942c3 fixes. No-op (safe) when
    no fact carries kind=='recon'.
    """
    if not results or not query_text:
        return results
    import re
    generic = {"user", "i", "me", "my", "mine", "we", "us", "our", "you", "your",
               "they", "them", "someone", "person", "people"}
    stop = {"the", "a", "an", "of", "to", "in", "on", "at", "is", "are", "was",
            "were", "and", "or", "for", "with", "currently", "now", "uses", "use",
            "using", "used", "lives", "live", "lived", "living", "has", "have",
            "had", "been", "that", "this", "as", "by", "from", "her", "his",
            "their", "its", "into", "about", "be", "do", "does", "did", "am"}
    q = set(re.findall(r"[a-z0-9]+", (query_text or "").lower()))
    inline, demoted = [], []
    for f in results:
        if f.get("kind") != "recon":
            inline.append(f)
            continue
        subj = str(f.get("subject") or f.get("entity") or "").lower()
        attr = str(f.get("attribute") or f.get("predicate") or "").lower()
        val = str(f.get("value") or f.get("text") or "").lower()
        st = set(re.findall(r"[a-z0-9]+", subj)) - generic
        at = set(re.findall(r"[a-z0-9]+", attr)) - stop
        vt = set(re.findall(r"[a-z0-9]+", val)) - stop - generic
        relevant = bool((st & q) or (at & q) or (vt & q))
        (inline if relevant else demoted).append(f)
    return inline + demoted


def _entropy_weight(scores: list[float], w_lo: float = 0.6, w_hi: float = 1.6) -> float:
    """#4: map a channel's score distribution to a fusion weight via normalized Shannon
    entropy. A PEAKED (low-entropy) distribution = the channel discriminates confidently
    → up-weight toward w_hi; a FLAT (uniform, high-entropy) distribution = the channel is
    ambiguous/noisy → down-weight toward w_lo. The clarity-score idea (Cronen-Townsend
    2002: KL of a focused vs background LM) applied to read-side fusion. Bounds are kept
    near 1.0 so the reweight stays the same magnitude as the RRF rungs the additive graph/
    decay bonuses are calibrated against. Returns 1.0 (neutral) when entropy is undefined
    (<2 positive scores). Deterministic, no learned parameters."""
    vals = [s for s in scores if s and s > 0]
    if len(vals) < 2:
        return 1.0
    total = sum(vals)
    if total <= 0:
        return 1.0
    import math
    ps = [v / total for v in vals]
    h = -sum(p * math.log(p) for p in ps if p > 0)
    h_norm = h / math.log(len(vals))          # [0,1]: 1 = uniform/flat, 0 = peaked
    return w_lo + (w_hi - w_lo) * (1.0 - h_norm)


def _dpp_greedy_map(sim, quality, max_k: int, eps: float = 1e-4) -> list[int]:
    """#5: fast greedy MAP inference for a Determinantal Point Process (Chen et al.
    2018). Returns indices of a high-quality, DIVERSE subset — the set whose
    feature-space volume (det of the DPP kernel submatrix) is greatest. Kernel
    L_ij = quality_i · sim_ij · quality_j, so selection balances relevance (quality)
    against redundancy (pairwise cosine similarity). Greedy stops when the marginal
    log-det gain of every remaining item falls below ``eps`` — i.e. every leftover is
    a near-duplicate of something already chosen. Deterministic (argmax ties → lowest
    index). The rigorous set-level generalization of MMR / Option-D pairwise collapse."""
    import numpy as np
    q = np.asarray(quality, dtype=float)
    S = np.asarray(sim, dtype=float)
    n = len(q)
    if n == 0:
        return []
    L = (q[:, None] * S) * q[None, :]
    d2 = np.diag(L).astype(float).copy()      # marginal gains d_i^2
    ci = np.zeros((min(max_k, n), n))         # incremental Cholesky rows
    selected: list[int] = []
    j = int(np.argmax(d2))
    for _ in range(min(max_k, n)):
        if d2[j] <= eps:
            break
        k = len(selected)
        if k > 0:
            ei = (L[j, :] - ci[:k, :].T @ ci[:k, j]) / np.sqrt(d2[j])
        else:
            ei = L[j, :] / np.sqrt(d2[j])
        ci[k, :] = ei
        d2 = d2 - ei ** 2
        selected.append(j)
        d2[selected] = -np.inf                # never reselect
        j = int(np.argmax(d2))
    return selected


def _dpp_select_counting(results: list[dict], embs_by_eid: dict, max_k: int) -> list[dict]:
    """Diversity-select the final fact budget for a COUNTING query so it holds DISTINCT
    instances rather than near-duplicates of the same one (which inflate/deflate counts).
    Uses the embeddings already stashed by the bi-encoder rerank (no re-encode); quality
    is the incoming relevance RANK (earlier = higher) so the diverse set still favors the
    most relevant instances. Returns survivors in original relevance order. Falls back to
    the input (no-op) when embeddings are unavailable."""
    import numpy as np
    embs, idxs = [], []
    for i, f in enumerate(results):
        e = embs_by_eid.get(f.get("entity_id", ""))
        if e is not None:
            embs.append(np.asarray(e, dtype=float))
            idxs.append(i)
    if len(embs) <= max_k:
        return results                         # nothing to prune
    M = np.vstack(embs)
    unit = M / (np.linalg.norm(M, axis=1, keepdims=True) + 1e-9)
    S = np.clip(unit @ unit.T, 0.0, 1.0)       # cosine Gram (≥0)
    n = len(idxs)
    rank_q = np.exp(2.0 * (1.0 - np.arange(n) / max(1, n - 1)))   # relevance-tilted quality
    chosen = _dpp_greedy_map(S, rank_q, max_k=max_k)
    if not chosen:
        return results
    keep_local = sorted(chosen)                # original relevance order
    keep_global = {idxs[c] for c in keep_local}
    # keep DPP-selected embedded facts (in order) + any non-embedded facts (rare) in place
    return [f for i, f in enumerate(results) if i in keep_global or embs_by_eid.get(f.get("entity_id", "")) is None]


def _dedup_members(results: list[dict], embs_by_eid: dict, dedup_cos: float = 0.78,
                   max_scan: int = 64):
    """Greedy semantic dedup of candidate facts into DISTINCT members: a fact opens a NEW member
    iff its cosine to every kept member is < dedup_cos (embeddings already stashed by the rerank —
    no re-encode). Skips scaffolds/raw excerpts and facts without embeddings. Returns
    [(label, unit_vec)] in relevance order. Shared by _count_scaffold (#7-COUNT) and the
    completeness-gate shadow logger (DESIGN-completeness-gate-answer-lattice)."""
    import numpy as np
    members = []  # (label, unit_vec)
    for f in results[:max_scan]:
        if f.get("kind") == "scaffold" or f.get("source") == "raw-excerpt":
            continue
        e = embs_by_eid.get(f.get("entity_id", ""))
        if e is None:
            continue
        v = np.asarray(e, dtype=float)
        v = v / (np.linalg.norm(v) + 1e-9)
        if any(float(v @ mv) >= dedup_cos for _, mv in members):
            continue  # near-duplicate of an existing member → same item, don't recount
        _val = f.get("value", "")
        _val = _val[0] if isinstance(_val, list) else _val
        members.append((str(_val)[:70], v))
    return members


def _count_scaffold(results: list[dict], embs_by_eid: dict, dedup_cos: float = 0.78,
                    max_scan: int = 64):
    """#7-COUNT: the sufficient statistic for a "how many X" question is the cardinality of the
    DEDUPLICATED member set. The LLM's documented counting failure is duplicate-instance
    confusion (near-duplicate mentions of the same item double-/under-counted); dedup is exactly
    the part code does reliably and the model does not. Returns a scaffold fact dict that
    ENUMERATES the distinct members and states the deduplicated total N — a true statement about
    the retrieved set (deterministic-fill-only: code proves dedup, the QA model still applies the
    semantic predicate of which members match). Returns None (no scaffold) when < 2 distinct
    members or embeddings unavailable — a wrong/empty scaffold is worse than none."""
    members = _dedup_members(results, embs_by_eid, dedup_cos=dedup_cos, max_scan=max_scan)
    if len(members) < 2:
        return None
    _lst = "; ".join(f"{i + 1}. {lbl}" for i, (lbl, _) in enumerate(members))
    return {"entity_id": "scaffold:count", "kind": "scaffold",
            "value": (f"Distinct items found for this question after deduplication ({len(members)} "
                      f"total): {_lst}. Count only those that match the question; the "
                      f"deduplicated total is {len(members)}.")}


def query_facts_hybrid(
    db_path: str,
    query: str,
    max_facts: int = 10,
    *,
    semantic: bool = True,
    precision_mode: str = "balanced",
    temporal_mode: str = "any",
    confidence_floor: float = 0.0,
    hop_depth: int = 2,
    latency_budget_ms: int | None = None,
    format: str = "facts",
    as_of: str | None = None,
    mentioned_by_speaker: list[str] | None = None,
) -> list[dict]:
    """Hybrid retrieval with Reciprocal Rank Fusion (Graphiti pattern).

    Runs FTS5, tag, top-confidence, and entity-graph retrievals independently,
    fuses via RRF, applies confidence_floor, optionally reranks (bi- or
    cross-encoder per precision_mode), and optionally expands via graph
    neighbors.

    Phase D parameter API (Tier 1 implemented 2026-05-28):
        precision_mode:     "balanced" (DEFAULT — the single production+eval
                            profile, 2026-05-28) uses the wide ~200-candidate
                            pool + bi-encoder rerank. "precise" adds a cross-
                            encoder pass over the bi-encoder's top-30; it is
                            NOT the default because bench data (2026-05-28)
                            showed the ms-marco cross-encoder demotes gold
                            facts on the meeting bench (acme 3.33→2.67)
                            and added nothing at LongMemEval scale — revisit
                            if a larger run shows it helps. "fast" shrinks the
                            pool and skips bi-encoder entirely (latency-bound
                            paths that explicitly opt in — no caller does today).
        temporal_mode:      ACCEPTED BUT NOT HONORED (Tier 2 — requires
                            occurred_start/occurred_end/mentioned_at on the
                            RDF backend). Defaults to "any" behavior.
        confidence_floor:   Drop facts whose decayed confidence is below
                            this value before rerank. Default 0.0 = no floor.
        hop_depth:          0 skips graph expansion entirely. 1 does the
                            1-hop fallback. 2 (DEFAULT) does budgeted multi-hop
                            spreading activation (Phase D Tier 2, shipped
                            commit c8550af) — BFS up to hop_depth levels
                            through ref edges, capped by a per-query node
                            budget (30*hop_depth).
        latency_budget_ms:  Soft cap. Rerank + expansion stages check elapsed
                            time and skip later work if exceeded. None = no
                            cap (default).
        format:             "facts" (default), "triples". "structured" /
                            "narrative" ACCEPTED but fall through to "facts"
                            shape (Tier 2).
        as_of:              ISO timestamp for point-in-time queries.
                            ACCEPTED BUT NOT HONORED (Tier 2).
        mentioned_by_speaker:
                            Optional list of speaker labels (e.g.
                            ["SPEAKER_01", "SPEAKER_USER"]) — filter results
                            to facts whose ``mentioned_by`` triples include
                            at least one of these speakers. Default None =
                            no filter (existing behavior). Diarization
                            Lever 4 — see .planning/phases/diarization-
                            levers/00-PLAN.md. Facts in legacy graphs
                            without ``mentioned_by`` triples will be
                            excluded when this filter is set; pre-Lever-4
                            graphs must be re-ingested to use the filter.

    Returns list[dict] always — format-dependent shape variants are Tier 2.
    """
    import re
    import time
    pipeline_start = time.monotonic()

    def budget_exceeded() -> bool:
        if latency_budget_ms is None:
            return False
        return (time.monotonic() - pipeline_start) * 1000.0 > latency_budget_ms

    if precision_mode not in ("fast", "balanced", "precise"):
        precision_mode = "balanced"
    keywords = [w.lower() for w in re.findall(r"[a-zA-Z][a-zA-Z0-9-]+", query) if len(w) > 2]

    # Option D — state supersession (latest-value select). Default ON; the env
    # flag is an ablation kill-switch only (best-retrieval-is-the-goal). It is
    # query-side and must NOT become a `_content_hash` salt — that keeps A/B on
    # identical cached graphs (graph_query.py is outside the pipeline hash).
    import os as _os_d
    supersede_enabled = _os_d.environ.get("SINAIN_SUPERSEDE", "1") != "0"
    try:
        supersede_floor = float(_os_d.environ.get("SINAIN_SUPERSEDE_FLOOR", "0.75"))
    except ValueError:
        supersede_floor = 0.75
    # bi-encoder value vectors, keyed by entity_id — reused by supersession so
    # it adds zero encode cost in the common (balanced) path.
    _embs_by_eid: dict = {}

    # Layer 2 tiny-LLM query rewriter (opt-in via SINAIN_QUERY_REWRITER=1).
    # Augments the keyword list with model-derived key terms + synonyms BEFORE
    # FTS5/tag/semantic-expansion pipelines run. Failure is silent — falls
    # back to the regex-only keywords above. See query_rewriter.py and
    # .planning/phases/diarization-levers/00-PLAN.md § Tiny-LLM Layer 2.
    rewrite_meta: dict | None = None
    try:
        import os as _os
        if _os.environ.get("SINAIN_QUERY_REWRITER", "").lower() in ("1", "true", "yes"):
            from query_rewriter import rewrite_query as _rewrite_query
            rewrite_meta = _rewrite_query(query, fallback=True)
            extra = list(rewrite_meta.get("key_terms", [])) + list(rewrite_meta.get("expanded_synonyms", []))
            seen = set(keywords)
            for term in extra:
                t = term.lower().strip()
                if t and t not in seen and len(t) > 1:
                    keywords.append(t)
                    seen.add(t)
    except Exception:
        rewrite_meta = None

    # Tier-3 dedicated tiny-LLM (SmolLM2:latest) — multi-query probes + HyDE
    # hypothesis. Opt-in via SINAIN_SMOLLM_PROBES=1. Targets the bench-confirmed
    # "buried fact with generic query terms" retrieval failure (acme
    # recall@1 stuck at 16.7%; LongMemEval q3+q4 retrieval-gap = 0%).
    #
    # Probes: 3 statement-form paraphrases → tokenize → merge keywords.
    # Hypothesis: fact-shaped answer template → used as bi-encoder rerank
    # seed instead of raw query (true HyDE pattern).
    smollm_probes: list[str] = []
    smollm_hypothesis: str = ""
    try:
        import os as _os
        if _os.environ.get("SINAIN_SMOLLM_PROBES", "").lower() in ("1", "true", "yes"):
            from query_smollm import generate_probes_and_hypothesis as _smollm_probes
            smollm_probes, smollm_hypothesis = _smollm_probes(query, fallback=True)
            # Merge probe keywords into the FTS5/tag candidate keyword list.
            seen = set(keywords)
            for probe in smollm_probes:
                for w in re.findall(r"[a-zA-Z][a-zA-Z0-9-]+", probe):
                    t = w.lower()
                    if len(t) > 2 and t not in seen:
                        keywords.append(t)
                        seen.add(t)
    except Exception:
        smollm_probes, smollm_hypothesis = [], ""

    # Diarization Lever 4: normalize speaker filter once. Empty filter ⇒ None
    # (no filter). When set, results are restricted to facts whose mentioned_by
    # triples include at least one of these speakers.
    speaker_filter: set[str] | None = None
    if mentioned_by_speaker:
        speaker_filter = {str(s) for s in mentioned_by_speaker if s}
        if not speaker_filter:
            speaker_filter = None

    def _matches_speaker(fact: dict) -> bool:
        if speaker_filter is None:
            return True
        mb = fact.get("mentioned_by")
        if mb is None:
            return False
        if isinstance(mb, str):
            return mb in speaker_filter
        if isinstance(mb, list):
            return any(isinstance(m, str) and m in speaker_filter for m in mb)
        return False

    # Change 0: Semantic entity expansion — "ML" → ["ml", "machine-learning", "ai", ...]
    # Skippable: a one-shot CLI invocation pays the full model load (~4s) for
    # this step alone, which blows sinain-core's subprocess timeout — and core
    # re-ranks candidates with its in-process embeddings anyway.
    expanded_keywords = keywords
    if semantic and len(keywords) >= 1:
        expanded_keywords = _expand_keywords_semantic(keywords, db_path)

    # Entity graph pre-filter with per-entity tracking for intersection (Change A)
    graph_fact_ids: set[str] = set()
    graph_intersection: set[str] = set()
    community_fact_ids: set[str] = set()
    per_entity_facts: dict[str, set[str]] = {}
    for kw in expanded_keywords:
        kw_facts: set[str] = set()
        for f in query_facts_by_entity_graph(db_path, kw, max_facts=50):
            eid = f.get("entity_id", "")
            if eid:
                kw_facts.add(eid)
                graph_fact_ids.add(eid)
        if kw_facts:
            per_entity_facts[kw] = kw_facts

    # Compute intersection: facts linked to ALL original query keywords
    if len(per_entity_facts) >= 2:
        try:
            graph_intersection = set.intersection(*per_entity_facts.values())
        except TypeError:
            pass

    # Community expansion: follow mentions edges to find related entities
    t0 = time.monotonic()
    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)

        matched_entities = set()
        for kw in expanded_keywords:
            node_id = f"entity:{kw}"
            if store.entity(node_id):
                matched_entities.add(kw)

        for ent in matched_entities:
            if time.monotonic() - t0 > 0.5:
                break
            community = expand_entity_community(store, ent, max_related=3)
            for related_name, _count in community:
                for f in query_facts_by_entity_graph(db_path, related_name, max_facts=20):
                    eid = f.get("entity_id", "")
                    if eid and eid not in graph_fact_ids:
                        community_fact_ids.add(eid)

        store.close()
    except Exception:
        pass

    # Run retrieval methods independently. precision_mode tunes the pool:
    #   fast    — narrow pool (2x) so wall-time stays predictable, no rerank
    #   balanced— current default 3x (keeps existing behavior on default path)
    #   precise — wide pool 5x so cross-encoder rerank has more to work with
    # A1.6 production-IR fix: widen the candidate net so a buried-but-relevant
    # fact is actually FETCHED before any ranking. The old balanced/precise
    # nets (3x / 5x = 30/50) cut facts that the BM25-ranked fts + bi/cross-
    # encoder cascade would have surfaced. fast stays narrow (hot agent-tick
    # path is latency-bound); balanced and precise fetch ~max_facts*20 (=200,
    # the production-IR "top-200 candidate pool").
    if precision_mode == "fast":
        candidate_limit = max(max_facts * 2, max_facts + 5)
    else:
        candidate_limit = max_facts * 20

    # Phase D Tier 2: question-typed pool sizing per PLAN.md.
    # Counting / listing / temporal questions need a broader recall pool —
    # the answer aggregates over multiple facts, so cutting at top-30 may
    # leave out facts that belong in the answer. Heuristic prefix check on
    # the question text — light-weight, no LLM. Only WIDENS the pool (never
    # narrows below the precision_mode default) so this can only improve
    # recall for matching question shapes; single-lookup defaults are
    # preserved unchanged.
    q_lc = query.lower()
    # Temporal-DURATION questions ("how many days/weeks/months ago", "how many months
    # have passed since", "how many days passed between") phrase with "how many" but are
    # NOT enumeration counting — they need a precise dated ANCHOR fact, not a diverse set.
    # Route them to temporal FIRST so the counting candidate-boost and #5 DPP (which prune
    # the dated anchor as "redundant", regressing 71017276 / 0bc8ad92) never misfire.
    _is_duration = bool(re.search(
        r"how many (?:days?|weeks?|months?|years?|hours?|minutes?|nights?)\b", q_lc
    )) or any(p in q_lc for p in (
        "how long ago", "how long has", "how long since", "passed between",
        "passed since", "days passed", "weeks passed", "months passed", "years passed",
    ))
    if _is_duration:
        candidate_limit = max(candidate_limit, max_facts * 4)
        question_class = "temporal"
    elif any(p in q_lc for p in (
        "how many", "count of", "number of", "how often",
        "list all", "list every", "all of the", "list the",
    )):
        candidate_limit = max(candidate_limit, max_facts * 8)
        question_class = "counting"
    elif any(p in q_lc for p in (
        "when did", "when was", "what year", "what time",
        "what date", "how long ago", "since when", "the date when",
    )):
        candidate_limit = max(candidate_limit, max_facts * 4)
        question_class = "temporal"
    else:
        question_class = "default"
    # GEOMETRIC preference/recommendation detection (not regex): a "recommend X for me"
    # question fails by abstaining when the user's preference facts aren't retrieved (query
    # vocabulary is distant from how preferences are stored). Detect via proximity to a frozen
    # exemplar manifold, then augment retrieval with the user's preference facts. Gated
    # SINAIN_PREF_AUGMENT (default on); fail-safe off if embeddings unavailable.
    is_preference = False
    if _os_d.environ.get("SINAIN_PREF_AUGMENT", "1") != "0":
        try:
            from intent_exemplars import is_preference_query
            is_preference = is_preference_query(query)
        except Exception:
            is_preference = False
    # #7: geometric temporal-duration detection → prepend a deterministic dated TIMELINE scaffold
    # so QA reads the dates off it (the sufficient statistic) instead of hallucinating the
    # arithmetic. Gated SINAIN_SCAFFOLD (default on); fail-safe off.
    is_duration = False
    if _os_d.environ.get("SINAIN_SCAFFOLD", "1") != "0":
        try:
            from intent_exemplars import is_duration_query
            is_duration = is_duration_query(query)
        except Exception:
            is_duration = False

    # Change C: FTS5 AND mode for multi-keyword queries
    # #4: request BM25 scores so the fusion can entropy-weight the fts channel.
    if len(keywords) > 1:
        fts_and_query = " AND ".join(keywords)
        fts_results = query_facts_fts(db_path, fts_and_query, max_facts=candidate_limit, with_scores=True)
        if len(fts_results) < candidate_limit:
            fts_or = query_facts_fts(db_path, " OR ".join(keywords), max_facts=candidate_limit, with_scores=True)
            fts_results.extend(fts_or)
    else:
        fts_results = query_facts_fts(db_path, query, max_facts=candidate_limit, with_scores=True)

    tag_results = query_facts_by_entities(db_path, expanded_keywords, max_facts=candidate_limit) if expanded_keywords else []
    top_results = query_top_facts(db_path, limit=candidate_limit)

    # Change B: Tag intersection tier (facts tagged with ALL keywords)
    intersection_results: list[dict] = []
    if len(keywords) >= 2:
        try:
            from triplestore import TripleStore
            _istore = TripleStore(db_path)
            inter = _istore.tag_intersection(
                keywords, min_matches=len(keywords), limit=candidate_limit,
            )
            for fid, _matches in inter:
                attrs = _istore.entity(fid)
                if attrs and "value" in attrs:
                    fact = {"entity_id": fid}
                    for attr_name, values in attrs.items():
                        if attr_name != "tag":
                            fact[attr_name] = values[0] if len(values) == 1 else values
                    intersection_results.append(fact)
            _istore.close()
        except Exception:
            pass

    # Build ranked lists by entity_id
    def _ranked_ids(facts: list[dict]) -> list[str]:
        seen = set()
        out = []
        for f in facts:
            eid = f.get("entity_id", "")
            if eid and eid not in seen:
                seen.add(eid)
                out.append(eid)
        return out

    fts_ranked = _ranked_ids(fts_results)
    tag_ranked = _ranked_ids(tag_results)
    top_ranked = _ranked_ids(top_results)
    intersection_ranked = _ranked_ids(intersection_results)

    # Reciprocal Rank Fusion: RRF(d) = Σ w_i · 1/(k + rank_i(d))
    # #4 ENTROPY-WEIGHTED FUSION: flat RRF trusts all channels equally. The fts
    # channel carries a real BM25 relevance distribution; weight it by query-clarity
    # — a PEAKED (low-entropy) BM25 means the keyword query discriminates well, so
    # trust fts MORE; a FLAT (high-entropy) BM25 means the query is ambiguous, so
    # lean on the graph/tag/top channels instead. The other channels lack a genuine
    # query-relevance score (top_facts is a query-agnostic confidence prior; tag/
    # intersection are coarse match-counts), so they stay neutral (w=1.0) rather than
    # have a distribution fabricated for them. Bounded, parameter-light, deterministic.
    # Toggle: SINAIN_ENTROPY_FUSION=0 disables (falls back to flat RRF). See _entropy_weight.
    K = 60
    rrf_scores: dict[str, float] = {}
    _entropy_on = os.environ.get("SINAIN_ENTROPY_FUSION", "1").lower() in ("1", "true", "yes")
    fts_w = _entropy_weight([f.get("_fts_score") or 0.0 for f in fts_results]) if _entropy_on else 1.0
    weighted_tiers = [(fts_ranked, fts_w), (tag_ranked, 1.0), (top_ranked, 1.0)]
    if intersection_ranked:
        weighted_tiers.append((intersection_ranked, 1.0))
    for ranked_list, w in weighted_tiers:
        for rank, eid in enumerate(ranked_list):
            rrf_scores[eid] = rrf_scores.get(eid, 0.0) + w * (1.0 / (K + rank))

    # Change D: Session co-occurrence for multi-entity queries
    if len(keywords) >= 2 and time.monotonic() - t0 < 1.0:
        try:
            from triplestore import TripleStore
            _sstore = TripleStore(db_path)
            kw_a, kw_b = keywords[0], keywords[1]
            ts_values = _sstore.session_co_occurrence(kw_a, kw_b, limit=10)
            if ts_values:
                fact_ids = _sstore.facts_by_first_seen(ts_values, limit=30)
                for eid in fact_ids:
                    if eid not in graph_fact_ids:
                        community_fact_ids.add(eid)
            _sstore.close()
        except Exception:
            pass

    # Graph boost with intersection bonus (Change A continued)
    if graph_fact_ids or community_fact_ids or graph_intersection:
        for eid in rrf_scores:
            if eid in graph_intersection:
                rrf_scores[eid] += 0.10  # intersection: linked to ALL queried entities
            elif eid in graph_fact_ids:
                rrf_scores[eid] += 0.05  # direct graph-linked facts
            elif eid in community_fact_ids:
                rrf_scores[eid] += 0.025  # community-expanded facts

    # Apply confidence decay as secondary signal (fresh facts rank above stale ones)
    from triplestore import decayed_confidence
    for facts_list in [fts_results, tag_results, top_results]:
        for f in facts_list:
            eid = f.get("entity_id", "")
            if eid in rrf_scores:
                conf = 0.5
                created = ""
                try:
                    conf = float(f.get("confidence", 0.5))
                    created = str(f.get("first_seen", ""))
                except (ValueError, TypeError):
                    pass
                if created:
                    effective = decayed_confidence(conf, created)
                    rrf_scores[eid] += effective * 0.01  # small boost, preserves RRF rank

    # Phase D Tier 2 (first slice 2026-05-28): recency boost via
    # `last_reinforced`. Distillation/reinforcement writes a timestamp every
    # time a fact is re-asserted. Facts mentioned recently get a small
    # additive boost so the "what did the user just say" use case stays
    # responsive to the freshest context without dominating long-tail
    # retrieval. 7-day half-life keeps the boost meaningful for current-
    # week conversations and decays to near-zero for monthly-old facts.
    # Bench gate: must NOT regress cloud q1+q2 (currently 2/2 100% recall).
    import math
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    for facts_list in [fts_results, tag_results, top_results]:
        for f in facts_list:
            eid = f.get("entity_id", "")
            if eid not in rrf_scores:
                continue
            ts = (
                f.get("last_reinforced")
                or f.get("first_seen")
                or ""
            )
            if isinstance(ts, list):
                ts = ts[0] if ts else ""
            if not ts or not isinstance(ts, str):
                continue
            try:
                t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                age_days = max(0.0, (now - t).total_seconds() / 86400.0)
                recency = math.exp(-0.693 * age_days / 7.0)
                rrf_scores[eid] += recency * 0.02  # boost ≤ 0.02, comparable to RRF rung
            except (ValueError, TypeError):
                pass

    # Sort by RRF score descending
    # Deterministic ordering: fused score (desc), then entity_id (asc) so equal-score
    # ties at the top-k boundary resolve identically across runs regardless of upstream
    # candidate-assembly / SPARQL order — reproducible retrieval (production correctness).
    sorted_ids = sorted(rrf_scores, key=lambda e: (-rrf_scores[e], e))

    # Build fact lookup from all candidates
    fact_map: dict[str, dict] = {}
    for facts in [fts_results, tag_results, top_results]:
        for f in facts:
            eid = f.get("entity_id", "")
            if eid and eid not in fact_map:
                fact_map[eid] = f

    # Return top RRF candidates. Cheap filters first — pruning noise before
    # rerank avoids paying encoder cost on facts we'd drop anyway.
    # A1.6: feed the full wide candidate net into rerank. The old window
    # (max_facts*2 = 20) cut buried facts before the bi-/cross-encoder ever
    # scored them — the core rank-out failure. Non-fast modes now hand the
    # whole ~200-candidate pool to the bi-encoder, which is the stage that
    # actually does relevance ranking. fast keeps the narrow window to bound
    # hot-path latency. Lever 4 speaker widening folds into the wide pool.
    if precision_mode == "fast":
        pool_width = max_facts * (6 if speaker_filter else 2)
    else:
        pool_width = max_facts * 20
    rrf_candidates = [fact_map[eid] for eid in sorted_ids[:pool_width] if eid in fact_map]
    rrf_candidates = _apply_confidence_floor(rrf_candidates, confidence_floor)
    if speaker_filter is not None:
        rrf_candidates = [f for f in rrf_candidates if _matches_speaker(f)]

    # Graph expansion — IR-correct placement: BEFORE rerank, so hop-neighbors
    # join the candidate pool and must EARN their rank against directly-
    # retrieved facts. (The previous design appended neighbors AFTER rerank,
    # raw and unranked, where they bypassed the bi-/cross-encoder entirely and
    # tanked small-graph recall@1 — see diarization-levers/00-PLAN.md A1.6.)
    # hop_depth=0 skips. hop_depth=1 = 1-hop ref neighbors. hop_depth>=2 =
    # budgeted spreading activation: BFS up to hop_depth levels through ref
    # edges, capped by a per-query node budget that scales with depth. Seeds
    # are the strongest direct hits (top RRF candidates); a neighbor survives
    # only if the rerank below scores it into the final max_facts.
    if hop_depth >= 1 and rrf_candidates and not budget_exceeded():
        seen_ids = {f.get("entity_id", "") for f in rrf_candidates}
        node_budget = 30 * hop_depth  # 30 for d=1, 60 for d=2, 90 for d=3
        visited_count = 0
        neighbors_added: list[dict] = []
        try:
            from triplestore import TripleStore
            store = TripleStore(db_path)
            # Seed off the top direct candidates only — expanding off all ~200
            # pooled facts would blow up the graph walk and the rerank pool.
            for fact in rrf_candidates[:max_facts]:
                if budget_exceeded() or visited_count >= node_budget:
                    break
                eid = fact.get("entity_id", "")
                if not eid:
                    continue
                neighbors = store.neighbors(eid, depth=hop_depth)
                for nid, nattrs in neighbors.items():
                    if nid in seen_ids or visited_count >= node_budget:
                        if visited_count >= node_budget:
                            break
                        continue
                    visited_count += 1
                    seen_ids.add(nid)
                    nfact = {
                        "entity_id": nid,
                        "entity": nid.split(":")[-1].rsplit("-", 1)[0] if ":" in nid else nid,
                    }
                    for attr, values in nattrs.items():
                        if attr != "tag":
                            nfact[attr] = values[0] if len(values) == 1 else values
                    # Confidence_floor on neighbors so a deep walk can't drag
                    # in stale low-confidence facts; speaker filter respected.
                    filtered = _apply_confidence_floor([nfact], confidence_floor)
                    if filtered and _matches_speaker(filtered[0]):
                        neighbors_added.append(filtered[0])
            store.close()
        except Exception:
            pass
        # Neighbors join the candidate pool; the rerank below ranks the
        # combined set and the final max_facts cut decides what survives.
        rrf_candidates.extend(neighbors_added)

    results = rrf_candidates[:max_facts]

    # Bi-encoder rerank — skipped in fast mode (too slow for hot path), when
    # semantic=False (sinain-core subprocess: core re-ranks with its own
    # in-process embeddings, so loading MiniLM here costs ~4s for work that
    # gets redone), and if the latency budget already blew. Falls back
    # silently when sentence-transformers is missing. With semantic=False,
    # _embs_by_eid stays empty, which also keeps the embedding-dependent
    # scaffold/DPP stages below inert.
    if semantic and precision_mode != "fast" and not budget_exceeded():
        try:
            from sentence_transformers import SentenceTransformer
            import numpy as np
            if not hasattr(query_facts_hybrid, "_embed_model"):
                query_facts_hybrid._embed_model = SentenceTransformer("all-MiniLM-L6-v2")
            model = query_facts_hybrid._embed_model
            # HyDE: use SmolLM hypothesis as the bi-encoder seed when available
            # (falls back to raw query). The hypothesis is fact-shaped, so it
            # embeds closer to actual graph facts than the question form.
            seed_text = smollm_hypothesis if smollm_hypothesis else query
            texts = [seed_text] + [f.get("value", "") for f in rrf_candidates]
            embs = model.encode(texts, show_progress_bar=False)
            q_emb = embs[0]
            scored = []
            for i, f in enumerate(rrf_candidates):
                sim = float(np.dot(q_emb, embs[i + 1]) / (np.linalg.norm(q_emb) * np.linalg.norm(embs[i + 1]) + 1e-9))
                scored.append((sim, f))
                # Stash value vectors for Option D supersession (no re-encode).
                eid = f.get("entity_id", "")
                if eid:
                    _embs_by_eid[eid] = embs[i + 1]
            scored.sort(key=lambda x: -x[0])
            # A1.6: when the cross-encoder runs next (precise mode), keep a
            # wider top-30 window so it re-ranks a real candidate set instead
            # of just the bi-encoder's top-10. #5: counting also needs a wide
            # window so the downstream DPP has a real pool to diversify from
            # (else the bi-encoder pre-narrows to max_facts and DPP is a no-op).
            # Otherwise narrow to max_facts.
            keep = (max(max_facts * 3, 30)
                    if (precision_mode == "precise" or question_class == "counting")
                    else max_facts)
            results = [f for _, f in scored[:keep]]
        except ImportError:
            pass  # sentence-transformers not installed — use RRF order

    # precision_mode=precise: cross-encoder rerank on top of bi-encoder.
    # Cost is bounded (pool=30, top_k=max_facts) and we respect the latency
    # budget. Falls back gracefully if the cross-encoder model isn't
    # available locally (no extra weights downloaded).
    if precision_mode == "precise" and not budget_exceeded() and len(results) > 1:
        try:
            results = _cross_encoder_rerank(query, results, top_k=max_facts)
        except Exception as e:
            print(f"[warn] cross-encoder rerank failed (non-fatal): {e}", file=sys.stderr)

    # NOTE: graph expansion now happens BEFORE rerank (above) so neighbors
    # compete for rank instead of being raw-appended here. See the expansion
    # block after the speaker filter.
    # Read-side kind=recon topical-fallback guard: demote query-irrelevant
    # consolidated current-state facts before the max_facts cut so they don't
    # crowd precise distilled facts out (6a1eabeb/6aeb4375), while keeping
    # relevant ones (830ce83f/d7c942c3). See HANDOFF-recon-t1.md.
    results = _recon_topical_guard(results, query)
    # #7-PREF preference hardening: for a recommendation request, surface the user's preference
    # facts AND prepend a constraint-set scaffold with an anti-abstention directive (the failure is
    # answer-side: gold pref retrieved, QA still abstains). Two parts: (a) pull user-referencing
    # preference facts not already retrieved [revives dd0c94c — its _USER_REF was undefined, so the
    # except-swallowed NameError left it DEAD]; (b) prepend the _preference_scaffold head-fact.
    # Per-shape sub-gate SINAIN_SCAFFOLD_PREF (default OFF until A/B-validated) under the
    # SINAIN_SCAFFOLD master; gating the whole block keeps the dd0c94c revival inert on a bench
    # resume. Deterministic; bounded; fail-safe off.
    if (is_preference
            and _os_d.environ.get("SINAIN_SCAFFOLD", "1") != "0"
            and _os_d.environ.get("SINAIN_SCAFFOLD_PREF", "0") != "0"):
        try:
            _have = {f.get("entity_id", "") for f in results}
            _pstore = TripleStore(db_path)
            _pf = []
            for _fid, _ in _pstore.entities_with_attr("value"):
                if not str(_fid).startswith("fact:") or _fid in _have:
                    continue
                _a = _pstore.entity(_fid)
                if not _a or _a.get("valid_to"):
                    continue
                _v = _a.get("value", [""]); _v = _v[0] if isinstance(_v, list) else _v
                if _v and _USER_REF.search(_v) and _PREF_PRED.search(_v):
                    _pf.append({"entity_id": _fid, "value": _v,
                                "kind": (_a.get("kind", [""])[0] if isinstance(_a.get("kind"), list) else _a.get("kind", ""))})
                if len(_pf) >= max_facts:
                    break
            _pstore.close()
            if _pf:
                results = _pf + results  # preference facts lead so QA grounds on them
        except Exception:
            pass
        # (b) constraint-set scaffold over the now-augmented results (incl. the retrieved gold pref)
        try:
            _ps = _preference_scaffold(results)
            if _ps is not None:
                results = [_ps] + results
        except Exception:
            pass
    # #7 TEMPORAL TIMELINE SCAFFOLD: present the dated events (the sufficient statistic for a
    # duration question) as one sorted timeline fact, so QA reads exact dates off it rather than
    # hallucinating them (gpt4_fa19884c computed "11 days" from wrong dates; gold 6). Built from
    # the retrieved facts' occurred_at (every fact carries one). Deterministic.
    if is_duration:
        try:
            _ev = []  # (date10, value)
            for _f in results[:max_facts * 2]:
                _oc = _f.get("occurred_at") or _f.get("first_seen")
                _oc = _oc[0] if isinstance(_oc, list) else _oc
                _v = _f.get("value", "")
                _v = _v[0] if isinstance(_v, list) else _v
                if _oc and isinstance(_oc, str) and len(_oc) >= 10 and _v and _f.get("source") != "raw-excerpt":
                    _ev.append((_oc[:10], str(_v)))
            # dedup by date+value, sort oldest→newest, cap
            _seen = set(); _u = []
            for d, v in sorted(_ev):
                key = (d, v[:40].lower())
                if key not in _seen:
                    _seen.add(key); _u.append((d, v))
            if len(_u) >= 2:
                _tl = "; ".join(f"{d}: {v[:90]}" for d, v in _u[:12])
                _scaf = {"entity_id": "scaffold:timeline", "kind": "scaffold",
                         "value": ("Dated event timeline (oldest to newest) — use these EXACT dates "
                                   "to compute any duration: " + _tl)}
                results = [_scaf] + results
        except Exception:
            pass
    # #7-COUNT scaffold: for COUNTING queries, compute the sufficient statistic (cardinality of the
    # deduplicated member set) in code and prepend it as a head-fact, so QA reads the dedup'd
    # enumeration off it instead of mis-counting near-duplicate mentions (the documented counting
    # failure #5 only partially addresses — DPP diversifies the budget but never STATES N). Reuses
    # the existing counting trigger (same as #5 DPP) so the two stay aligned. Per-shape sub-gate
    # SINAIN_SCAFFOLD_COUNT (default OFF until A/B-validated) under the SINAIN_SCAFFOLD master;
    # deterministic, fail-safe off.
    if (question_class == "counting"
            and _os_d.environ.get("SINAIN_SCAFFOLD", "1") != "0"
            and _os_d.environ.get("SINAIN_SCAFFOLD_COUNT", "0") != "0"
            and _embs_by_eid):
        try:
            _dc = float(_os_d.environ.get("SINAIN_COUNT_DEDUP_COS", "0.78"))
            _cs = _count_scaffold(results, _embs_by_eid, dedup_cos=_dc)
            if _cs is not None:
                results = [_cs] + results
        except Exception:
            pass
    # M1 SHADOW — capture–recapture completeness gate (.planning/DESIGN-completeness-gate-
    # answer-lattice.md). Logs gate inputs + posterior for counting queries; NO behavior change.
    # Channel A = deduped distilled members; channel B = lexical corroboration of those members in
    # raw excerpts — a LOWER-BOUND channel (cannot add unseen members, so P(inc) is an optimistic
    # floor; real channel-B extraction is the L3 session sweep). Gate SINAIN_COMPLETENESS_GATE,
    # default OFF; fail-open.
    if (question_class == "counting"
            and os.environ.get("SINAIN_COMPLETENESS_GATE", "0") != "0"):
        try:
            import json as _json_cg
            import re as _re_cg
            import time as _time_cg
            from pathlib import Path as _Path_cg
            from ig.completeness import posterior_incomplete, gate_action
            _mem = _dedup_members(results, _embs_by_eid) if _embs_by_eid else []
            _raws = [str(f.get("value", ""))[:600] for f in results
                     if f.get("source") == "raw-excerpt"]
            _rtext = " ".join(_raws).lower()
            _STOP_CG = {"that", "this", "with", "from", "have", "their", "about", "what",
                        "when", "your", "user", "they", "will", "been", "would"}
            _corr = 0
            for _lbl, _ in _mem:
                _toks = [t for t in _re_cg.findall(r"[a-z]{4,}", _lbl.lower())
                         if t not in _STOP_CG]
                if _toks and any(t in _rtext for t in _toks):
                    _corr += 1
            _n1 = len(_mem)
            _p_inc = posterior_incomplete([_n1, _corr], _n1) if _n1 and _corr else 1.0
            _act = gate_action([_n1, _corr], _n1)
            _dir = _Path_cg(os.environ.get("SINAIN_SHADOW_DIR",
                                           str(_Path_cg.home() / ".sinain" / "eval")))
            _dir.mkdir(parents=True, exist_ok=True)
            _rec = {"ts": int(_time_cg.time()), "query": query[:200],
                    "n_distilled": _n1, "n_raw_corroborated": _corr,
                    "raw_excerpts": len(_raws), "p_incomplete": round(_p_inc, 4),
                    "action": _act, "channel_b": "lex-corroboration-lower-bound",
                    "members": [l for l, _ in _mem][:24]}
            with open(_dir / "completeness-shadow.jsonl", "a", encoding="utf-8") as _fh:
                _fh.write(_json_cg.dumps(_rec, ensure_ascii=False) + "\n")
        except Exception:
            pass
    # (2026-06-04) Arithmetic reduction scaffold (sum/mean/argmax) was tried here and DROPPED as
    # overfit: AGGREGATION/SUPERLATIVE are operand-SELECTION-bound (which $ facts are bike expenses),
    # the same semantic-predicate + recall problem as counting — code computes the arithmetic fine but
    # selects the wrong operands. The bottleneck is RETRIEVAL RECALL of the gold-supporting facts, not
    # answer computation. See ig/reduction.py (library kept, not wired) + DESIGN-IG7 §Validation.
    # #5 DPP set-selection: for COUNTING queries, spend the final max_facts budget on
    # DISTINCT instances rather than near-duplicates of the same one (the geometric root
    # of count inflation/deflation). Greedy MAP-DPP over the cosine Gram of the already-
    # computed fact embeddings; relevance-tilted quality keeps the most relevant instances.
    # Gated to counting (where duplicate-instance confusion is the failure mode) so it can't
    # disturb other classes. Toggle SINAIN_DPP_COUNTING=0. No-op if embeddings unavailable.
    if (question_class == "counting"
            and os.environ.get("SINAIN_DPP_COUNTING", "1").lower() in ("1", "true", "yes")
            and len(results) > max_facts and _embs_by_eid):
        results = _dpp_select_counting(results, _embs_by_eid, max_facts)
    final = results[:max_facts]

    # Option D — collapse evolving-state clusters to their latest member so the
    # position-sensitive QA model isn't handed a stale + current value of the
    # same property side by side. Runs on the reranked top-k (so the survivor
    # keeps its earned rank) and BEFORE the raw-excerpt append below (excerpts
    # are excluded from clustering anyway).
    if supersede_enabled:
        # T1-SUPERSEDE bi-temporal: drop facts soft-retracted at write time
        # (carry a ``valid_to``) from CURRENT-STATE results — they were superseded
        # by a later/consolidated fact. Historical/as-of queries use entity_as_of
        # and are unaffected. Cheap (≤max_facts small reads); no-op when nothing is
        # superseded (the common case), so it can't regress normal retrieval.
        try:
            _vstore = TripleStore(db_path)
            _kept = []
            for _f in final:
                _eid = _f.get("entity_id", "")
                if _eid and _vstore.entity(_eid).get("valid_to"):
                    continue  # superseded → exclude from current state
                _kept.append(_f)
            _vstore.close()
            final = _kept
        except Exception:
            pass
        final = _supersede_evolving_facts(final, _embs_by_eid, supersede_floor)
        # #3b CATEGORICAL contradiction-retraction: _supersede_evolving_facts only fires
        # on STRONG value tokens (numbers/dates), so categorical current-state changes
        # (Rachel Chicago->suburbs, mom paper->app) leave the stale distilled fact in the
        # prompt to out-rank the recon fact. Drop the stale fact when a recon current-state
        # fact contradicts it (same entity, middle cosine band). Toggle SINAIN_RECON_RETRACT=0.
        # Skip on temporal questions: they need every dated event (incl. historical
        # ones #3b might read as "stale"), so retraction must not run there.
        if _os_d.environ.get("SINAIN_RECON_RETRACT", "1") != "0" and question_class != "temporal":
            final = _recon_supersede_contradictions(final, _embs_by_eid)

    # Option A — raw episodic hybrid: the retrieval API also surfaces the most
    # relevant RAW source excerpts (from the sidecar next to db_path) so QA can
    # recover detail the distiller dropped (tables, dense lists, scatter). They
    # ride the same return contract as facts, so EVERY consumer (QA, MCP tool,
    # agent) gets them — not a bench-only QA hack. Gated by SINAIN_RAW_CHUNKS.
    # See .planning/phases/discourse-reconstruction/00-PLAN.md § Memory architecture.
    try:
        from raw_store import retrieve_chunks
        # Always-on: returns [] when no sidecar exists, so legacy stores are
        # unaffected. Whether raw chunks are STORED at all is the privacy
        # layer's call (separate concern) — not a retrieval-quality toggle.
        import os as _os_rk
        # k=8: chunks are now ~700-char windows (raw_store._window_split), not whole
        # sessions, so the gold span sits among more, smaller candidates — retrieve
        # more of them. The excerpt budget below still caps how many reach the prompt.
        try:
            _rk = int(_os_rk.environ.get("SINAIN_RAW_CHUNK_K", "8"))
        except ValueError:
            _rk = 8
        # COST-INTENT reformulation: spending-aggregate questions ("how much total did I spend on X")
        # are phrased at the AGGREGATE altitude, but the evidence lives at the purchase-EVENT altitude
        # ("I bought my helmet for $120"). A single semantic query misses the scattered purchase
        # moments (recall@10=0 on gpt4_d84a3211 — incl. a $120 the distiller dropped but raw preserved);
        # an ADDITIONAL cost-intent query recovers them (validated 3/3 vs 0/3). Honest: generic spending
        # vocabulary + the question's own content words, NO gold item names. Gated SINAIN_COST_QUERY.
        _chunk_queries = [query]
        if (_os_rk.environ.get("SINAIN_COST_QUERY", "0") != "0"
                and re.search(r"how much\b.*(spen[dt]|cost|money|paid|pay)|total\b.*(spen[dt]|cost|money)", query.lower())):
            # Drop BOTH question framing AND abstract aggregate nouns (expenses/cost/spending/money) —
            # those are the AGGREGATE-altitude words that mismatch the purchase-event evidence; keep the
            # concrete DOMAIN noun (bike/workshop/gift). Then add purchase-event vocabulary. General.
            _frame = {"how", "much", "many", "total", "money", "have", "has", "i", "did", "do", "what",
                      "was", "is", "spent", "spend", "on", "in", "since", "the", "start", "of", "year",
                      "a", "to", "for", "my", "me", "all", "combined", "altogether",
                      "related", "expenses", "expense", "cost", "costs", "spending", "pay", "paid"}
            _content = [w for w in re.findall(r"[a-z]+", query.lower()) if w not in _frame]
            if _content:
                # cost-intent query LEADS: for a spending question its chunks (the actual purchase
                # events) are the relevant evidence, while the literal query's chunks are noise — so
                # they must survive the downstream excerpt cap, which keeps the first few.
                _chunk_queries.insert(0, " ".join(_content) + " cost price paid bought purchased spent dollars expense")
        _seen_ch = set(); _ci = 0
        # REDUCTION SELECTION (generalizes COST_QUERY from spending-sums to all "how many X"
        # reductions): top-k similarity buries the scattered instance tail (an instrument
        # mentioned in a pedal-shopping session ranks ~#84). A query-INDEPENDENT structural
        # scan — user-has spans (SVO dobj ∪ possessive), ranked by the free embedder's cosine
        # to the question's object-class noun — surfaces the complete set as SHORT spans that
        # LEAD past the excerpt cap. Recall-oriented; the QA call does precision. No LLM here.
        # Gated SINAIN_REDUCE_SELECT (default OFF — a CAPABLE-READER feature). Recall-oriented
        # selection of the scattered instance tail similarity retrieval buries: user-sentences
        # carrying a question-predicate verb (clothing "pick up"/"return") OR a question class noun
        # (stative "…my 10-gallon tank…my betta fish"), digit-boosted, short spans that LEAD past
        # the excerpt cap; the READER does precision. 12-domain sweep verdict: net-POSITIVE with a
        # capable reader (gpt-4o: clothing→3, aquarium 16→17, graduations 1→3; no regression on
        # cuisines/jewelry/instruments/devices), but MIXED with a weak reader (gemini regresses
        # cuisines 5→7, jewelry 2→1 — it can't filter the extra candidates the strong reader does).
        # So: enable in production (capable agent); leave OFF for the gemini bench. See
        # project_2026-06-06_cathub_writetime_worktree memory.
        if (_os_rk.environ.get("SINAIN_REDUCE_SELECT", "0") != "0"
                and re.search(r"\bhow many\b|\bnumber of\b", query.lower())):
            try:
                from reduction_select import select_instance_spans
                for _sp in select_instance_spans(db_path, query):
                    if _sp in _seen_ch:
                        continue
                    _seen_ch.add(_sp)
                    final.append({
                        "entity_id": f"excerpt-{_ci}", "entity": "excerpt",
                        "value": _sp, "source": "raw-excerpt",
                    })
                    _ci += 1
            except Exception:
                pass
        for _cq in _chunk_queries:
            for ch in retrieve_chunks(db_path, _cq, k=_rk):
                _key = ch if isinstance(ch, str) else str(ch)
                if _key in _seen_ch:
                    continue
                _seen_ch.add(_key)
                final.append({
                    "entity_id": f"excerpt-{_ci}", "entity": "excerpt",
                    "value": ch, "source": "raw-excerpt",
                })
                _ci += 1
    except Exception:
        pass

    # Temporal binding (PRODUCTION path — runs for every caller, not bench-only):
    # for date-math queries, embed each fact's session date into its value so the
    # LLM can compute differences ("days between A and B"). The date is real
    # metadata (first_seen = session date), the trigger is generic date-intent on
    # the query (not question-specific), and it only fires on temporal phrasing →
    # no noise for normal retrieval. Gated SINAIN_TEMPORAL_DATES (default on).
    import os as _os_t
    if _os_t.environ.get("SINAIN_TEMPORAL_DATES", "1") != "0":
        ql = query.lower()
        is_temporal = bool(re.search(
            # duration / elapsed-time intent — any unit, not just days
            r"how many (days|weeks|months|years)|how long"
            r"|(days?|weeks?|months?|years?) (between|since|until|ago|passed|apart|later|earlier)"
            r"|between .+ and |when did|what date|how much time"
            # ordering / sequence intent — needs dates to sort events even though
            # there's no "how many" phrasing (e.g. "which happened first?").
            r"|order (from|of)|first to last|in (chronological|what) order"
            r"|which .*(first|last|before|after|earliest|latest)"
            r"|happened first|sequence of events"
            # current-state / relocation intent — a knowledge-UPDATE where an older
            # value (e.g. "moved to Chicago") is mentioned more often than the newer
            # one ("moved back to the suburbs"). Dates let the QA prompt's
            # "trust the most recent update" rule pick the latest over the frequent
            # stale state. Supersession can't help — it's numeric-only, not
            # categorical. Verified 2026-05-30 to fire ONLY on 830ce83f in the 18-q
            # set (not on 51a45a95 "where did I redeem" or e47becba "what degree").
            r"|where (do|does|did|is|are|has|have)\b.*(live|living|relocat|move|moved|moving)"
            r"|relocat|moved? (to|back|away)|currently (live|living|located)"
            r"|what.*(current|now|latest|these days)", ql,
        ))
        if is_temporal:
            for f in final:
                if f.get("source") == "raw-excerpt" or f.get("entity") == "excerpt":
                    continue
                d = _fact_date(f)
                val = f.get("value", "")
                if d and isinstance(val, str) and not val.startswith("["):
                    f["value"] = f"[{d}] {val}"

    return _format_results(final, format)


def format_facts_text(facts: list[dict], max_chars: int = 500) -> str:
    """Format facts grouped by entity for better cross-fact reasoning.

    Groups related facts under entity headers so the QA model sees
    connected context (e.g., all Citibank facts together).
    """
    if not facts:
        return ""

    # Group by entity name (strip fact: prefix and hash suffix)
    from collections import OrderedDict
    groups: OrderedDict[str, list[dict]] = OrderedDict()
    for f in facts:
        entity = f.get("entity", "")
        if isinstance(entity, list):
            entity = entity[0] if entity else ""
        if not entity:
            eid = str(f.get("entity_id", ""))
            entity = eid.split(":")[-1].rsplit("-", 1)[0] if ":" in eid else eid
        groups.setdefault(str(entity), []).append(f)

    lines = []
    total = 0
    for entity, group_facts in groups.items():
        for f in group_facts:
            value = f.get("value", "")
            conf = f.get("confidence", "?")
            count = f.get("reinforce_count", "1")

            line = f"- [{entity}] {value} (conf: {conf}, {count}x)"
            if total + len(line) > max_chars:
                return "\n".join(lines)
            lines.append(line)
            total += len(line)

    return "\n".join(lines)


def _fact_date(f: dict) -> str:
    """YYYY-MM-DD from a fact's first_seen/last_reinforced (session date), or ''."""
    ts = f.get("first_seen") or f.get("last_reinforced") or ""
    if isinstance(ts, list):
        ts = ts[0] if ts else ""
    if isinstance(ts, str) and len(ts) >= 10:
        return ts[:10]
    return ""


def format_facts_compact(facts: list[dict], max_chars: int = 1200, with_dates: bool = False) -> str:
    """Encode facts for efficient escalation context injection.

    Compact format: domain/entity: value (conf, Nx)
    Inspired by mempalace AAAK compression — fits 3-5x more facts per token budget.

    with_dates: prepend each fact's session date "- [YYYY-MM-DD] entity: value"
    so the QA model can do date math (temporal-reasoning questions). OFF by
    default — dates are noise for non-temporal QA (the same reason conf/Nx were
    removed), so only the temporal path turns this on. first_seen carries the
    real session date in our ingestion (digest_ts = session ts).

    2026-05-28: Switched from "; "-separated single-line to newline-per-fact
    output. The single-line form caused gemini-2.5-flash to lose the first
    fact under attention pressure from later longer facts — verified on
    LongMemEval-S q1 e47becba: BA fact first + full sports fact last → "I
    don't know"; same facts newline-separated → correct answer. Token cost
    is unchanged (\\n is one character, "; " is two).
    """
    if not facts:
        return ""

    # 2026-05-28 follow-up fix: removed (conf,Nx) metadata + entity/entity
    # prefix from the line format. Isolation test against gemini-2.5-flash
    # showed the metadata-laden form
    #   "- user/user: degree in Business Administration (0.85,1x)"
    # produced "I don't know" while the cleaner form
    #   "- user: degree in Business Administration"
    # produced the correct answer. The compact format had been actively
    # sabotaging QA for every bench: noise tokens (conf, count, doubled
    # entity prefix) made gemini parse the line as opaque structured data
    # rather than as a fact statement.
    # Partition: distilled facts vs Option A raw transcript excerpts. Excerpts
    # were being silently truncated out — facts consumed the whole max_chars
    # budget and excerpts (appended last, ~1200 chars each) never fit. They get
    # a SEPARATE budget so the raw transcript (which often holds the gold the
    # lossy distiller dropped) actually reaches the QA model. Diagnosed
    # 2026-05-30: gold present in a retrieved excerpt but absent from the prompt.
    fact_items = [f for f in facts if f.get("source") != "raw-excerpt" and f.get("entity") != "excerpt"]
    excerpts = [f for f in facts if f.get("source") == "raw-excerpt" or f.get("entity") == "excerpt"]

    # Salience-ordered assembly (production retrieval quality): within the
    # char budget, lead with SPECIFIC/answer-bearing facts and demote GENERIC
    # definitional background ("X is a process", "advanced technologies optimize
    # …") to the tail so it is truncated first, not the answer. Diagnosis
    # (2026-06-02, geometry sweep): qa_reasoning_bound fails had the gold present
    # but BURIED under topically-similar generic noise (6ae235be: Lake-Charles
    # process facts crowded out by generic yield-advice). Stable demotion keeps
    # the retrieval relevance order among non-generic facts; only clearly-generic
    # facts move to the back. Read-side, deterministic, model-agnostic.
    import re as _re_s
    _GENERIC_S = _re_s.compile(
        r"\b(?:is a |are |can be |should be |is the process|is used to|"
        r"is recommended|are known|typically|generally|usually|"
        r"helps? (?:to )?(?:increase|reduce|improve|optimize)|"
        r"can (?:increase|reduce|improve|optimize|enhance|help))\b",
        _re_s.IGNORECASE,
    )
    _USER_S = _re_s.compile(r"\b(?:the user|user's|i |my |we )\b", _re_s.IGNORECASE)

    def _demote(f) -> int:
        v = (f.get("value", "") or "")
        if _USER_S.search(v):
            return 0            # user-centric → lead
        if _GENERIC_S.search(v):
            return 2            # generic definitional/advice → tail
        return 1                # specific non-user fact → middle
    fact_items = sorted(fact_items, key=_demote)  # stable → preserves rank within tier

    lines = []
    total = 0
    for f in fact_items:
        entity = (
            f.get("entity")
            or f.get("entity_id", "").split(":")[-1].rsplit("-", 1)[0]
            or "?"
        )
        if isinstance(entity, list):
            entity = entity[0] if entity else "?"
        entity = str(entity)[:30]
        value = (f.get("value", "") or "").strip()
        if not value:
            continue

        if with_dates:
            d = _fact_date(f)
            line = f"- [{d}] {entity}: {value}" if d else f"- {entity}: {value}"
        else:
            line = f"- {entity}: {value}"
        if total + len(line) + 1 > max_chars:
            break
        lines.append(line)
        total += len(line) + 1

    # Raw transcript excerpts — dedicated budget (default 1800 chars,
    # SINAIN_RAW_CHUNK_CHARS) so they're never crowded out by distilled facts.
    if excerpts:
        import os as _os_e
        try:
            exc_budget = int(_os_e.environ.get("SINAIN_RAW_CHUNK_CHARS", "3000"))
        except ValueError:
            exc_budget = 1800
        et = 0
        for e in excerpts:
            v = (e.get("value", "") or "").strip()
            if not v:
                continue
            seg = f"- (transcript excerpt) {v}"
            if et + len(seg) + 1 > exc_budget:
                seg = seg[: max(0, exc_budget - et - 1)]
                if seg:
                    lines.append(seg)
                break
            lines.append(seg)
            et += len(seg) + 1

    return "\n".join(lines)


def domain_fact_counts(db_path: str) -> dict[str, int]:
    """Count facts per domain for module emergence detection."""
    if not Path(db_path).exists():
        return {}

    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)
        counts = store.domain_fact_counts()
        store.close()
        return counts
    except Exception:
        return {}


def _slug_variants(query: str) -> set[str]:
    """Generate slug variations to handle 'Acme Group' / 'acme' / 'acmegroup'.

    The web search bar accepts free text but the knowledge graph stores
    content-addressed slugs. We normalize aggressively: lowercase, then
    produce hyphenated, underscored, and no-separator variants so a slug
    match works regardless of how the user typed it.
    """
    norm = "-".join(w for w in query.lower().split() if w)
    if not norm:
        return set()
    return {
        norm,
        norm.replace("-", ""),
        norm.replace("-", "_"),
        query.lower().replace(" ", ""),
    }


# English stopwords + a few internet-noise words. Per-token passes (prefix
# wildcards, tag-exact) skip these because they false-positive against the
# whole corpus — "not*" matched 518 rows in our test DB, "real*" matched 88.
# We don't filter them from the main FTS5 query because phrase-style
# multi-word matches benefit from preserving them.
_STOPWORDS = frozenset({
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "did",
    "does", "for", "from", "had", "has", "have", "he", "her", "him", "his",
    "how", "i", "if", "in", "is", "it", "its", "me", "my", "no", "not", "of",
    "on", "or", "our", "she", "so", "than", "that", "the", "their", "them",
    "then", "there", "these", "they", "this", "to", "was", "we", "were",
    "what", "when", "where", "which", "who", "why", "will", "with", "you",
    "your", "yes", "real", "true", "false",
})


def _fts5_safe_tokens(query: str) -> list[str]:
    """Strip FTS5-special chars, return clean lowercase tokens (>=2 chars).

    FTS5 treats ``"()*+-^|`` and AND/OR/NOT/NEAR as operators; raw user input
    can produce confusing results or syntax errors. We defang to a plain
    token list and re-build queries from there.
    """
    import re
    cleaned = re.sub(r"[^\w\s]", " ", query.lower(), flags=re.UNICODE)
    return [t for t in cleaned.split() if len(t) >= 2]


def _significant_tokens(query: str) -> list[str]:
    """Tokens worth running per-token passes on: non-stopword, >=3 chars."""
    return [t for t in _fts5_safe_tokens(query)
            if t not in _STOPWORDS and len(t) >= 3]


def search_entities(db_path: str, query: str, limit: int = 20) -> list[dict]:
    """High-recall entity search for the web UI search bar (Oxigraph-native).

    Rebuilt on the RdfStore API after the SQLite→Oxigraph migration. The prior
    version drove every pass through the retired ``store._conn`` SQLite cursor,
    so on the live Oxigraph store it raised ``'RdfStore' object has no attribute
    '_conn'`` and returned ``[]`` — the silent cause of "no memories in the web
    UI". Signal sources union into a ranked entity list:

      1. Exact slug match (hyphen / underscore / no-sep variants) for
         ``entity:<slug>`` / ``fact:<slug>`` → score 2.0 (top of the list).
      2. BM25 full-text over fact ``value`` text (``RdfStore.fts_search``). Each
         hit contributes 0.2 to its TARGET entity (the fact's ``about`` /
         ``mentions`` ref, else its ``entity:`` slug, else the fact itself) and
         +1 to fact_count. Falls back to an OR over significant tokens when the
         default AND match is dry (partial / multi-word input).
      3. Exact tag match (``lookup('tag', token)``) → +0.4. High precision:
         a tag is an auto-extracted keyword, i.e. "this fact is *about* X".

    Exact-match scores (>=1.0) take the max; sub-1.0 evidence accumulates so
    entities with several independent hit types out-rank one-trick hits.
    Returns: [{entity, type, fact_count, snippet, score, last_seen}].
    """
    if not Path(db_path).exists() or not query.strip():
        return []

    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)

        candidates: dict[str, dict] = {}
        # Cache fact→target-entity resolution — many FTS/tag hits share a fact.
        ent_cache: dict[str, str] = {}

        def target_entity(fact_eid: str) -> str:
            """The entity a fact is ABOUT: typed ref (about/mentions) → entity:
            slug → the fact itself. Replaces the SQLite outbound-ref lookup."""
            if fact_eid in ent_cache:
                return ent_cache[fact_eid]
            if fact_eid.startswith("entity:"):
                ent_cache[fact_eid] = fact_eid
                return fact_eid
            attrs = store.entity(fact_eid)
            tgt: str | None = None
            for a in ("about", "mentions"):
                for v in attrs.get(a, []):
                    if str(v).startswith("entity:"):
                        tgt = str(v)
                        break
                if tgt:
                    break
            if not tgt:
                for slug in attrs.get("entity", []):
                    cand = f"entity:{slug}"
                    if store.entity(cand):
                        tgt = cand
                        break
            ent_cache[fact_eid] = tgt or fact_eid
            return ent_cache[fact_eid]

        def upsert(eid: str, *, score: float = 0.0, snippet: str = "",
                   ts: str | None = None) -> dict:
            entry = candidates.setdefault(eid, {
                "entity": eid,
                "type": eid.split(":", 1)[0] if ":" in eid else "unknown",
                "score": 0.0, "fact_count": 0,
                "snippet": "", "last_seen": None,
            })
            # Exact-match scores (>=1.0) take the max; evidence (<1.0) accumulates.
            if score >= 1.0:
                entry["score"] = max(entry["score"], score)
            else:
                entry["score"] += score
            if snippet and not entry["snippet"]:
                entry["snippet"] = snippet[:140]
            if ts and (entry["last_seen"] is None or ts > entry["last_seen"]):
                entry["last_seen"] = ts
            return entry

        # ── Pass 1: exact slug match for each variant ────────────────────
        for variant in _slug_variants(query):
            for prefix in ("entity:", "fact:"):
                eid = f"{prefix}{variant}"
                if store.entity(eid):
                    upsert(eid, score=2.0)

        # ── Pass 2: BM25 over fact value text ────────────────────────────
        try:
            scored = store.fts_search(query, limit * 4, with_scores=True)
        except Exception:
            scored = []
        if not scored:
            # Partial / multi-word miss under the default AND gate — retry OR'd
            # over significant tokens for recall.
            toks = _significant_tokens(query)
            if toks:
                try:
                    scored = store.fts_search(" or ".join(toks), limit * 4,
                                              with_scores=True)
                except Exception:
                    scored = []
        for feid, _bm in scored:
            attrs = store.entity(feid)
            val = (attrs.get("value") or [""])[0]
            ts = (attrs.get("occurred_at") or attrs.get("first_seen") or [None])[0]
            entry = upsert(target_entity(feid), score=0.2, snippet=val, ts=ts)
            entry["fact_count"] += 1

        # ── Pass 3: exact tag match (high-precision boost) ───────────────
        for token in _significant_tokens(query):
            for feid in store.lookup("tag", token):
                upsert(target_entity(feid), score=0.4)

        # fact_count for slug-only candidates (no FTS/tag hit): entities count
        # their incoming refs; a bare fact counts as 1.
        for eid, entry in candidates.items():
            if entry["fact_count"] == 0:
                if eid.startswith("entity:"):
                    entry["fact_count"] = len(store.backrefs(eid)) or 1
                elif store.entity(eid):
                    entry["fact_count"] = 1

        for c in candidates.values():
            c["score"] = round(c["score"], 3)

        results = sorted(candidates.values(),
                        key=lambda x: (-x["score"], -x["fact_count"]))[:limit]

        # Snippet backfill for slug-only entity hits: pull one backref fact's value.
        for c in results:
            if c["snippet"]:
                continue
            if c["entity"].startswith("entity:"):
                for src_eid, _attr in store.backrefs(c["entity"])[:5]:
                    fv = store.entity(src_eid)
                    val = (fv.get("value") or [""])[0]
                    if val:
                        c["snippet"] = val[:140]
                        if not c["last_seen"]:
                            c["last_seen"] = (fv.get("occurred_at")
                                              or fv.get("first_seen") or [None])[0]
                        break
            else:
                val = (store.entity(c["entity"]).get("value") or [""])[0]
                if val:
                    c["snippet"] = val[:140]

        store.close()
        return results
    except Exception as e:
        sys.stderr.write(f"search_entities error: {e}\n")
        return []


def graph_children(db_path: str, entity: str, limit: int = 200) -> dict:
    """Lazy-load children of an entity for the web UI graph tree.

    Uses VAET index (backreferences via `value_type='ref'`) to find facts
    that reference this entity. Two-level grouping:

      • Top level: by edge attribute (the "kind" of relation — employed_by,
        related_to, etc.). Most data uses just one attribute, so this collapses.
      • When fact:* children dominate a group, sub-group by `domain` (people,
        projects, decisions, ...) — this is the natural Confluence-page
        taxonomy and produces a useful tree even when all edges share a name.

    Plus a "string-typed legacy refs" pass that handles installs storing the
    entity-pointer as value_type='string' (the slug) rather than as a typed ref.

    Returns: { entity, groups: [{ label, edge_attr, children: [...] }] }
    """
    if not Path(db_path).exists():
        return {"entity": entity, "groups": []}

    try:
        from triplestore import TripleStore
        store = TripleStore(db_path)

        # Backrefs: facts whose ref edge points at this entity, grouped by the
        # edge attribute. RdfStore.backrefs() replaces the SQLite VAET scan
        # (value = ? AND value_type='ref').
        children_by_attr: dict[str, set[str]] = {}
        for src_eid, attr in store.backrefs(entity)[:limit]:
            children_by_attr.setdefault(attr or "related", set()).add(src_eid)

        # Legacy string-typed refs: facts with attribute='entity', value=<slug>.
        slug_part = entity.split(":", 1)[1] if ":" in entity else entity
        for src_eid in store.lookup("entity", slug_part)[:limit]:
            children_by_attr.setdefault("entity", set()).add(src_eid)

        # Pre-fetch per-child metadata (fact_count, domain, value snippet,
        # has-its-own-backrefs). fact_count = total triples for the child =
        # sum of per-attribute value counts.
        all_children = {c for cs in children_by_attr.values() for c in cs}
        meta: dict[str, dict] = {}
        for child_eid in all_children:
            attrs = store.entity(child_eid)
            meta[child_eid] = {
                "entity": child_eid,
                "fact_count": sum(len(v) for v in attrs.values()),
                "domain": (attrs.get("domain") or [None])[0],
                "snippet": ((attrs.get("value") or [""])[0] or "")[:80],
                "expandable": bool(store.backrefs(child_eid)),
            }

        out_groups: list[dict] = []
        for attr, child_set in sorted(children_by_attr.items()):
            entries = [meta[c] for c in child_set if c in meta]
            attr_label = attr.replace("_", " ").title()
            fact_share = sum(1 for e in entries if e["entity"].startswith("fact:")) / max(1, len(entries))

            # Only sub-group by domain when (a) the group is big enough that
            # flat would be unwieldy, (b) it's mostly facts, AND (c) we have at
            # least one usable domain signal — otherwise everything ends up in
            # an "Uncategorized" bucket that hides the parent attribute label
            # ("About", "Mentions") which IS useful structure.
            if (len(entries) >= 8 and fact_share >= 0.7
                    and any(e.get("domain") for e in entries)):
                by_domain: dict[str, list[dict]] = {}
                for e in entries:
                    d = (e["domain"] or "other").lower()
                    by_domain.setdefault(d, []).append(e)
                for domain, group_entries in sorted(by_domain.items(),
                                                    key=lambda x: -len(x[1])):
                    out_groups.append({
                        "label": f"{attr_label}: {domain.replace('_', ' ').title()}",
                        "edge_attr": f"{attr}:{domain}",
                        "children": sorted(group_entries, key=lambda x: -x["fact_count"]),
                    })
            else:
                out_groups.append({
                    "label": f"{attr_label} ({len(entries)})",
                    "edge_attr": attr,
                    "children": sorted(entries, key=lambda x: -x["fact_count"]),
                })

        store.close()
        return {"entity": entity, "groups": out_groups}
    except Exception as e:
        sys.stderr.write(f"graph_children error: {e}\n")
        return {"entity": entity, "groups": []}


def main() -> None:
    parser = argparse.ArgumentParser(description="Graph Query")
    parser.add_argument("--db", required=True, help="Path to knowledge-graph.db")
    parser.add_argument("--entities", default=None, help="JSON array of entity/domain names")
    parser.add_argument("--top", type=int, default=None, help="Query top-N facts by confidence")
    parser.add_argument("--domain-counts", action="store_true", help="Show fact counts per domain")
    parser.add_argument("--max-facts", type=int, default=5, help="Maximum facts to return")
    parser.add_argument("--format", choices=["text", "json", "compact"], default="json", help="Output format")
    parser.add_argument("--search-entities", default=None, help="Search query for entity-prioritized lookup")
    parser.add_argument("--search-limit", type=int, default=20, help="Max entity results")
    parser.add_argument("--no-semantic", action="store_true",
                        help="Skip semantic keyword expansion (avoids the in-process model load — use when the caller re-ranks with its own embeddings)")
    parser.add_argument("--graph-children", default=None, help="Entity to expand for graph tree")
    parser.add_argument("--graph-limit", type=int, default=50, help="Max children per parent")
    args = parser.parse_args()

    if args.search_entities is not None:
        results = search_entities(args.db, args.search_entities, limit=args.search_limit)
        score_max = max((r["score"] for r in results), default=0.0)
        print(json.dumps({"results": results, "topic_fallback": score_max < 0.4}, ensure_ascii=False))
        return

    if args.graph_children is not None:
        result = graph_children(args.db, args.graph_children, limit=args.graph_limit)
        print(json.dumps(result, ensure_ascii=False))
        return

    if args.domain_counts:
        counts = domain_fact_counts(args.db)
        print(json.dumps(counts, indent=2))
        return

    if args.top is not None:
        facts = query_top_facts(args.db, limit=args.top)
    elif args.entities:
        entities = json.loads(args.entities)
        # Use hybrid retrieval (FTS5 + tags + entity graph + RRF) for best results
        query_text = " ".join(entities)
        facts = query_facts_hybrid(args.db, query_text, max_facts=args.max_facts,
                                   semantic=not args.no_semantic)
        # Fallback to tag-only if hybrid returns nothing
        if not facts:
            facts = query_facts_by_entities(args.db, entities, max_facts=args.max_facts)
    else:
        facts = query_top_facts(args.db, limit=args.max_facts)

    if args.format == "text":
        print(format_facts_text(facts))
    elif args.format == "compact":
        print(format_facts_compact(facts))
    else:
        print(json.dumps({"facts": facts, "count": len(facts)}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
