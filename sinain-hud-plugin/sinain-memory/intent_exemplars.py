"""intent_exemplars.py — GEOMETRIC question-intent detection (not regex).

A question's intent class is decided by embedding proximity to a FROZEN corpus of exemplar
phrasings per class — robust to paraphrase ("suggest a hotel" ≈ "where should I stay" ≈ "I'm
looking for a place to crash"), unlike a keyword regex. Same frozen-corpus + cosine pattern as
generic_background (#1) and the typed-shape router (#11). Deterministic; local embeddings.

Primary use: detect the PREFERENCE / RECOMMENDATION class so retrieval can augment with the
user's preference manifold (preference questions fail by abstaining when their preference facts
aren't surfaced — query vocabulary is distant from how preferences are stored)."""
from __future__ import annotations

# Frozen exemplars of a user asking for a recommendation grounded in their own taste/context.
PREFERENCE_EXEMPLARS: tuple[str, ...] = (
    "Can you recommend a restaurant for me?",
    "What should I watch tonight?",
    "Suggest a good book I might like.",
    "Any ideas for what to do this weekend?",
    "Can you suggest a hotel for my trip?",
    "Recommend something fun for me to try.",
    "What would be a good gift for my mom?",
    "I'm looking for a new hobby — any suggestions?",
    "Recommend some events happening around me.",
    "What movie would you suggest based on my taste?",
    "Can you suggest accessories that fit my setup?",
    "What publications or conferences might interest me?",
    "Help me pick something I'd enjoy.",
    "Any recommendations for places to visit on my vacation?",
)

# #7: temporal-DURATION exemplars — an INTERVAL between two time points / elapsed-since.
# These need date arithmetic the LLM hallucinates → detect geometrically, build a dated timeline.
# Sharpened to the between/since/ago/elapsed structure to separate from COUNTING (count of units).
DURATION_EXEMPLARS: tuple[str, ...] = (
    "How many days passed between the first event and the second event?",
    "How much time elapsed between when I started and when I finished?",
    "What is the gap in days between the two visits?",
    "How many weeks ago did I meet them?",
    "How long ago did that happen?",
    "How many months have passed since the last time I did it?",
    "How long has it been since I last visited?",
    "How many days were there from the start date to the end date?",
)
# COUNTING contrast manifold — count of instances/units (NOT an interval). is_duration uses the
# RELATIVE comparison (nearer to duration than counting) because the two overlap on absolute score
# ("how many days passed between" vs "how many days did I spend" are close but different intents).
COUNTING_EXEMPLARS: tuple[str, ...] = (
    "How many restaurants have I tried?",
    "How many days did I spend on camping trips?",
    "How many times did I do that?",
    "How many distinct items do I own?",
    "How many books did I read this year?",
    "How many plants did I acquire?",
    "How many trips did I take in total?",
    "How many different places have I visited?",
)

_CACHE = None
_DUR_CACHE = None
_CNT_CACHE = None


def _emb(texts):
    try:
        from embed_client import embed
        return embed(list(texts))
    except Exception:
        return None


def _exemplar_vectors():
    global _CACHE
    if _CACHE is None:
        _CACHE = _emb(PREFERENCE_EXEMPLARS)
    return _CACHE


def _duration_vectors():
    global _DUR_CACHE
    if _DUR_CACHE is None:
        _DUR_CACHE = _emb(DURATION_EXEMPLARS)
    return _DUR_CACHE


def _counting_vectors():
    global _CNT_CACHE
    if _CNT_CACHE is None:
        _CNT_CACHE = _emb(COUNTING_EXEMPLARS)
    return _CNT_CACHE


def _topk_mean(qv, pool, k=3):
    sims = sorted((sum(a * b for a, b in zip(qv, e)) for e in pool), reverse=True)
    top = sims[: max(1, min(k, len(sims)))]
    return sum(top) / len(top)


def is_duration_query(query: str, floor: float = 0.38, margin: float = 0.02, k: int = 3) -> bool:
    """True if `query` is a temporal-DURATION (interval) question. RELATIVE classification: nearer
    to the duration manifold than the counting manifold (by `margin`) AND above `floor`. The
    relative test is what separates "how many days passed BETWEEN" (duration) from "how many days
    did I SPEND" (counting), which absolute-threshold cosine cannot. Fail-safe False."""
    if not query or not query.strip():
        return False
    dur, cnt = _duration_vectors(), _counting_vectors()
    if not dur or not cnt:
        return False
    qv = _emb([query])
    if not qv:
        return False
    qv = qv[0]
    d = _topk_mean(qv, dur, k)
    c = _topk_mean(qv, cnt, k)
    return d >= floor and d - c >= margin


def is_preference_query(query: str, tau: float = 0.55, k: int = 3) -> bool:
    """True if `query` sits near the recommendation-request manifold (mean of top-k cosine to
    the frozen exemplars >= tau). Geometric — catches paraphrases a regex would miss. Fail-safe
    False if embeddings are unavailable (caller falls back to its other class routing)."""
    if not query or not query.strip():
        return False
    ex = _exemplar_vectors()
    if not ex:
        return False
    try:
        from embed_client import embed
        qv = embed([query])
    except Exception:
        return False
    if not qv:
        return False
    qv = qv[0]
    sims = sorted((sum(a * b for a, b in zip(qv, e)) for e in ex), reverse=True)
    top = sims[: max(1, min(k, len(sims)))]
    return (sum(top) / len(top)) >= tau
