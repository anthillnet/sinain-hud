"""Zero-LLM episode retrieval — BM25 over segments + temporal anchoring.

This is the layer that must always work: any hardware, any (or no) model.
Typed-fact retrieval (T2) will layer on top; per DESIGN-MEMORY-V2.md the
episode search is the permanent fallback, so its quality floor matters.

Closed-world contract: when nothing scores above the floor, retrieval says so
explicitly — the caller can surface "not in memory" instead of confabulating.
"""

from __future__ import annotations

import math
import os
import re
import sys
from collections import Counter

from memory_v2.store import Episode, EpisodeStore

# ── Embedding tier (optional, cached, never required) ──────────────────────
# Multilingual by default: the internal bench is a Russian transcript with
# English QA, and episodes stay in the source language (only compacted facts
# are English). Lexical-only remains the guaranteed fallback (SINAIN_V2_EMBED=0
# or model unavailable) — the zero-dependency floor the design requires.
_EMBEDDER: object = None
_EMB_CACHE: dict[tuple[int, str], "object"] = {}


def _get_embedder():
    global _EMBEDDER
    if _EMBEDDER is None:
        if os.environ.get("SINAIN_V2_EMBED", "1") == "0":
            _EMBEDDER = False
        else:
            try:
                from sentence_transformers import SentenceTransformer
                model = os.environ.get(
                    "SINAIN_V2_EMBED_MODEL",
                    "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
                )
                _EMBEDDER = SentenceTransformer(model)
                print(f"[v2-retrieve] embedder loaded: {model}")
            except Exception as e:
                print(f"[v2-retrieve] embedder unavailable ({str(e)[:80]}) — lexical only",
                      file=sys.stderr)
                _EMBEDDER = False
    return _EMBEDDER or None


def _embed_cached(corpus_key: int, ids: list[str], texts: list[str]):
    """Encode texts, caching per (corpus_key, id) — one encode per item per run."""
    emb = _get_embedder()
    if emb is None:
        return None
    missing = [(i, t) for (i, t) in zip(ids, texts) if (corpus_key, i) not in _EMB_CACHE]
    if missing:
        vecs = emb.encode([t for _, t in missing], normalize_embeddings=True,
                          show_progress_bar=False)
        for (i, _), v in zip(missing, vecs):
            _EMB_CACHE[(corpus_key, i)] = v
    return [_EMB_CACHE[(corpus_key, i)] for i in ids]


def _hybrid_rank(query: str, ids: list[str], texts: list[str],
                 corpus_key: int) -> list[tuple[float, int, float, float]]:
    """RRF fusion of BM25 and cosine rankings.

    Returns [(rrf_score, index, bm25, cos)] sorted desc. RRF is scale-free, so
    neither signal needs calibration; when the embedder is off it degrades to
    pure BM25 order.
    """
    corpus = [_tokens(t) for t in texts]
    bm25 = _BM25(corpus)
    q = _tokens(query)
    bm_scores = [bm25.score(q, i) for i in range(len(texts))]

    cos_scores = [0.0] * len(texts)
    vecs = _embed_cached(corpus_key, ids, texts)
    if vecs is not None:
        emb = _get_embedder()
        qv = emb.encode([query], normalize_embeddings=True, show_progress_bar=False)[0]
        cos_scores = [float(qv @ v) for v in vecs]

    # Weighted RRF: lexical precision dominates (exact names/nouns are what
    # single-hop questions live on — equal weighting demoted exact matches
    # below vaguely-similar items and cost 2 single-hop answers in round 2);
    # embeddings contribute recall for paraphrase and cross-lingual queries.
    K = 60
    W_BM, W_COS = 1.0, 0.6
    bm_rank = {i: r for r, i in enumerate(sorted(range(len(texts)), key=lambda i: -bm_scores[i]))}
    cos_rank = {i: r for r, i in enumerate(sorted(range(len(texts)), key=lambda i: -cos_scores[i]))}
    fused = []
    for i in range(len(texts)):
        s = W_BM / (K + bm_rank[i]) + (W_COS / (K + cos_rank[i]) if vecs is not None else 0.0)
        fused.append((s, i, bm_scores[i], cos_scores[i]))
    fused.sort(key=lambda t: -t[0])
    return fused

