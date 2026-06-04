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

_CACHE = None


def _exemplar_vectors():
    global _CACHE
    if _CACHE is None:
        try:
            from embed_client import embed
            _CACHE = embed(list(PREFERENCE_EXEMPLARS))
        except Exception:
            _CACHE = None
    return _CACHE


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
