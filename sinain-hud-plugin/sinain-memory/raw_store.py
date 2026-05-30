#!/usr/bin/env python3
"""raw_store.py — Option A: raw episodic chunk retrieval (prototype).

The distiller is a lossy fixed-budget compressor — query-needed detail (table
cells, dense lists, scattered facts) is dropped at write time and unrecoverable,
which is why `full-context` beats `sinain-memory`. Option A keeps the RAW source
chunks retrievable alongside distilled facts: at query time we surface the most
relevant raw chunks so QA can read detail the distiller dropped. Content-agnostic
(no table/list special-casing); helps LOCAL mode most (robust to a weak distiller).

Prototype storage: a sidecar `<store>.raw-chunks.jsonl` next to the Oxigraph store,
one record per chunk {id, text, embedding}. Embeddings via all-MiniLM-L6-v2 (the
model already used in graph_query). Retrieval = cosine top-k vs the query.
See .planning/phases/discourse-reconstruction/00-PLAN.md § Memory architecture.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

_embed_model = None

# all-MiniLM-L6-v2 truncates input at 256 tokens (~1000 chars): a whole-session
# chunk is embedded from only its first ~1000 chars, so any gold detail later in
# the session is invisible to cosine retrieval. We window each incoming text into
# spans comfortably under that limit so every part of the transcript is actually
# indexed. Content-agnostic (no turn/table special-casing). Shared by write_chunks
# (bench) and append_chunks (production) → identical chunking in both paths.
_WINDOW_CHARS = 700      # ~180 tokens, safely under the 256-token encoder limit
_WINDOW_OVERLAP = 120    # carry tail context so a fact split across a boundary survives


def _model():
    global _embed_model
    if _embed_model is None:
        from sentence_transformers import SentenceTransformer
        _embed_model = SentenceTransformer("all-MiniLM-L6-v2")
    return _embed_model


def _window_split(text: str) -> list[str]:
    """Split one raw text into embedding-sized windows.

    Greedy paragraph-packer: split on newlines (the join delimiter used by both
    callers), pack paragraphs into windows of <= _WINDOW_CHARS, hard-splitting any
    single paragraph that exceeds the budget. Consecutive windows overlap by
    ~_WINDOW_OVERLAP chars so a fact straddling a boundary still lands intact in
    at least one window. Returns [text] unchanged when it already fits."""
    text = (text or "").strip()
    if not text:
        return []
    if len(text) <= _WINDOW_CHARS:
        return [text]
    # Break into atomic units on newlines; hard-split over-long units.
    units: list[str] = []
    for para in text.split("\n"):
        para = para.strip()
        if not para:
            continue
        while len(para) > _WINDOW_CHARS:
            units.append(para[:_WINDOW_CHARS])
            para = para[_WINDOW_CHARS - _WINDOW_OVERLAP:]
        if para:
            units.append(para)
    # Greedily pack units into windows, carrying a small overlap between windows.
    windows: list[str] = []
    cur = ""
    for u in units:
        if cur and len(cur) + 1 + len(u) > _WINDOW_CHARS:
            windows.append(cur)
            tail = cur[-_WINDOW_OVERLAP:] if len(cur) > _WINDOW_OVERLAP else cur
            cur = (tail + "\n" + u).strip()
        else:
            cur = (cur + "\n" + u).strip() if cur else u
    if cur:
        windows.append(cur)
    return windows


def _sidecar_path(store_path: str) -> Path:
    return Path(str(store_path) + ".raw-chunks.jsonl")


def write_chunks(store_path: str, chunks: list[str]) -> int:
    """Embed and persist raw chunks for a store. Idempotent: skips if the
    sidecar already exists. `chunks` is a list of raw text strings (e.g. one
    per session). Returns the number of chunks written (0 if skipped/empty)."""
    sidecar = _sidecar_path(store_path)
    if sidecar.exists():
        return 0
    chunks = [w for c in chunks if c and c.strip() for w in _window_split(c)]
    if not chunks:
        return 0
    try:
        embs = _model().encode(chunks, show_progress_bar=False)
    except Exception as e:
        print(f"[raw_store] embed failed (non-fatal): {e}", file=sys.stderr)
        return 0
    sidecar.parent.mkdir(parents=True, exist_ok=True)
    with open(sidecar, "w") as f:
        for i, (text, emb) in enumerate(zip(chunks, embs)):
            f.write(json.dumps({"id": i, "text": text, "emb": [float(x) for x in emb]}) + "\n")
    return len(chunks)


def append_chunks(store_path: str, chunks: list[str]) -> int:
    """Append raw chunks to the sidecar (production per-batch path). Unlike
    write_chunks (idempotent bulk), this APPENDS — each distillation batch adds
    its transcript chunk, with ids continuing from the existing count. Returns
    number appended (0 if empty / on embed failure)."""
    chunks = [w for c in chunks if c and c.strip() for w in _window_split(c)]
    if not chunks:
        return 0
    sidecar = _sidecar_path(store_path)
    start = 0
    if sidecar.exists():
        start = sum(1 for ln in sidecar.read_text().splitlines() if ln.strip())
    try:
        embs = _model().encode(chunks, show_progress_bar=False)
    except Exception as e:
        print(f"[raw_store] append embed failed (non-fatal): {e}", file=sys.stderr)
        return 0
    sidecar.parent.mkdir(parents=True, exist_ok=True)
    with open(sidecar, "a") as f:
        for j, (text, emb) in enumerate(zip(chunks, embs)):
            f.write(json.dumps({"id": start + j, "text": text, "emb": [float(x) for x in emb]}) + "\n")
    return len(chunks)


def retrieve_chunks(store_path: str, query: str, k: int = 3, max_chars: int = 1200) -> list[str]:
    """Return the top-k raw chunks most similar to `query` (cosine), each
    truncated to max_chars. Empty list if no sidecar / on error."""
    sidecar = _sidecar_path(store_path)
    if not sidecar.exists() or not query.strip():
        return []
    try:
        import numpy as np
        recs = [json.loads(line) for line in sidecar.read_text().splitlines() if line.strip()]
        if not recs:
            return []
        mat = np.array([r["emb"] for r in recs], dtype=float)
        q = np.array(_model().encode([query], show_progress_bar=False)[0], dtype=float)
        sims = mat @ q / (np.linalg.norm(mat, axis=1) * (np.linalg.norm(q) + 1e-9) + 1e-9)
        order = sims.argsort()[::-1][:k]
        return [recs[i]["text"][:max_chars] for i in order]
    except Exception as e:
        print(f"[raw_store] retrieve failed (non-fatal): {e}", file=sys.stderr)
        return []
