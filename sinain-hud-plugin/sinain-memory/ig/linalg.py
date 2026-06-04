"""ig.linalg — shared vector geometry. Canonical homes for the helpers currently duplicated:
`_topk_mean` ×3 (generic_background:109, knowledge_integrator:968, intent_exemplars:92) and inline
cosine/unit-norm ×7 (graph_query:600/716/867/901/1458, raw_store:181, embed_client:75). Pure numpy;
fail-safe on degenerate input. Existing call-sites migrate to these in Phase 1 (post-bench)."""
from __future__ import annotations

import numpy as np

_EPS = 1e-9


def unit(v) -> np.ndarray:
    """Unit-normalize a vector. Zero vector → zeros (no div-by-zero)."""
    a = np.asarray(v, dtype=float)
    n = np.linalg.norm(a)
    return a / (n + _EPS)


def cosine(a, b) -> float:
    """Cosine similarity of two vectors. 0.0 when either is degenerate."""
    a = np.asarray(a, dtype=float)
    b = np.asarray(b, dtype=float)
    d = np.linalg.norm(a) * np.linalg.norm(b)
    if d < _EPS:
        return 0.0
    return float(np.dot(a, b) / (d + _EPS))


def cosine_matrix(M) -> np.ndarray:
    """Row-wise cosine Gram of a (n,d) matrix, clipped to [0,1] (the form #2/#5 use)."""
    M = np.asarray(M, dtype=float)
    if M.ndim != 2 or M.shape[0] == 0:
        return np.zeros((0, 0))
    u = M / (np.linalg.norm(M, axis=1, keepdims=True) + _EPS)
    return np.clip(u @ u.T, 0.0, 1.0)


def topk_mean(q, pool, k: int = 3) -> float:
    """Mean of the top-k cosine similarities between query vector `q` and a pool of vectors. The
    frozen-exemplar-manifold scoring kernel (intent_exemplars/generic_background). 0.0 if pool empty."""
    if pool is None or len(pool) == 0:
        return 0.0
    qv = np.asarray(q, dtype=float)
    sims = sorted((cosine(qv, e) for e in pool), reverse=True)
    top = sims[: max(1, min(k, len(sims)))]
    return sum(top) / len(top)
