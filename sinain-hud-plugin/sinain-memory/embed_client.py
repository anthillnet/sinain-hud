"""Embedding client — calls sinain-core's /embed endpoint for vector operations.

Provides semantic similarity for:
- Write path: dedup before asserting facts (knowledge_integrator.py)
- Read path: semantic retrieval (graph_query.py)

Falls back gracefully if sinain-core is not running or model not loaded.
"""

import base64
import json
import struct
import urllib.request
from functools import lru_cache

SINAIN_CORE_URL = "http://localhost:9500"
EMBED_TIMEOUT_S = 5
SIMILARITY_THRESHOLD = 0.78  # calibrated: catches rephrased facts, rejects different facts


_LOCAL_MODEL = None  # cached SentenceTransformer (loaded once per process)
_LOCAL_MODEL_TRIED = False


def _embed_local(texts: list[str]) -> list[list[float]] | None:
    """Fallback: embed with local all-MiniLM-L6-v2 (the SAME model sinain-core's /embed
    serves, and the one graph_query's bi-encoder uses). Returns NORMALIZED vectors so
    cosine() (dot product) is correct. Loads the model once per process; None if
    sentence-transformers isn't installed. This is what makes the write-path semantic
    dedup actually run during the eval (where sinain-core /embed is not up) — before this,
    find_duplicates_batch silently no-op'd and only exact-string dedup ever fired."""
    global _LOCAL_MODEL, _LOCAL_MODEL_TRIED
    if _LOCAL_MODEL is None:
        if _LOCAL_MODEL_TRIED:
            return None
        _LOCAL_MODEL_TRIED = True
        try:
            from sentence_transformers import SentenceTransformer
            _LOCAL_MODEL = SentenceTransformer("all-MiniLM-L6-v2")
        except Exception:
            return None
    try:
        embs = _LOCAL_MODEL.encode(
            texts, show_progress_bar=False, normalize_embeddings=True
        )
        return [list(map(float, v)) for v in embs]
    except Exception:
        return None


def embed(texts: list[str]) -> list[list[float]] | None:
    """Embed texts via sinain-core /embed endpoint, falling back to a local model when the
    endpoint is unreachable (the eval/bench case). Returns None only if BOTH are unavailable."""
    try:
        data = json.dumps({"texts": texts}).encode()
        req = urllib.request.Request(
            f"{SINAIN_CORE_URL}/embed",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=EMBED_TIMEOUT_S) as resp:
            result = json.loads(resp.read())
            # Decode base64 float32 arrays
            embeddings = []
            for b64 in result["embeddings"]:
                raw = base64.b64decode(b64)
                floats = list(struct.unpack(f"{len(raw)//4}f", raw))
                embeddings.append(floats)
            return embeddings
    except Exception:
        return _embed_local(texts)


def cosine(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two vectors."""
    dot = sum(x * y for x, y in zip(a, b))
    return dot  # vectors are pre-normalized by the model


def find_duplicates_batch(
    new_texts: list[str],
    existing_texts: list[str],
    threshold: float = SIMILARITY_THRESHOLD,
) -> dict[int, int]:
    """Find duplicates for multiple new texts against existing texts in one batch.

    Returns {new_index: existing_index} for texts with similarity >= threshold.
    Single HTTP call for all texts — avoids per-fact round trips.
    """
    if not existing_texts or not new_texts:
        return {}

    all_texts = new_texts + existing_texts
    embeddings = embed(all_texts)
    if embeddings is None:
        return {}

    n_new = len(new_texts)
    result = {}

    for i in range(n_new):
        best_idx = None
        best_sim = threshold
        for j in range(n_new, len(embeddings)):
            sim = cosine(embeddings[i], embeddings[j])
            if sim > best_sim:
                best_sim = sim
                best_idx = j - n_new
        if best_idx is not None:
            result[i] = best_idx

    return result


def find_duplicate(
    new_text: str,
    existing_texts: list[str],
    threshold: float = SIMILARITY_THRESHOLD,
) -> int | None:
    """Find the index of the most similar existing text, or None if no match."""
    result = find_duplicates_batch([new_text], existing_texts, threshold)
    return result.get(0)


def rank_by_similarity(
    query: str,
    texts: list[str],
) -> list[tuple[int, float]] | None:
    """Rank texts by semantic similarity to query. Returns [(index, score), ...] descending.

    Returns None if embedding service unavailable (caller should fall back to keyword).
    """
    if not texts:
        return []

    all_texts = [query] + texts
    embeddings = embed(all_texts)
    if embeddings is None:
        return None

    query_emb = embeddings[0]
    scored = []
    for i, emb in enumerate(embeddings[1:]):
        scored.append((i, cosine(query_emb, emb)))

    scored.sort(key=lambda x: x[1], reverse=True)
    return scored
