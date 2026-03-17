"""Tests for embedder.py — dual-strategy embeddings + vector search."""

import math
import struct
import pytest
from unittest.mock import patch, MagicMock

from triplestore import TripleStore
from embedder import Embedder, _vec_to_blob, _blob_to_vec, _text_hash, _dot, _norm


@pytest.fixture
def db_path(tmp_path):
    return str(tmp_path / "test.db")


@pytest.fixture
def store(db_path):
    s = TripleStore(db_path)
    yield s
    s.close()


@pytest.fixture
def embedder(db_path, store):
    """Embedder with a pre-initialized store."""
    e = Embedder(db_path)
    yield e
    e.close()


# ----- Utility functions -----

class TestVecConversion:
    def test_roundtrip(self):
        vec = [0.1, 0.2, 0.3, -0.5, 1.0]
        blob = _vec_to_blob(vec)
        recovered = _blob_to_vec(blob)
        for a, b in zip(vec, recovered):
            assert abs(a - b) < 1e-6

    def test_empty_vec(self):
        assert _vec_to_blob([]) == b""
        assert _blob_to_vec(b"") == []


class TestTextHash:
    def test_deterministic(self):
        assert _text_hash("hello") == _text_hash("hello")

    def test_different_texts(self):
        assert _text_hash("hello") != _text_hash("world")

    def test_length(self):
        assert len(_text_hash("test")) == 16


class TestDotAndNorm:
    def test_dot_product(self):
        assert _dot([1, 2, 3], [4, 5, 6]) == 32

    def test_norm(self):
        assert abs(_norm([3, 4]) - 5.0) < 1e-6

    def test_unit_vector_norm(self):
        assert abs(_norm([1, 0, 0]) - 1.0) < 1e-6


# ----- Embedder with mocked API -----

def _mock_openrouter_response(texts):
    """Create a mock OpenRouter embedding response."""
    # Generate deterministic fake embeddings (10-dim for testing)
    embeddings = []
    for i, text in enumerate(texts):
        vec = [(hash(text + str(j)) % 1000) / 1000.0 for j in range(10)]
        embeddings.append({"index": i, "embedding": vec})
    return MagicMock(
        status_code=200,
        json=lambda: {"data": embeddings},
        raise_for_status=lambda: None,
    )


class TestEmbedOpenRouter:
    @patch.dict("os.environ", {"OPENROUTER_API_KEY": "test-key"})
    @patch("requests.post")
    def test_embed_calls_api(self, mock_post, embedder):
        mock_post.return_value = _mock_openrouter_response(["hello"])
        result = embedder.embed(["hello"])
        assert len(result) == 1
        assert len(result[0]) == 10
        mock_post.assert_called_once()

    @patch.dict("os.environ", {"OPENROUTER_API_KEY": "test-key"})
    @patch("requests.post")
    def test_embed_multiple(self, mock_post, embedder):
        texts = ["hello", "world", "test"]
        mock_post.return_value = _mock_openrouter_response(texts)
        result = embedder.embed(texts)
        assert len(result) == 3

    def test_embed_empty(self, embedder):
        assert embedder.embed([]) == []


class TestEmbedFallback:
    @patch.dict("os.environ", {}, clear=True)
    def test_no_api_key_tries_local(self, embedder):
        """Without API key, should try local model (which may not be installed)."""
        result = embedder.embed(["test"])
        # Either local model works or returns empty vectors
        assert isinstance(result, list)


# ----- Store embeddings -----

class TestStoreEmbeddings:
    @patch.dict("os.environ", {"OPENROUTER_API_KEY": "test-key"})
    @patch("requests.post")
    def test_store_and_dedup(self, mock_post, embedder):
        mock_post.return_value = _mock_openrouter_response(["pattern text"])
        count1 = embedder.store_embeddings({"pattern:test": "pattern text"})
        assert count1 == 1

        # Same text → should skip
        count2 = embedder.store_embeddings({"pattern:test": "pattern text"})
        assert count2 == 0

    @patch.dict("os.environ", {"OPENROUTER_API_KEY": "test-key"})
    @patch("requests.post")
    def test_store_update_on_text_change(self, mock_post, embedder):
        mock_post.return_value = _mock_openrouter_response(["v1"])
        embedder.store_embeddings({"pattern:test": "v1"})

        mock_post.return_value = _mock_openrouter_response(["v2"])
        count = embedder.store_embeddings({"pattern:test": "v2"})
        assert count == 1  # re-embedded because text changed

    def test_store_empty(self, embedder):
        assert embedder.store_embeddings({}) == 0


# ----- Vector search -----

class TestVectorSearch:
    @patch.dict("os.environ", {"OPENROUTER_API_KEY": "test-key"})
    @patch("requests.post")
    def test_search_returns_sorted(self, mock_post, embedder):
        # Store some embeddings with known vectors
        # We'll bypass embed() and insert directly
        from embedder import _vec_to_blob, _now_iso
        vecs = {
            "pattern:a": [1.0, 0.0, 0.0],
            "pattern:b": [0.0, 1.0, 0.0],
            "pattern:c": [0.7, 0.7, 0.0],  # closest to query [1,0,0] after normalization
        }
        for eid, vec in vecs.items():
            embedder._conn.execute(
                "INSERT INTO embeddings (entity_id, vector, text_hash, model, dimensions, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (eid, _vec_to_blob(vec), "hash", "test", len(vec), _now_iso()),
            )
        embedder._conn.commit()

        results = embedder.vector_search([1.0, 0.0, 0.0], top_k=3)
        assert len(results) == 3
        # pattern:a should be first (exact match, cosine=1.0)
        assert results[0][0] == "pattern:a"
        assert abs(results[0][1] - 1.0) < 1e-6

    def test_search_empty_db(self, embedder):
        results = embedder.vector_search([1.0, 0.0], top_k=5)
        assert results == []

    def test_search_empty_query(self, embedder):
        assert embedder.vector_search([], top_k=5) == []

    @patch.dict("os.environ", {"OPENROUTER_API_KEY": "test-key"})
    def test_search_with_type_filter(self, embedder):
        from embedder import _vec_to_blob, _now_iso
        for eid, vec in [
            ("pattern:x", [1.0, 0.0]),
            ("concept:y", [0.9, 0.1]),
        ]:
            embedder._conn.execute(
                "INSERT INTO embeddings (entity_id, vector, text_hash, model, dimensions, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (eid, _vec_to_blob(vec), "hash", "test", 2, _now_iso()),
            )
        embedder._conn.commit()

        results = embedder.vector_search([1.0, 0.0], top_k=5, entity_types=["pattern"])
        assert len(results) == 1
        assert results[0][0] == "pattern:x"


# ----- Schema -----

class TestEmbeddingsSchema:
    def test_embeddings_table_exists(self, embedder):
        rows = embedder._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'"
        ).fetchall()
        assert len(rows) == 1

    def test_embeddings_columns(self, embedder):
        info = embedder._conn.execute("PRAGMA table_info(embeddings)").fetchall()
        col_names = {row["name"] for row in info}
        assert col_names == {"entity_id", "vector", "text_hash", "model", "dimensions", "created_at"}
