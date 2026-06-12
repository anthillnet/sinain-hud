#!/usr/bin/env python3
"""triplestore.py — compatibility shim.

The SQLite EAV implementation has been retired (Phase B.4.5). All storage now
goes through `rdf_store.RdfStore`, which uses Oxigraph (a pure-Rust SPARQL
engine with on-disk RocksDB persistence).

The classic import surface (``from triplestore import TripleStore,
decayed_confidence``) keeps working — TripleStore is an alias for RdfStore,
and decayed_confidence is re-exported from rdf_store.
"""

from __future__ import annotations

import sys

from rdf_store import (  # noqa: F401 — re-exported for back-compat
    RdfStore as TripleStore,
    decayed_confidence,
    import_from_sqlite,
)


def _self_test() -> None:
    """Smoke test the shim: run a write/read round-trip on an in-memory store."""
    store = TripleStore()
    tx = store.begin_tx("self-test", session_key="test")

    store.assert_triple(tx, "fact:demo", "value", "hello world")
    store.assert_triple(tx, "fact:demo", "confidence", "0.9")
    store.assert_triple(tx, "fact:demo", "tag", "demo")

    ent = store.entity("fact:demo")
    assert ent["value"] == ["hello world"], ent
    assert ent["confidence"] == ["0.9"], ent

    found = store.lookup("value", "hello world")
    assert "fact:demo" in found

    top = store.top_facts_by_confidence(5)
    assert top[0][0] == "fact:demo"

    print("  triplestore shim OK")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        _self_test()
    else:
        print("usage: python3 triplestore.py --self-test")
