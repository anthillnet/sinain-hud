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


def embed(texts: list[str]) -> list[list[float]] | None:
    """Embed texts via sinain-core /embed endpoint. Returns None if unavailable."""
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
        return None


def cosine(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two vectors."""
    dot = sum(x * y for x, y in zip(a, b))
    return dot  # vectors are pre-normalized by the model


def find_duplicate(
    new_text: str,
    existing_texts: list[str],
    threshold: float = SIMILARITY_THRESHOLD,
) -> int | None:
    """Find the index of the most similar existing text, or None if no match.

    Returns the index into existing_texts if similarity >= threshold.
    """
    if not existing_texts:
        return None

    all_texts = [new_text] + existing_texts
    embeddings = embed(all_texts)
    if embeddings is None:
        return None

    new_emb = embeddings[0]
    best_idx = None
    best_sim = threshold

    for i, emb in enumerate(embeddings[1:]):
        sim = cosine(new_emb, emb)
        if sim > best_sim:
            best_sim = sim
            best_idx = i

    return best_idx


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
