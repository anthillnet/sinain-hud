"""Oxigraph-backed RDF store — Phase B.4.5.

Sole memory store backend (replaces the SQLite EAV triplestore.py). Provides
the full triplestore.py-compatible API plus higher-level retrieval helpers
that wrap SPARQL queries used by graph_query.py's hybrid retriever.

Design:
  - Subjects/predicates are URIs in the `sinain:` namespace
    (https://sinain.app/ns#) so the data is round-trippable to/from Turtle and
    interoperable with any SPARQL 1.1 tool.
  - Object values that look like entity refs (start with `entity:` or `fact:`)
    become URIs; everything else becomes a string Literal.
  - Aliases use `skos:altLabel` directly — no separate table needed; Oxigraph
    queries them via SPARQL.
  - Persistence: optional on-disk path; defaults to in-memory for testing.
  - Module-level store cache by absolute path: Oxigraph holds an exclusive
    on-disk lock per path, so multiple RdfStore(path) constructors in the
    same process must share one instance.

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

import math
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pyoxigraph as ox


NS_SINAIN = "https://sinain.app/ns#"
NS_ROOT = "https://sinain.app/"
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
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


_SAFE_SLUG = re.compile(r"[^a-zA-Z0-9._-]")


def _slug_safe(raw: str) -> str:
    return _SAFE_SLUG.sub("_", raw)


_PREFIX_OK = re.compile(r"^[a-z][a-z0-9_]*$")


def entity_id_to_uri(entity_id: str) -> ox.NamedNode:
    """Map a sinain entity_id (e.g. 'fact:city-bank-abc', 'signal:2026-03-01') to a
    NamedNode URI under https://sinain.app/<prefix>/<slug>. Round-trippable.

    Entries without a colon (or with a non-alphanumeric prefix) land in /misc/.
    """
    if ":" in entity_id:
        prefix, rest = entity_id.split(":", 1)
        if _PREFIX_OK.match(prefix):
            return ox.NamedNode(NS_ROOT + prefix + "/" + _slug_safe(rest))
    return ox.NamedNode(NS_MISC + _slug_safe(entity_id))


def uri_to_entity_id(uri) -> str:
    s = uri.value if hasattr(uri, "value") else str(uri)
    if not s.startswith(NS_ROOT):
        return s
    rest = s[len(NS_ROOT):]
    if rest.startswith("misc/"):
        return rest[len("misc/"):]
    if "/" in rest:
        prefix, slug = rest.split("/", 1)
        return f"{prefix}:{slug}"
    return rest


def _is_ref_like(value: Any) -> bool:
    """A value is "ref-like" if it has a sinain entity_id shape: lowercase
    prefix + colon + slug. Used as a hint for retraction (try removing both
    Literal and NamedNode forms because callers don't always carry value_type
    around)."""
    if not isinstance(value, str):
        return False
    if ":" not in value:
        return False
    prefix = value.split(":", 1)[0]
    return bool(_PREFIX_OK.match(prefix))


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


def _object_to_python(obj) -> str:
    if isinstance(obj, ox.NamedNode):
        return uri_to_entity_id(obj)
    return str(obj.value) if hasattr(obj, "value") else str(obj)


def decayed_confidence(
    confidence: float, created_at: str, half_life_days: int = 60
) -> float:
    """Exponential time-decay applied to a confidence score (re-exported for
    parity with the old triplestore.py — graph_query.py imports it from here
    via the triplestore shim)."""
    try:
        created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        age_days = (datetime.now(timezone.utc) - created).days
        if age_days <= 0:
            return confidence
        return confidence * math.exp(-0.693 * age_days / half_life_days)
    except (ValueError, TypeError):
        return confidence


_STORE_CACHE: dict[str, "RdfStore"] = {}


class _FtsIndex:
    """In-memory inverted index over ``value`` triples for O(query-terms) BM25
    search instead of an O(corpus) full scan on every ``fts_search`` call.

    ``word2eids``: word → set of fact eids whose value contains that word.
    ``eid_doc``:   eid → (lowercased value text, doc length in words).

    The old path matched query tokens as SUBSTRINGS (``tok in text``), so a
    plain word-token index would change results. We preserve that exactly: a
    query token has no spaces, so it can only occur WITHIN a single word — to
    find docs containing token ``t`` we scan the (much smaller) vocabulary for
    words containing ``t`` and union their postings. df / tf / doc-length / N
    are all reproduced from the index, so fts_search returns byte-identical
    rankings to the full-scan version, just without touching every fact."""

    __slots__ = ("word2eids", "eid_doc", "total_len")

    def __init__(self) -> None:
        self.word2eids: dict[str, set[str]] = {}
        self.eid_doc: dict[str, tuple[str, int]] = {}
        self.total_len = 0

    def add(self, eid: str, text: str) -> None:
        # Facts are immutable (content-hash id) so a value never changes — first
        # write wins, matching the old `seen` de-dup of multiple value quads.
        if eid in self.eid_doc:
            return
        tl = text.lower()
        words = tl.split()
        dl = len(words) or 1
        self.eid_doc[eid] = (tl, dl)
        self.total_len += dl
        for w in set(words):
            self.word2eids.setdefault(w, set()).add(eid)

    def remove(self, eid: str) -> None:
        doc = self.eid_doc.pop(eid, None)
        if doc is None:
            return
        tl, dl = doc
        self.total_len -= dl
        for w in set(tl.split()):
            s = self.word2eids.get(w)
            if s is not None:
                s.discard(eid)
                if not s:
                    self.word2eids.pop(w, None)


class RdfStore:
    """Oxigraph-backed triple store with the sinain triplestore API surface."""

    def __new__(cls, path: str | Path | None = None, read_only: bool = False):
        if path is None:
            inst = super().__new__(cls)
            inst._cache_key = None
            return inst
        # SINAIN_KG_READONLY=1 makes the WHOLE process open read-only — the KG
        # daemon sets it so graph_query's internal RdfStore(path) opens also stay
        # read-only (and out of the writer's lock). Read-only opens get a
        # distinct cache key so they never share an instance with a writer.
        read_only = read_only or os.environ.get("SINAIN_KG_READONLY") == "1"
        key = ("ro:" if read_only else "") + str(Path(path).expanduser().resolve())
        cached = _STORE_CACHE.get(key)
        if cached is not None:
            return cached
        inst = super().__new__(cls)
        inst._cache_key = key
        _STORE_CACHE[key] = inst
        return inst

    def __init__(self, path: str | Path | None = None, read_only: bool = False):
        if getattr(self, "_initialized", False):
            return
        self._initialized = True
        read_only = read_only or os.environ.get("SINAIN_KG_READONLY") == "1"
        self.read_only = read_only
        self.db_path = "" if path is None else str(Path(path).expanduser())
        self._fts: _FtsIndex | None = None  # lazy inverted index for fts_search
        if path is None:
            self._store = ox.Store()
        elif read_only:
            # Read-only open does NOT take the exclusive RocksDB write lock, so a
            # long-lived reader (KG warm-index daemon) coexists with the
            # distillation writer. Snapshot at open time; reopen to refresh.
            try:
                self._store = ox.Store.read_only(str(Path(path).expanduser()))
            except Exception as e:  # noqa: BLE001
                # Corrupt/absent on-disk store; we can't repair it read-only (the
                # writer owns recreation). Serve an empty in-memory store so
                # queries return nothing instead of raising — a later reopen picks
                # up the store once the writer has recreated it.
                print(f"[rdf_store] read-only KG open failed ({e}); serving empty until rebuilt", file=sys.stderr)
                self._store = ox.Store()
        else:
            p = Path(path).expanduser()
            p.parent.mkdir(parents=True, exist_ok=True)
            self._store = self._open_writable_or_recover(p)

    @staticmethod
    def _open_writable_or_recover(p: Path) -> "ox.Store":
        """Open the on-disk RocksDB store, recovering from corruption.

        A missing WAL (`*.log`) or SST file — e.g. after an unclean shutdown —
        makes RocksDB raise on open or on the first file access. The graph is
        rebuildable from sessions, so we quarantine the broken store and start
        fresh rather than stay permanently broken. We ONLY do this for
        corruption signatures — a lock-contention error (another writer holds
        the exclusive lock) must NOT destroy a healthy store, so it re-raises."""
        try:
            return ox.Store(str(p))
        except Exception as e:  # noqa: BLE001
            msg = str(e).lower()
            corrupt = any(k in msg for k in (
                "no such file", "corrupt", "while stat", "io error", "not found", "truncated",
            ))
            if not (corrupt and p.exists()):
                raise  # lock contention / unknown — don't touch the data
            import shutil
            import time
            bak = p.with_name(f"{p.name}.corrupt-{int(time.time())}")
            try:
                shutil.move(str(p), str(bak))
                print(f"[rdf_store] quarantined corrupt KG → {bak.name} ({e}); starting fresh", file=sys.stderr)
            except Exception as me:  # noqa: BLE001
                print(f"[rdf_store] could not quarantine corrupt KG ({me})", file=sys.stderr)
            return ox.Store(str(p))

    # ----- Lifecycle -----

    def close(self) -> None:
        """Release the Oxigraph store; subsequent calls re-open via cache."""
        if self._cache_key is not None:
            _STORE_CACHE.pop(self._cache_key, None)
        self._store = None
        self._fts = None
        self._initialized = False

    def _ensure_fts(self) -> _FtsIndex:
        """Build the inverted index over current ``value`` triples on first use,
        then keep it in sync incrementally via assert_triple / retract_triple."""
        if self._fts is not None:
            return self._fts
        idx = _FtsIndex()
        p = attribute_to_predicate("value")
        for q in self._store.quads_for_pattern(None, p, None, None):
            if isinstance(q.object, ox.NamedNode):
                continue
            text = str(q.object.value) if hasattr(q.object, "value") else ""
            if text:
                idx.add(uri_to_entity_id(q.subject), text)
        self._fts = idx
        return idx

    # ----- Transactions (no-op stubs — Oxigraph commits per-insert) -----

    def begin_tx(
        self,
        source: str,
        session_key: str | None = None,
        parent_tx: int | None = None,
        metadata: Any = None,
    ) -> dict:
        return {
            "source": source,
            "session_key": session_key,
            "parent_tx": parent_tx,
            "metadata": metadata,
            "started_at": _now_iso(),
        }

    def commit_tx(self, tx) -> None:
        return None

    def latest_tx(self) -> int:
        return 0

    # ----- Assert / Retract -----

    def assert_triple(
        self,
        tx,
        entity_id: str,
        attribute: str,
        value: Any,
        value_type: str = "string",
    ) -> None:
        s = entity_id_to_uri(entity_id)
        p = attribute_to_predicate(attribute)
        o = value_to_term(value, value_type)
        self._store.add(ox.Quad(s, p, o))
        # Keep the fts index in sync for new searchable text (idempotent add).
        if attribute == "value" and self._fts is not None and not isinstance(o, ox.NamedNode):
            self._fts.add(entity_id, str(value))

    def retract_triple(
        self,
        tx,
        entity_id: str,
        attribute: str,
        value: Any = None,
    ) -> int:
        """Remove quads matching (entity, attribute, value).

        When value is None, remove every quad matching (entity, attribute, ?).
        When value is given, remove quads whose object's serialized form equals
        either the Literal form OR the NamedNode form (callers don't always
        know value_type at retract time — e.g., `for val in attrs[attr_name]`
        flows through both ref and non-ref attributes).
        """
        s = entity_id_to_uri(entity_id)
        p = attribute_to_predicate(attribute)
        if value is None:
            quads = list(self._store.quads_for_pattern(s, p, None, None))
            for q in quads:
                self._store.remove(q)
            if quads and attribute == "value" and self._fts is not None:
                self._fts.remove(entity_id)
            return len(quads)
        candidates = []
        if _is_ref_like(value):
            candidates.append(value_to_term(value, "ref"))
        candidates.append(value_to_term(value, "string"))
        seen = set()
        removed = 0
        for term in candidates:
            for q in list(self._store.quads_for_pattern(s, p, term, None)):
                key = (str(q.subject), str(q.predicate), str(q.object))
                if key in seen:
                    continue
                seen.add(key)
                self._store.remove(q)
                removed += 1
        if removed and attribute == "value" and self._fts is not None:
            self._fts.remove(entity_id)
        return removed

    # ----- T1-SUPERSEDE: bi-temporal soft-retract -----

    def soft_retract_triple(
        self, tx, entity_id: str, superseded_by: str | None = None, valid_to: str | None = None
    ) -> None:
        """Mark a fact as no-longer-current WITHOUT deleting it (bi-temporal
        supersession, eval-log T1-SUPERSEDE). The fact keeps all its quads — so
        history / as-of queries still see it — but gains a ``valid_to`` timestamp
        and (optionally) a ``supersededBy`` pointer to the fact that replaced it.
        Current-state reads exclude facts that carry ``valid_to`` (see
        ``is_current`` / ``entity_as_of``). Reversible: drop the valid_to quad to
        re-instate. RDF-idiomatic (reify on the existing fact node), no quad delete."""
        from datetime import datetime, timezone
        vt = valid_to or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        self.assert_triple(tx, entity_id, "valid_to", vt)
        if superseded_by:
            self.assert_triple(tx, entity_id, "supersededBy", superseded_by, value_type="ref")

    @staticmethod
    def is_current(attrs: dict) -> bool:
        """A fact is CURRENT iff it carries no ``valid_to`` (not yet superseded)."""
        return not attrs.get("valid_to")

    # ----- Entity reads -----

    def entity(self, entity_id: str, as_of_tx: int | None = None) -> dict[str, list[str]]:
        """Return {attribute: [values]} for an entity. as_of_tx is accepted for
        API parity but ignored — Oxigraph doesn't track tx history."""
        s = entity_id_to_uri(entity_id)
        out: dict[str, list[str]] = {}
        for quad in self._store.quads_for_pattern(s, None, None, None):
            attr = predicate_to_attribute(quad.predicate)
            out.setdefault(attr, []).append(_object_to_python(quad.object))
        return out

    def entity_as_of(self, entity_id: str, date) -> dict[str, list[str]]:
        """Real bi-temporal as-of read: return the entity's attributes only if it
        was VALID at ``date`` — i.e. it has no ``valid_to``, or its ``valid_to`` is
        AFTER ``date`` (it was still current then). Empty dict if it was already
        superseded by ``date``. ``date`` is an ISO string (compared lexically, which
        is correct for ISO-8601). Current-state callers pass no date and use
        ``entity`` + ``is_current``."""
        attrs = self.entity(entity_id)
        vt = attrs.get("valid_to")
        if not vt:
            return attrs
        try:
            vt0 = vt[0] if isinstance(vt, list) else vt
            return attrs if str(vt0) > str(date) else {}
        except Exception:
            return attrs

    def entities_with_attr(
        self, attribute: str, as_of_tx: int | None = None
    ) -> list[tuple[str, str]]:
        p = attribute_to_predicate(attribute)
        results: list[tuple[str, str]] = []
        for quad in self._store.quads_for_pattern(None, p, None, None):
            results.append((uri_to_entity_id(quad.subject), _object_to_python(quad.object)))
        return results

    def lookup(
        self, attribute: str, value: Any, as_of_tx: int | None = None
    ) -> list[str]:
        p = attribute_to_predicate(attribute)
        out: list[str] = []
        seen = set()
        candidates = [value_to_term(value, "string")]
        if _is_ref_like(value):
            candidates.append(value_to_term(value, "ref"))
        for term in candidates:
            for q in self._store.quads_for_pattern(None, p, term, None):
                eid = uri_to_entity_id(q.subject)
                if eid not in seen:
                    seen.add(eid)
                    out.append(eid)
        return out

    def backrefs(
        self,
        target: str,
        attribute: str | None = None,
        as_of_tx: int | None = None,
    ) -> list[tuple[str, str]]:
        """Return [(entity_id, attribute)] for ref triples pointing to target.

        Filters to URI objects only — Literal-valued triples aren't refs.
        """
        target_uri = entity_id_to_uri(target)
        p = attribute_to_predicate(attribute) if attribute else None
        out: list[tuple[str, str]] = []
        for q in self._store.quads_for_pattern(None, p, target_uri, None):
            if not isinstance(q.object, ox.NamedNode):
                continue
            out.append((uri_to_entity_id(q.subject), predicate_to_attribute(q.predicate)))
        return out

    def neighbors(
        self, entity_id: str, depth: int = 1, as_of_tx: int | None = None
    ) -> dict[str, dict[str, list[str]]]:
        """BFS over ref edges (both directions). Returns {eid: {attr: [vals]}}."""
        visited: set[str] = set()
        frontier = {entity_id}
        result: dict[str, dict[str, list[str]]] = {}

        for _ in range(depth + 1):
            next_frontier: set[str] = set()
            for eid in frontier:
                if eid in visited:
                    continue
                visited.add(eid)
                attrs = self.entity(eid)
                if attrs:
                    result[eid] = attrs
                # Follow outgoing refs
                s = entity_id_to_uri(eid)
                for q in self._store.quads_for_pattern(s, None, None, None):
                    if isinstance(q.object, ox.NamedNode):
                        next_frontier.add(uri_to_entity_id(q.object))
                # Follow incoming refs
                for src_eid, _ in self.backrefs(eid):
                    next_frontier.add(src_eid)
            frontier = next_frontier - visited

        return result

    # ----- Aliases -----

    def add_alias(
        self,
        canonical_id: str,
        alias: str,
        confidence: float = 1.0,
        source: str = "extracted",
    ) -> None:
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
        for row in self._store.query(sparql):
            canonical = row["canonical"]
            out.append((uri_to_entity_id(canonical), 1.0))
        return out

    def aliases_of(self, canonical_id: str) -> list[str]:
        s = entity_id_to_uri(canonical_id)
        p = ox.NamedNode(NS_SKOS + "altLabel")
        return [
            str(q.object.value) for q in self._store.quads_for_pattern(s, p, None, None)
        ]

    # ----- Novelty / touched (no-op — Oxigraph doesn't track tx ids) -----

    def novelty(self, since_tx: int, until_tx: int | None = None) -> list[dict]:
        return []

    def was_touched(self, entity_id: str, since_tx: int) -> bool:
        return False

    def touched_entities_since(self, since_tx: int) -> list[str]:
        return []

    # ----- GC / stats -----

    def gc(self, older_than_days: int = 30) -> int:
        return 0

    def stats(self) -> dict:
        try:
            db_size = (
                sum(
                    f.stat().st_size for f in Path(self.db_path).rglob("*") if f.is_file()
                )
                if self.db_path and Path(self.db_path).exists()
                else 0
            )
        except OSError:
            db_size = 0
        triple_count = len(self)
        return {
            "triples": triple_count,
            "entities": 0,
            "transactions": 0,
            "db_size_bytes": db_size,
        }

    # ----- Raw SPARQL escape hatch -----

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
            out.append((s, p, _object_to_python(q.object)))
        return out

    # =====================================================================
    # High-level retrieval helpers — wrap SPARQL queries that graph_query.py
    # used to issue as raw SQL against the SQLite triplestore.
    # =====================================================================

    def tag_ranked_search(
        self, tags: list[str], limit: int
    ) -> list[tuple[str, int]]:
        """Facts ranked by # of matching tags. Returns [(entity_id, matches)]."""
        if not tags:
            return []
        tags_lc = [t.lower() for t in tags]
        values_clause = " ".join(f'"{t}"' for t in tags_lc)
        sparql = f"""
        {SPARQL_PREFIXES}
        SELECT ?eid (COUNT(?tag) AS ?matches) WHERE {{
            ?eid sinain:tag ?tag .
            VALUES ?tag {{ {values_clause} }}
        }}
        GROUP BY ?eid
        ORDER BY DESC(?matches) ?eid
        LIMIT {int(limit)}
        """
        out: list[tuple[str, int]] = []
        for row in self._store.query(sparql):
            eid = uri_to_entity_id(row["eid"])
            try:
                matches = int(str(row["matches"].value))
            except (AttributeError, ValueError):
                matches = 0
            out.append((eid, matches))
        return out

    def tag_intersection(
        self, tags: list[str], min_matches: int, limit: int
    ) -> list[tuple[str, int]]:
        """Facts whose distinct-tag count among `tags` is >= min_matches."""
        if not tags:
            return []
        tags_lc = [t.lower() for t in tags]
        values_clause = " ".join(f'"{t}"' for t in tags_lc)
        sparql = f"""
        {SPARQL_PREFIXES}
        SELECT ?eid (COUNT(DISTINCT ?tag) AS ?matches) WHERE {{
            ?eid sinain:tag ?tag .
            VALUES ?tag {{ {values_clause} }}
        }}
        GROUP BY ?eid
        HAVING (COUNT(DISTINCT ?tag) >= {int(min_matches)})
        ORDER BY DESC(?matches) ?eid
        LIMIT {int(limit)}
        """
        out: list[tuple[str, int]] = []
        for row in self._store.query(sparql):
            eid = uri_to_entity_id(row["eid"])
            try:
                matches = int(str(row["matches"].value))
            except (AttributeError, ValueError):
                matches = 0
            out.append((eid, matches))
        return out

    def top_facts_by_confidence(self, limit: int) -> list[tuple[str, float]]:
        """Top-N facts by confidence value (stored as a string Literal)."""
        sparql = f"""
        {SPARQL_PREFIXES}
        SELECT ?eid ?conf WHERE {{
            ?eid sinain:confidence ?conf .
            FILTER(STRSTARTS(STR(?eid), "{NS_FACT}"))
        }}
        """
        rows: list[tuple[str, float]] = []
        for row in self._store.query(sparql):
            eid = uri_to_entity_id(row["eid"])
            try:
                conf = float(str(row["conf"].value))
            except (AttributeError, ValueError, TypeError):
                conf = 0.0
            rows.append((eid, conf))
        # Deterministic tie-break: equal-confidence facts (most share 0.9)
        # ordered by eid so the top-N pool is stable across processes.
        rows.sort(key=lambda r: (-r[1], r[0]))
        return rows[: int(limit)]

    def fts_search(self, query: str, limit: int, with_scores: bool = False):
        """Keyword search across all `value` triples, ranked by Okapi BM25.

        Returns ranked entity ids (default). With ``with_scores=True`` returns
        ``[(eid, bm25_score)]`` instead — the BM25 scores are computed anyway but
        normally discarded; the entropy-weighted fusion (#4) needs the score
        DISTRIBUTION to gauge how peaked (discriminating) this query's keyword
        match is. Default return shape is unchanged so existing callers are safe.

        The legacy path was a pure-Python contains-filter that returned the
        *first* `limit` matches in arbitrary RocksDB iteration order — no
        relevance signal at all. That caused the A1.6 "rank-out": when many
        facts contain a query term, the genuinely-relevant one could sit past
        the cutoff and never reach the rerank window (see
        .planning/phases/diarization-levers/00-PLAN.md).

        Backed by an in-memory inverted index (``_FtsIndex``, built lazily and
        kept in sync by assert/retract): query tokens are resolved to candidate
        docs via the vocabulary, and only those candidates are BM25-scored —
        O(query terms) rather than an O(corpus) scan per call. Results are
        byte-identical to the previous full-scan path (same substring matching,
        same FTS5-style "term1 AND term2" / "term1 OR term2" gate (default AND),
        same BM25, same deterministic eid tie-break) — the ranked list still
        gives RRF a meaningful per-rank signal.
        """
        q = (query or "").strip()
        if not q:
            return []
        # Parse AND / OR. Default behavior: every token must appear.
        ql = q.lower()
        require_or = False
        if " or " in ql:
            tokens = [t.strip().strip('"') for t in re.split(r"\s+or\s+", ql)]
            require_or = True
        elif " and " in ql:
            tokens = [t.strip().strip('"') for t in re.split(r"\s+and\s+", ql)]
        else:
            tokens = [t for t in re.split(r"\s+", ql) if t]
        tokens = [t for t in tokens if t]
        if not tokens:
            return []

        idx = self._ensure_fts()
        n_docs = len(idx.eid_doc)
        if not n_docs:
            return []

        # Docs containing each token AS A SUBSTRING, resolved via a vocabulary scan
        # (a query token has no spaces, so it can only occur inside one word). This
        # reproduces the old `tok in text` matching exactly and yields df without
        # touching the corpus. Only docs that contain a query token are scored —
        # the old path iterated every fact to discover the same set.
        def _docs_with_substring(sub: str) -> set[str]:
            # eids whose value contains `sub` (a single word, no spaces) — exact
            # postings plus any longer vocabulary word that contains it.
            hits: set[str] = set()
            exact = idx.word2eids.get(sub)
            if exact is not None:
                hits |= exact
            for w, eids in idx.word2eids.items():
                if w != sub and sub in w:
                    hits |= eids
            return hits

        tok_eids: dict[str, set[str]] = {}
        for tok in tokens:
            subwords = tok.split()
            if not subwords:
                tok_eids[tok] = set()
                continue
            # A doc contains token `tok` (possibly a multi-word phrase from an
            # AND/OR split) only if it contains every word of it; for phrases we
            # then verify the full substring on that small candidate set, so
            # `tok in text` matching is reproduced exactly.
            cand = set.intersection(*[_docs_with_substring(sw) for sw in subwords])
            if len(subwords) > 1:
                cand = {eid for eid in cand if tok in idx.eid_doc[eid][0]}
            tok_eids[tok] = cand
        # NB: the old full-scan incremented df once per (doc × token-occurrence),
        # so a token repeated in the query inflated its df by that repeat count.
        # Reproduce it exactly (× tok_counts) so with_scores BM25 stays bit-identical;
        # "fixing" this df weighting would shift fusion scores — a separate change.
        from collections import Counter
        tok_counts = Counter(tokens)
        df = {tok: len(eids) * tok_counts[tok] for tok, eids in tok_eids.items()}

        # Candidate gate identical to the old scan: OR ⇒ ≥1 token, AND ⇒ all tokens.
        if require_or:
            candidates: set[str] = set().union(*tok_eids.values()) if tok_eids else set()
        else:
            candidates = None  # type: ignore[assignment]
            for tok in tokens:
                candidates = set(tok_eids[tok]) if candidates is None else (candidates & tok_eids[tok])
                if not candidates:
                    break
            candidates = candidates or set()
        if not candidates:
            return []

        import math
        avgdl = (idx.total_len / n_docs) if n_docs else 1.0
        k1, b = 1.5, 0.75
        scored: list[tuple[float, str]] = []
        for eid in candidates:
            text, dl = idx.eid_doc[eid]
            score = 0.0
            for tok in tokens:
                tf = text.count(tok)
                if tf == 0:
                    continue
                n_t = df.get(tok, 0)
                idf = math.log(1 + (n_docs - n_t + 0.5) / (n_t + 0.5))
                score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl))
            scored.append((score, eid))
        # Deterministic tie-break: equal-BM25 docs sorted by eid (T1-DETERMINISM —
        # retrieval ties are the run-to-run variance ceiling).
        scored.sort(key=lambda x: (-x[0], x[1]))
        top = scored[: int(limit)]
        if with_scores:
            return [(eid, sc) for sc, eid in top]
        return [eid for _, eid in top]

    def entity_id_or_domain_search(
        self,
        keywords: list[str],
        exclude_ids: list[str],
        limit: int,
    ) -> list[str]:
        """Fallback retrieval: facts whose `domain` matches any keyword OR
        whose entity_id slug starts with one of the keywords."""
        if not keywords:
            return []
        kw_lower = [k.lower() for k in keywords]
        domain_p = attribute_to_predicate("domain")
        exclude = set(exclude_ids)
        out: list[str] = []
        seen = set()
        for q in self._store.quads_for_pattern(None, domain_p, None, None):
            text = str(q.object.value).lower() if hasattr(q.object, "value") else ""
            if text in kw_lower:
                eid = uri_to_entity_id(q.subject)
                if eid in exclude or eid in seen:
                    continue
                seen.add(eid)
                out.append(eid)
                if len(out) >= int(limit):
                    return out
        for q in self._store:
            eid = uri_to_entity_id(q.subject)
            if not eid.startswith("fact:"):
                continue
            if eid in exclude or eid in seen:
                continue
            slug = eid.split(":", 1)[1]
            if any(slug.startswith(k) for k in kw_lower):
                seen.add(eid)
                out.append(eid)
                if len(out) >= int(limit):
                    break
        return out

    def session_co_occurrence(
        self, tag_a: str, tag_b: str, limit: int
    ) -> list[str]:
        """Find `first_seen` timestamps shared by facts tagged with both tag_a
        and tag_b — proxy for "sessions where both topics appeared."""
        sparql = f"""
        {SPARQL_PREFIXES}
        SELECT DISTINCT ?ts WHERE {{
            ?ea sinain:tag "{tag_a.lower()}" .
            ?ea sinain:first_seen ?ts .
            ?eb sinain:tag "{tag_b.lower()}" .
            ?eb sinain:first_seen ?ts .
        }} LIMIT {int(limit)}
        """
        out: list[str] = []
        for row in self._store.query(sparql):
            val = row["ts"]
            if val is not None:
                out.append(str(val.value) if hasattr(val, "value") else str(val))
        return out

    def facts_by_first_seen(
        self, timestamps: list[str], limit: int
    ) -> list[str]:
        """Fact entities whose first_seen is one of the given timestamps."""
        if not timestamps:
            return []
        values_clause = " ".join(f'"{t}"' for t in timestamps)
        sparql = f"""
        {SPARQL_PREFIXES}
        SELECT DISTINCT ?eid WHERE {{
            ?eid sinain:first_seen ?ts .
            VALUES ?ts {{ {values_clause} }}
            FILTER(STRSTARTS(STR(?eid), "{NS_FACT}"))
        }} ORDER BY ?eid LIMIT {int(limit)}
        """
        out: list[str] = []
        for row in self._store.query(sparql):
            out.append(uri_to_entity_id(row["eid"]))
        return out

    def domain_fact_counts(self) -> dict[str, int]:
        """`domain` value → count of distinct entities with that domain."""
        sparql = f"""
        {SPARQL_PREFIXES}
        SELECT ?domain (COUNT(DISTINCT ?eid) AS ?cnt) WHERE {{
            ?eid sinain:domain ?domain .
        }} GROUP BY ?domain ORDER BY DESC(?cnt)
        """
        out: dict[str, int] = {}
        for row in self._store.query(sparql):
            dom = str(row["domain"].value) if hasattr(row["domain"], "value") else str(row["domain"])
            try:
                cnt = int(str(row["cnt"].value))
            except (AttributeError, ValueError, TypeError):
                cnt = 0
            out[dom] = cnt
        return out


