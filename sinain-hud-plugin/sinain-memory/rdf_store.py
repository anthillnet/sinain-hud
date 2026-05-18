"""Oxigraph-backed RDF store — Phase B.4.5 Stage 1.

API-mirror of triplestore.py so callers (knowledge_integrator, graph_query) can
swap stores with a single import change. Stage 1 scope is the foundation: the
basic assert/query/alias API. Hybrid retrieval (FTS + vector fusion) lands
in Stage 4.

Design:
  - Subjects/predicates are URIs in the `sinain:` namespace
    (https://sinain.app/ns#) so the data is round-trippable to/from Turtle and
    interoperable with any SPARQL 1.1 tool.
  - Object values that look like entity refs (start with `entity:` or `fact:`)
    become URIs; everything else becomes a string Literal.
  - Aliases use `skos:altLabel` directly — no separate table needed; Oxigraph
    queries them via SPARQL.
  - Persistence: optional on-disk path; defaults to in-memory for testing.

Namespaces:
  sinain:  https://sinain.app/ns#   — sinain-specific predicates
  schema:  https://schema.org/      — types and standard relationships
  skos:    http://www.w3.org/2004/02/skos/core#  — labels and aliases
  rdf:     http://www.w3.org/1999/02/22-rdf-syntax-ns#
  xsd:     http://www.w3.org/2001/XMLSchema#

Entity URI scheme:
  entity:foo  →  <https://sinain.app/entity/foo>
  fact:bar    →  <https://sinain.app/fact/bar>
  Otherwise the bare slug is wrapped as <https://sinain.app/misc/<slug>>.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pyoxigraph as ox


NS_SINAIN = "https://sinain.app/ns#"
NS_ENTITY = "https://sinain.app/entity/"
NS_FACT = "https://sinain.app/fact/"
NS_MISC = "https://sinain.app/misc/"
NS_SCHEMA = "https://schema.org/"
NS_SKOS = "http://www.w3.org/2004/02/skos/core#"
NS_RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
NS_XSD = "http://www.w3.org/2001/XMLSchema#"

SPARQL_PREFIXES = f"""
PREFIX sinain: <{NS_SINAIN}>
PREFIX schema: <{NS_SCHEMA}>
PREFIX skos:   <{NS_SKOS}>
PREFIX rdf:    <{NS_RDF}>
PREFIX xsd:    <{NS_XSD}>
PREFIX e:      <{NS_ENTITY}>
PREFIX f:      <{NS_FACT}>
"""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


_SAFE_SLUG = re.compile(r"[^a-zA-Z0-9._-]")


def _slug_safe(raw: str) -> str:
    return _SAFE_SLUG.sub("_", raw)


def entity_id_to_uri(entity_id: str) -> ox.NamedNode:
    """Map sinain entity_id (e.g. 'fact:city-bank-abc') to a NamedNode URI."""
    if ":" in entity_id:
        prefix, rest = entity_id.split(":", 1)
        rest = _slug_safe(rest)
        if prefix == "entity":
            return ox.NamedNode(NS_ENTITY + rest)
        if prefix == "fact":
            return ox.NamedNode(NS_FACT + rest)
    return ox.NamedNode(NS_MISC + _slug_safe(entity_id))


def uri_to_entity_id(uri) -> str:
    s = uri.value if hasattr(uri, "value") else str(uri)
    if s.startswith(NS_ENTITY):
        return "entity:" + s[len(NS_ENTITY):]
    if s.startswith(NS_FACT):
        return "fact:" + s[len(NS_FACT):]
    if s.startswith(NS_MISC):
        return s[len(NS_MISC):]
    return s


def attribute_to_predicate(attribute: str) -> ox.NamedNode:
    """Map sinain attribute name to a predicate URI.

    Standard predicates get canonical URIs; sinain-specific stay in sinain:.
    """
    mapping = {
        "name": NS_SCHEMA + "name",
        "type": NS_RDF + "type",
        "alias": NS_SKOS + "altLabel",
        "alt_label": NS_SKOS + "altLabel",
        "pref_label": NS_SKOS + "prefLabel",
    }
    if attribute in mapping:
        return ox.NamedNode(mapping[attribute])
    return ox.NamedNode(NS_SINAIN + _slug_safe(attribute))


def predicate_to_attribute(predicate) -> str:
    s = predicate.value if hasattr(predicate, "value") else str(predicate)
    rev = {
        NS_SCHEMA + "name": "name",
        NS_RDF + "type": "type",
        NS_SKOS + "altLabel": "alias",
        NS_SKOS + "prefLabel": "pref_label",
    }
    if s in rev:
        return rev[s]
    if s.startswith(NS_SINAIN):
        return s[len(NS_SINAIN):]
    return s


def value_to_term(value: Any, value_type: str = "string"):
    if value_type == "ref" and isinstance(value, str):
        return entity_id_to_uri(value)
    if isinstance(value, bool):
        return ox.Literal(str(value).lower(), datatype=ox.NamedNode(NS_XSD + "boolean"))
    if isinstance(value, int):
        return ox.Literal(str(value), datatype=ox.NamedNode(NS_XSD + "integer"))
    if isinstance(value, float):
        return ox.Literal(str(value), datatype=ox.NamedNode(NS_XSD + "double"))
    return ox.Literal(str(value))


class RdfStore:
    """Oxigraph-backed triple store with a sinain-compatible API surface."""

    def __init__(self, path: str | Path | None = None):
        if path is None:
            self._store = ox.Store()
        else:
            p = Path(path).expanduser()
            p.parent.mkdir(parents=True, exist_ok=True)
            self._store = ox.Store(str(p))

    def begin_tx(self, source: str, session_key: str | None = None, metadata: str | None = None) -> dict:
        return {
            "source": source,
            "session_key": session_key,
            "metadata": metadata,
            "started_at": _now_iso(),
        }

    def assert_triple(
        self,
        tx: dict,
        entity_id: str,
        attribute: str,
        value: Any,
        value_type: str = "string",
    ) -> None:
        s = entity_id_to_uri(entity_id)
        p = attribute_to_predicate(attribute)
        o = value_to_term(value, value_type)
        self._store.add(ox.Quad(s, p, o))

    def retract_triple(self, tx: dict, entity_id: str, attribute: str, value: Any) -> int:
        s = entity_id_to_uri(entity_id)
        p = attribute_to_predicate(attribute)
        o = value_to_term(value)
        n = 0
        for q in list(self._store.quads_for_pattern(s, p, o, None)):
            self._store.remove(q)
            n += 1
        return n

    def entity(self, entity_id: str) -> dict[str, list[Any]]:
        s = entity_id_to_uri(entity_id)
        out: dict[str, list[Any]] = {}
        for quad in self._store.quads_for_pattern(s, None, None, None):
            attr = predicate_to_attribute(quad.predicate)
            obj = quad.object
            if isinstance(obj, ox.NamedNode):
                val = uri_to_entity_id(obj)
            else:
                val = str(obj.value) if hasattr(obj, "value") else str(obj)
            out.setdefault(attr, []).append(val)
        return out

    def entities_with_attr(self, attribute: str) -> list[tuple[str, str]]:
        p = attribute_to_predicate(attribute)
        results: list[tuple[str, str]] = []
        for quad in self._store.quads_for_pattern(None, p, None, None):
            ent = uri_to_entity_id(quad.subject)
            obj = quad.object
            if isinstance(obj, ox.NamedNode):
                val = uri_to_entity_id(obj)
            else:
                val = str(obj.value) if hasattr(obj, "value") else str(obj)
            results.append((ent, val))
        return results

    def add_alias(self, canonical_id: str, alias: str, confidence: float = 1.0, source: str = "extracted") -> None:
        s = entity_id_to_uri(canonical_id)
        p = ox.NamedNode(NS_SKOS + "altLabel")
        o = ox.Literal(alias.lower())
        self._store.add(ox.Quad(s, p, o))

    def resolve_alias(self, alias: str) -> list[tuple[str, float]]:
        sparql = f"""
        {SPARQL_PREFIXES}
        SELECT ?canonical WHERE {{
            ?canonical skos:altLabel ?alias .
            FILTER(LCASE(STR(?alias)) = "{alias.lower()}")
        }}
        """
        out: list[tuple[str, float]] = []
        result = self._store.query(sparql)
        for row in result:
            canonical = row["canonical"]
            out.append((uri_to_entity_id(canonical), 1.0))
        return out

    def aliases_of(self, canonical_id: str) -> list[str]:
        s = entity_id_to_uri(canonical_id)
        p = ox.NamedNode(NS_SKOS + "altLabel")
        return [
            str(q.object.value) for q in self._store.quads_for_pattern(s, p, None, None)
        ]

    def sparql(self, query: str) -> list[dict]:
        """Run an arbitrary SPARQL SELECT and return rows as dicts."""
        full = SPARQL_PREFIXES + query if "PREFIX " not in query else query
        out: list[dict] = []
        result = self._store.query(full)
        for row in result:
            d: dict = {}
            for var in result.variables:
                val = row[var]
                if val is None:
                    d[var.value] = None
                elif isinstance(val, ox.NamedNode):
                    d[var.value] = uri_to_entity_id(val)
                else:
                    d[var.value] = str(val.value) if hasattr(val, "value") else str(val)
            out.append(d)
        return out

    def __len__(self) -> int:
        return sum(1 for _ in self._store)

    def all_triples(self) -> list[tuple[str, str, Any]]:
        out = []
        for q in self._store:
            s = uri_to_entity_id(q.subject)
            p = predicate_to_attribute(q.predicate)
            obj = q.object
            if isinstance(obj, ox.NamedNode):
                v = uri_to_entity_id(obj)
            else:
                v = str(obj.value) if hasattr(obj, "value") else str(obj)
            out.append((s, p, v))
        return out


def import_from_sqlite(sqlite_path: str | Path, rdf_path: str | Path | None = None) -> RdfStore:
    """Read all live triples from a sinain SQLite store and load into Oxigraph.

    Stage 1 utility: lets us measure pure-storage benefit without re-distilling.
    """
    import sqlite3

    store = RdfStore(rdf_path)
    conn = sqlite3.connect(str(sqlite_path))
    conn.row_factory = sqlite3.Row

    rows = conn.execute(
        "SELECT entity_id, attribute, value, value_type FROM triples WHERE retracted = 0"
    ).fetchall()
    tx = store.begin_tx(source="sqlite_import")
    skipped = 0
    for r in rows:
        try:
            store.assert_triple(
                tx, r["entity_id"], r["attribute"], r["value"], r["value_type"] or "string"
            )
        except Exception as e:
            skipped += 1
    if skipped:
        print(f"[rdf-import] skipped {skipped} malformed triples")
    conn.close()
    return store


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("usage: python3 rdf_store.py <path-to-sqlite-knowledge-graph.db>")
        sys.exit(1)
    store = import_from_sqlite(sys.argv[1])
    print(f"Loaded {len(store)} triples from SQLite into RDF")
    print()
    print("Sample 5 triples:")
    sample = store.sparql("SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5")
    for row in sample:
        print(f"  {row}")