_TOKEN_RE = re.compile(r"[\w-]{2,}", re.UNICODE)

_STOP = {
    # en
    "the", "is", "in", "on", "for", "and", "or", "of", "to", "an", "it",
    "was", "not", "how", "what", "when", "does", "did", "do", "my", "your",
    "their", "have", "has", "had", "are", "were", "been", "about", "from",
    "with", "that", "this", "which", "who", "where", "why", "can", "could",
    "would", "should", "at", "by", "as", "be", "he", "she", "they", "we",
    # ru (high-frequency function words — the internal bench is Russian)
    "это", "как", "что", "они", "мы", "вы", "он", "она", "оно", "его",
    "еще", "уже", "так", "вот", "там", "тут", "если", "или", "но", "да",
    "нет", "ну", "же", "бы", "то", "на", "не", "по", "из", "за", "от",
}


def _tokens(text: str) -> list[str]:
    return [t for t in (w.lower() for w in _TOKEN_RE.findall(text)) if t not in _STOP]


class _BM25:
    def __init__(self, docs: list[list[str]], k1: float = 1.5, b: float = 0.75):
        self.k1, self.b = k1, b
        self.docs = docs
        self.doc_len = [len(d) for d in docs]
        self.avg_len = (sum(self.doc_len) / len(docs)) if docs else 0.0
        self.tf = [Counter(d) for d in docs]
        df: Counter = Counter()
        for d in docs:
            df.update(set(d))
        n = len(docs)
        self.idf = {t: math.log(1 + (n - c + 0.5) / (c + 0.5)) for t, c in df.items()}

    def score(self, query_tokens: list[str], i: int) -> float:
        s = 0.0
        tf, dl = self.tf[i], self.doc_len[i] or 1
        for t in query_tokens:
            if t not in tf:
                continue
            f = tf[t]
            s += self.idf.get(t, 0.0) * (f * (self.k1 + 1)) / (
                f + self.k1 * (1 - self.b + self.b * dl / (self.avg_len or 1))
            )
        return s


def search_episodes(
    store: EpisodeStore,
    query: str,
    *,
    k: int = 8,
    allowed_layers: set[str] | None = None,
    score_floor: float = 1.0,
) -> list[tuple[float, Episode]]:
    """Rank scoped segment episodes against the query.

    Scope filtering happens BEFORE scoring (§3.9 — restricted content must not
    influence ranking). Returns [] when nothing clears the floor: that empty
    result is the closed-world "no attested content" signal, not an error.
    """
    segments = [e for e in store.scoped(allowed_layers) if e.kind == "segment" and e.text]
    if not segments:
        return []
    texts = [f"{e.text} {' '.join(e.entities)} {e.summary}" for e in segments]
    fused = _hybrid_rank(query, [e.id for e in segments], texts, id(store))
    # Closed-world floor: keep an item only when at least one signal is a real
    # match (lexical hit, or clear semantic similarity).
    out = [(s, segments[i]) for s, i, bm, cos in fused[:k] if bm >= score_floor or cos >= 0.30]
    return out