def import_from_sqlite(sqlite_path: str | Path, rdf_path: str | Path | None = None) -> RdfStore:
    """Read all live triples from a sinain SQLite store and load into Oxigraph.

    Utility for migrating existing benchmark DBs without re-distilling.
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
        except Exception:
            skipped += 1
    if skipped:
        print(f"[rdf-import] skipped {skipped} malformed triples", file=sys.stderr)
    conn.close()
    return store


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------


def _self_test() -> None:
    print("Running rdf_store self-test...")

    store = RdfStore()
    tx1 = store.begin_tx("self-test", session_key="test-session")

    # Assert triples
    store.assert_triple(tx1, "signal:2026-03-01", "description", "OCR stall detected")
    store.assert_triple(tx1, "signal:2026-03-01", "priority", "high")
    store.assert_triple(tx1, "signal:2026-03-01", "related_to", "concept:ocr", value_type="ref")
    store.assert_triple(tx1, "concept:ocr", "name", "OCR")
    store.assert_triple(tx1, "pattern:frame-batching", "text", "Frame batching improves OCR")
    store.assert_triple(tx1, "pattern:frame-batching", "related_to", "concept:ocr", value_type="ref")

    ent = store.entity("signal:2026-03-01")
    assert "description" in ent, ent
    assert ent["description"] == ["OCR stall detected"]
    assert ent["priority"] == ["high"]
    print("  [OK] entity view")

    with_desc = store.entities_with_attr("description")
    assert ("signal:2026-03-01", "OCR stall detected") in with_desc
    print("  [OK] entities_with_attr")

    refs = store.backrefs("concept:ocr")
    entity_ids = [r[0] for r in refs]
    assert "signal:2026-03-01" in entity_ids
    assert "pattern:frame-batching" in entity_ids
    print("  [OK] backrefs")

    found = store.lookup("name", "OCR")
    assert "concept:ocr" in found
    print("  [OK] lookup")

    nbrs = store.neighbors("concept:ocr", depth=1)
    assert "concept:ocr" in nbrs
    assert "signal:2026-03-01" in nbrs or "pattern:frame-batching" in nbrs
    print("  [OK] neighbors")

    count = store.retract_triple(tx1, "signal:2026-03-01", "priority")
    assert count == 1, count
    ent_after = store.entity("signal:2026-03-01")
    assert "priority" not in ent_after
    print("  [OK] retract by entity+attr (value=None)")

    # Retract with explicit ref value
    store.retract_triple(tx1, "signal:2026-03-01", "related_to", "concept:ocr")
    ent_after2 = store.entity("signal:2026-03-01")
    assert "related_to" not in ent_after2, ent_after2
    print("  [OK] retract ref by value")

    # Tag-ranked search
    tx2 = store.begin_tx("tags")
    store.assert_triple(tx2, "fact:a", "tag", "python")
    store.assert_triple(tx2, "fact:a", "tag", "django")
    store.assert_triple(tx2, "fact:b", "tag", "python")
    ranked = store.tag_ranked_search(["python", "django"], 10)
    assert any(eid == "fact:a" for eid, _ in ranked)
    assert ranked[0][0] == "fact:a", ranked  # 2 matches > 1
    print("  [OK] tag_ranked_search")

    # Tag intersection
    inter = store.tag_intersection(["python", "django"], min_matches=2, limit=10)
    assert any(eid == "fact:a" for eid, _ in inter)
    assert all(eid != "fact:b" for eid, _ in inter)
    print("  [OK] tag_intersection")

    # Top facts by confidence
    store.assert_triple(tx2, "fact:a", "confidence", "0.9")
    store.assert_triple(tx2, "fact:b", "confidence", "0.5")
    top = store.top_facts_by_confidence(10)
    assert top[0][0] == "fact:a", top
    print("  [OK] top_facts_by_confidence")

    # FTS contains
    store.assert_triple(tx2, "fact:a", "value", "Django framework for Python")
    store.assert_triple(tx2, "fact:b", "value", "JavaScript runtime")
    fts = store.fts_search("django", 10)
    assert "fact:a" in fts, fts
    assert "fact:b" not in fts
    print("  [OK] fts_search")

    print("\n  All self-tests passed!")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        _self_test()
    elif len(sys.argv) >= 2 and not sys.argv[1].startswith("-"):
        store = import_from_sqlite(sys.argv[1])
        print(f"Loaded {len(store)} triples from SQLite into RDF")
        sample = store.sparql("SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5")
        for row in sample:
            print(f"  {row}")
    else:
        print("usage: python3 rdf_store.py --self-test")
        print("       python3 rdf_store.py <path-to-sqlite-knowledge-graph.db>")
