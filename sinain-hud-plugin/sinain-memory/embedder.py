#!/usr/bin/env python3
"""Embedder — dual-strategy embedding generation and vector search.

Primary: OpenRouter text-embedding-3-small (1536-dim, multilingual)
Fallback: Local all-MiniLM-L6-v2 (384-dim, English-only)

Extends the triplestore.db with an `embeddings` table for vector storage.
Uses brute-force cosine similarity for search (<1ms for 10K entities).

Usage:
    from embedder import Embedder
    embedder = Embedder("memory/triplestore.db")
    vecs = embedder.embed(["OCR pipeline optimization"])
    embedder.store_embeddings({"pattern:ocr-opt": "pattern: OCR optimization"})
    results = embedder.vector_search(vecs[0], top_k=5)
"""

import hashlib
import json
import os
import sqlite3
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path


# ── Privacy helpers ───────────────────────────────────────────────────────────

def _openrouter_allowed_for(data_type: str) -> bool:
    """Return True if the data type is allowed to be sent to OpenRouter for embedding.

    Reads PRIVACY_<DATA_TYPE>_OPENROUTER env var.
    data_type examples: "AUDIO", "OCR", "METADATA"
    """
    key = f"PRIVACY_{data_type.upper()}_OPENROUTER"
    level = os.environ.get(key, "full")
    return level not in ("none",)


_EMBEDDINGS_SCHEMA = """
CREATE TABLE IF NOT EXISTS embeddings (
    entity_id  TEXT PRIMARY KEY,
    vector     BLOB NOT NULL,
    text_hash  TEXT NOT NULL,
    model      TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
"""


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _vec_to_blob(vec: list[float]) -> bytes:
    """Pack a float vector into a compact binary blob."""
    return struct.pack(f"{len(vec)}f", *vec)


def _blob_to_vec(blob: bytes) -> list[float]:
    """Unpack a binary blob into a float vector."""
    n = len(blob) // 4  # 4 bytes per float32
    return list(struct.unpack(f"{n}f", blob))


class Embedder:
    """Dual-strategy embedder with OpenRouter primary + local MiniLM fallback."""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = str(db_path)
        self._conn = sqlite3.connect(self.db_path, timeout=10)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(_EMBEDDINGS_SCHEMA)
        self._conn.commit()
        self._local_model = None  # lazy-loaded

    def close(self) -> None:
        self._conn.close()

    # ----- Embedding generation -----

    def embed(self, texts: list[str], data_type: str = "METADATA") -> list[list[float]]:
        """Generate embeddings for a list of texts.

        Tries OpenRouter first (if allowed by privacy policy), falls back to local model.
        Returns empty list on total failure.

        Args:
            texts: List of texts to embed.
            data_type: Privacy data type key (e.g. "AUDIO", "OCR", "METADATA").
                       Controls whether OpenRouter is allowed for this data.
        """
        if not texts:
            return []

        # Try OpenRouter first (unless privacy policy blocks it)
        if _openrouter_allowed_for(data_type):
            try:
                return self._embed_openrouter(texts)
            except Exception as e:
                print(f"[embed] OpenRouter failed: {e}, trying local model", file=sys.stderr)
        else:
            print(f"[embed] OpenRouter blocked by privacy policy for {data_type}, using local model", file=sys.stderr)

        # Fallback to local model
        try:
            return self._embed_local(texts)
        except Exception as e:
            print(f"[embed] Local model also failed: {e}", file=sys.stderr)
            return [[] for _ in texts]

    def _embed_openrouter(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings via OpenRouter API."""
        import requests

        api_key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_API_KEY_REFLECTION")
        if not api_key:
            raise RuntimeError("No API key for embeddings")

        resp = requests.post(
            "https://openrouter.ai/api/v1/embeddings",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": "openai/text-embedding-3-small",
                "input": texts,
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()

        # Sort by index to maintain order
        embeddings = sorted(data.get("data", []), key=lambda x: x.get("index", 0))
        return [e["embedding"] for e in embeddings]

    def _embed_local(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings using local sentence-transformers model."""
        if self._local_model is None:
            from sentence_transformers import SentenceTransformer
            self._local_model = SentenceTransformer("all-MiniLM-L6-v2")

        embeddings = self._local_model.encode(texts, convert_to_numpy=True)
        return [vec.tolist() for vec in embeddings]

    # ----- Storage -----

    def store_embeddings(self, entity_texts: dict[str, str]) -> int:
        """Embed and upsert entities into the embeddings table.

        Deduplicates via text_hash — skips re-embedding if text hasn't changed.
        Returns count of newly embedded entities.
        """
        if not entity_texts:
            return 0

        # Check which entities need (re-)embedding
        to_embed: dict[str, str] = {}
        for entity_id, text in entity_texts.items():
            th = _text_hash(text)
            existing = self._conn.execute(
                "SELECT text_hash FROM embeddings WHERE entity_id = ?",
                (entity_id,),
            ).fetchone()
            if existing and existing["text_hash"] == th:
                continue  # text unchanged, skip
            to_embed[entity_id] = text

        if not to_embed:
            return 0

        # Generate embeddings
        texts = list(to_embed.values())
        entity_ids = list(to_embed.keys())
        vectors = self.embed(texts)

        if not vectors or not vectors[0]:
            return 0

        # Upsert into table
        model_name = "unknown"
        dims = len(vectors[0])
        if dims >= 1000:
            model_name = "text-embedding-3-small"
        elif dims > 0:
            model_name = "all-MiniLM-L6-v2"

        now = _now_iso()
        count = 0
        for entity_id, text, vec in zip(entity_ids, texts, vectors):
            if not vec:
                continue
            self._conn.execute(
                "INSERT OR REPLACE INTO embeddings "
                "(entity_id, vector, text_hash, model, dimensions, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (entity_id, _vec_to_blob(vec), _text_hash(text), model_name, len(vec), now),
            )
            count += 1
        self._conn.commit()
        return count

    # ----- Vector search -----

    def vector_search(
        self,
        query_vec: list[float],
        top_k: int = 10,
        entity_types: list[str] | None = None,
    ) -> list[tuple[str, float]]:
        """Brute-force cosine similarity search.

        Returns [(entity_id, score)] sorted by score descending.
        """
        if not query_vec:
            return []

        # Load all embeddings (optionally filtered by type)
        if entity_types:
            placeholders = ",".join("?" * len(entity_types))
            # Filter by entity_id prefix
            conditions = " OR ".join(f"entity_id LIKE ?" for _ in entity_types)
            params = [f"{t}:%" for t in entity_types]
            rows = self._conn.execute(
                f"SELECT entity_id, vector FROM embeddings WHERE {conditions}",
                params,
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT entity_id, vector FROM embeddings"
            ).fetchall()

        if not rows:
            return []

        # Compute cosine similarity
        results: list[tuple[str, float]] = []
        q_norm = _norm(query_vec)
        if q_norm == 0:
            return []

        for row in rows:
            vec = _blob_to_vec(row["vector"])
            if len(vec) != len(query_vec):
                continue  # dimension mismatch (mixed models)
            score = _dot(query_vec, vec) / (q_norm * _norm(vec))
            results.append((row["entity_id"], score))

        results.sort(key=lambda x: x[1], reverse=True)
        return results[:top_k]


def _dot(a: list[float], b: list[float]) -> float:
    """Dot product of two vectors."""
    return sum(x * y for x, y in zip(a, b))


def _norm(v: list[float]) -> float:
    """L2 norm of a vector."""
    return sum(x * x for x in v) ** 0.5