def search_facts(
    facts: list,
    query: str,
    *,
    k: int = 20,
    allowed_layers: set[str] | None = None,
    include_superseded: bool = False,
    score_floor: float = 0.8,
    cos_floor: float = 0.30,
) -> list[tuple[float, object]]:
    """Rank typed facts (memory_v2.compact.Fact) against the query.

    Scope filter first (§3.9), validity filter by default (bi-temporal:
    superseded facts exist but don't serve unless asked). Same closed-world
    contract as search_episodes: [] means "no attested facts".
    """
    pool = facts
    if allowed_layers is not None:
        pool = [f for f in pool if set(f.layers) & allowed_layers]
    if not include_superseded:
        pool = [f for f in pool if not f.invalid_at]
    if not pool:
        return []
    texts = [f"{f.subject} {f.fact}" for f in pool]
    fused = _hybrid_rank(query, [f.id for f in pool], texts, id(facts) if facts else 0)
    hits = [(s, pool[i]) for s, i, bm, cos in fused[:k] if bm >= score_floor or cos >= cos_floor]

    # Subject-join expansion (multi-hop): pull the other currently-valid facts
    # about the subjects of the top hits — deterministic 1-hop graph expansion,
    # so chained questions ("X's friend's job") see the subject's neighborhood
    # even when only one hop matched the query lexically/semantically.
    have = {f.id for _s, f in hits}

    # Person dossier (deterministic CategoryRAG-lite): every currently-valid
    # fact whose subject is NAMED IN THE QUESTION joins the pool. Open-domain
    # questions ("would Melanie be considered an ally?") need the subject's
    # stances/preferences, which rarely match the question lexically.
    # Round-6 lesson: an unconditional dossier flooded the fact section and
    # starved timeline/episodes (open-domain 7→4). Fire it only when direct
    # retrieval came back weak, and keep it small.
    q_names = _cap_names(query)
    dossier: list[tuple[float, object]] = []
    if len(hits) < k // 2:
        dossier = [
            (0.0, f) for f in pool
            if f.id not in have
            and any(n in _norm_subject(f.subject) for n in q_names)
        ][:8]
        for _s, f in dossier:
            have.add(f.id)

    # Two-pass chain expansion (deterministic multi-hop): entities surfaced by
    # first-pass hits but absent from the question re-query the store, so
    # "Caroline moved from her home country" chains to "Caroline is from
    # Sweden" without a query-time LLM.
    bridge: list[tuple[float, object]] = []
    hop_names = set()
    for _s, f in hits[:5]:
        hop_names.update(_cap_names(f"{f.subject} {f.fact}"))
    hop_names -= q_names
    if hop_names:
        aug = f"{query} {' '.join(sorted(hop_names)[:8])}"
        fused2 = _hybrid_rank(aug, [f.id for f in pool], texts, id(facts) if facts else 0)
        bridge = [(0.0, pool[i]) for s, i, bm, cos in fused2[: k // 2]
                  if pool[i].id not in have and (bm >= score_floor or cos >= 0.30)]

    # Same-subject neighborhood of the top hits (1-hop), capped tighter when
    # direct retrieval is already strong — round-2 dilution lesson.
    top_subjects = {_norm_subject(f.subject) for _s, f in hits[:5]}
    for _s, f in bridge:
        have.add(f.id)
    expansion = [
        (0.0, f) for f in pool
        if f.id not in have and _norm_subject(f.subject) in top_subjects
    ]
    cap = k // 4 if len(hits) >= k // 2 else k // 2
    out = hits + dossier + bridge + expansion[: max(0, cap)]
    return out[: k + k // 2]  # hard total cap — context budget is the scarce resource


def _norm_subject(s: str) -> str:
    return re.sub(r"\s+", " ", s.lower()).strip()


def person_profiles(
    facts: list,
    query: str,
    aliases: dict[str, str],
    *,
    max_persons: int = 2,
    max_lines: int = 14,
    domains: tuple = ("people",),
    allowed_layers: set[str] | None = None,
) -> str:
    """Render identity cards for persons named in the query (scope-filtered)."""
    names = _cap_names(query)
    canonicals: list[str] = []
    for n in names:
        c = aliases.get(n)
        if not c:
            # direct subject match fallback
            for f in facts:
                if f.domain == "people" and _norm_subject(f.subject) == n:
                    c = f.subject
                    break
        if c and c not in canonicals:
            canonicals.append(c)
    if not canonicals:
        return ""
    # Caller picks card breadth: identity-only by default (v3d measured that
    # UNGATED wide cards dilute — single-hop 9→7); judgment-intent queries get
    # the wide card (values/tastes/activities are the inference substrate).
    _CARD_DOMAINS = domains
    blocks: list[str] = []
    for c in canonicals[:max_persons]:
        rows = [
            f for f in facts
            if f.domain in _CARD_DOMAINS and not f.invalid_at
            and _norm_subject(f.subject) == _norm_subject(c)
            and (allowed_layers is None or set(f.layers) & allowed_layers)
        ]
        if not rows:
            continue
        rows.sort(key=lambda f: (f.domain, f.valid_at or ""))
        lines = [f"### {c}"]
        lines += [f"- ({f.domain}) [{f.valid_at}] {f.fact}" for f in rows[:max_lines]]
        blocks.append("\n".join(lines))
    if not blocks:
        return ""
    return "## Person Profiles (identity sheet, alias-resolved)\n" + "\n\n".join(blocks)


_CAP_NAME_RE = re.compile(r"\b([A-ZА-ЯЁ][a-zа-яё]{2,})\b")


def _cap_names(text: str) -> set[str]:
    """Capitalized-word candidates (people/places), minus sentence starts noise."""
    return {m.group(1).lower() for m in _CAP_NAME_RE.finditer(text)} - _STOP - {
        "what", "when", "where", "which", "would", "does", "did", "how", "why",
        "who", "the", "speaker",
    }


def build_context_block(
    store: EpisodeStore,
    query: str,
    *,
    facts: list | None = None,
    aliases: dict[str, str] | None = None,
    k: int = 8,
    fact_k: int = 20,
    max_chars: int = 9000,
    allowed_layers: set[str] | None = None,
) -> str:
    """Assemble the QA/agent-facing context block (Zep pattern, episode tier).

    Each excerpt is anchored with its event date — temporal data as structured
    prefix, not prose (the single biggest RAG failure per the Synthius paper).
    Returns the explicit closed-world marker when nothing relevant exists.
    """
    parts: list[str] = []
    used = 0

    # Session timeline first — the summary-tree layer: every session's date +
    # tier-1 summary. Cheap (1-2 sentences × ≤40 sessions), and it is what
    # makes broad-synthesis and multi-session questions answerable when
    # per-fact retrieval is too narrow (Zep's "user summary" analog).
    timeline = [
        e for e in store.scoped(allowed_layers)
        if e.kind == "session" and e.summary
    ]
    if timeline:
        timeline.sort(key=lambda e: e.t_start or "")
        lines = ["## Session Timeline (dated summaries of every conversation)"]
        for e in timeline:
            lines.append(f"- [{(e.t_start or '')[:10]}] {e.summary}")
        block = "\n".join(lines)
        parts.append(block[: max(1200, max_chars // 3)])
        used += len(parts[-1])

    # Person profile cards: when the question names a person, their full
    # identity sheet (people-domain facts from the dedicated extraction pass,
    # alias-resolved) is included wholesale. Deterministic; this is the
    # curated replacement for the round-6 dossier — the profile is the unit
    # Synthius retrieves, and it is what makes possessive-chain multi-hop
    # ("Caroline's grandma...") a single-lookup question.
    if facts:
        # Identity-only cards. Measured twice at n=200: intent-gated WIDE cards
        # (preferences+events on judgment questions) were FLAT overall (v3c,
        # 2026-07-03) — the remaining open-domain failures need world-knowledge
        # bridging, not more persona lines. Ungated wide cards actively dilute
        # (v3d). Keep lean.
        cards = person_profiles(facts, query, aliases or {},
                                allowed_layers=allowed_layers)
        if cards:
            parts.append(cards[: max_chars // 3])
            used += len(parts[-1])

    # Facts — the compacted index: deduplicated, dated, current-state
    # (superseded rows filtered). Episodes below are raw evidence.
    fact_hits = search_facts(facts or [], query, k=fact_k, allowed_layers=allowed_layers)
    if fact_hits:
        lines = ["## Memory Facts (compacted, deduplicated, dated)"]
        for _s, f in fact_hits:
            date = f" [{f.valid_at}]" if f.valid_at else ""
            lines.append(f"- ({f.domain}){date} {f.subject}: {f.fact}")
        block = "\n".join(lines)
        parts.append(block[:max_chars // 2])
        used += len(parts[-1])

    hits = search_episodes(store, query, k=k, allowed_layers=allowed_layers)
    if hits:
        ep_parts = ["## Memory Episodes (raw dated excerpts)"]
        for score, ep in hits:
            date = (ep.t_start or "")[:16].replace("T", " ")
            summary = f" | summary: {ep.summary}" if ep.summary else ""
            block = f"--- episode {ep.id} [{date}]{summary} ---\n{ep.text}"
            if used + len(block) > max_chars and len(parts) > 1:
                break
            ep_parts.append(block[: max(0, max_chars - used)])
            used += len(ep_parts[-1])
        parts.append("\n\n".join(ep_parts))

    if not parts:
        return "(no relevant facts or episodes in memory)"
    return "\n\n".join(parts)
