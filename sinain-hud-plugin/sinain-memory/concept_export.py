#!/usr/bin/env python3
"""Concept Export — package an entity + its neighborhood as a portable bundle.

Produces a sinain-concept/v1 envelope that can be transferred to another
machine and re-imported with concept_import.py to reconstruct the same
entity page (including the LLM-rendered view, if bundled).

The reproducibility invariant we honor:
    "On a new machine: import the bundle → open the same URL → see the same page."

For that to hold:
  1. Entity IDs are content-addressed slugs → stable across machines.
  2. Triples are exported verbatim (created_at, retracted) for round-trip.
  3. Optionally bundle the rendered_page JSON so the receiver gets a
     cache hit on first view (deterministic visual identity).

We do NOT bundle embeddings — same model on both ends → same vectors,
so receiver recomputes for ~1.5KB/fact saved.

Usage:
    python3 concept_export.py --db <kg.db> --root entity:foo \\
        [--depth 1] [--include-retracted] [--include-page] [--web-db <web.db>] \\
        [--redact private,creditcard,apikey,...]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Redaction (MIRROR OF sense_client/privacy.py — keep patterns in sync until
# we extract a shared sinain-memory/redaction.py module).
# ---------------------------------------------------------------------------
REDACT_RULES_VERSION = "1.2"

_REDACT_PATTERNS: list[tuple[re.Pattern, str, str]] = [
    # (regex, replacement, rule-name)
    (re.compile(r"\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b"), "[REDACTED:card]", "creditcard"),
    (re.compile(r"\b(?:sk-|pk-|api[_-]?key[=:]\s*)[A-Za-z0-9_\-]{20,}\b"), "[REDACTED:apikey]", "apikey"),
    (re.compile(r"Bearer\s+[A-Za-z0-9_\-\.]{20,}"), "[REDACTED:bearer]", "bearer"),
    (re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"), "[REDACTED:awskey]", "awskey"),
    (re.compile(r"(?:password|passwd|pwd)\s*[:=]\s*\S+", re.IGNORECASE), "[REDACTED:password]", "password"),
    (re.compile(r"\bghp_[A-Za-z0-9]{36}\b"), "[REDACTED:github_pat]", "github_pat"),
    (re.compile(r"\bghs_[A-Za-z0-9]{36}\b"), "[REDACTED:github_srv]", "github_srv"),
    (re.compile(r"\bxox[bpoa]-[0-9A-Za-z\-]+"), "[REDACTED:slack]", "slack"),
    (re.compile(r"\bya29\.[0-9A-Za-z\-_]+"), "[REDACTED:google_oauth]", "google_oauth"),
    (re.compile(r"\beyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+"), "[REDACTED:jwt]", "jwt"),
    (re.compile(r"(?:secret|token|key)\s*[:=]\s*[A-Za-z0-9_\-\.]{10,}", re.IGNORECASE), "[REDACTED:secret]", "secret"),
    (re.compile(r"\b\d{3}-\d{2}-\d{4}\b"), "[REDACTED:ssn]", "ssn"),
    (re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"), "[REDACTED:privkey]", "privkey"),
]
_PRIVATE_TAG = re.compile(r"<private>.*?</private>", re.DOTALL)


def apply_redactions(text: str, enabled_rules: set[str]) -> tuple[str, list[str]]:
    """Run enabled redaction rules over *text*. Returns (redacted_text, applied)."""
    applied: list[str] = []
    if "private" in enabled_rules:
        new_text = _PRIVATE_TAG.sub("[REDACTED:private]", text)
        if new_text != text:
            applied.append("private")
            text = new_text
    for pattern, replacement, name in _REDACT_PATTERNS:
        if name in enabled_rules:
            new_text = pattern.sub(replacement, text)
            if new_text != text:
                applied.append(name)
                text = new_text
    return text, applied


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

def collect_neighborhood(store, root_entity: str, depth: int,
                         include_retracted: bool) -> list[str]:
    """BFS from root, following both incoming and outgoing refs.

    Outgoing: triples WHERE entity_id = X AND value_type = 'ref' → recurse to value.
    Incoming: triples WHERE value = X AND value_type = 'ref' → recurse to entity_id.

    Returns deterministically-ordered list of entity_ids reachable within depth.
    """
    visited: dict[str, int] = {root_entity: 0}
    queue: list[tuple[str, int]] = [(root_entity, 0)]
    retracted_filter = "" if include_retracted else "AND retracted = 0"

    while queue:
        eid, d = queue.pop(0)
        if d >= depth:
            continue

        # Outgoing refs
        rows_out = store._conn.execute(
            f"""SELECT DISTINCT value FROM triples
                WHERE entity_id = ? AND value_type = 'ref' {retracted_filter}""",
            (eid,),
        ).fetchall()
        for r in rows_out:
            ref = r["value"]
            if ref and ref not in visited:
                visited[ref] = d + 1
                queue.append((ref, d + 1))

        # Incoming refs
        rows_in = store._conn.execute(
            f"""SELECT DISTINCT entity_id FROM triples
                WHERE value = ? AND value_type = 'ref' {retracted_filter}""",
            (eid,),
        ).fetchall()
        for r in rows_in:
            ref = r["entity_id"]
            if ref and ref not in visited:
                visited[ref] = d + 1
                queue.append((ref, d + 1))

    return sorted(visited.keys())  # deterministic ordering for stable checksum


def serialize_entity(store, entity_id: str, include_retracted: bool,
                     redact_rules: set[str]) -> tuple[dict, list[str], int]:
    """Pull all triples for entity_id, apply redactions to string values.

    Returns ({id, type, triples: [...]}, applied_rules, redacted_count).
    """
    where = "" if include_retracted else "AND retracted = 0"
    rows = store._conn.execute(
        f"""SELECT attribute, value, value_type, tx_id, created_at, retracted, valid_to
            FROM triples WHERE entity_id = ? {where}
            ORDER BY tx_id, attribute, value""",
        (entity_id,),
    ).fetchall()

    triples = []
    all_applied: list[str] = []
    redacted_count = 0
    for r in rows:
        value = r["value"]
        if r["value_type"] == "string" and redact_rules and value:
            new_value, applied = apply_redactions(value, redact_rules)
            if applied:
                all_applied.extend(applied)
                redacted_count += 1
                value = new_value
        triples.append({
            "attribute": r["attribute"],
            "value": value,
            "value_type": r["value_type"],
            "tx_id": r["tx_id"],
            "created_at": r["created_at"],
            "retracted": int(r["retracted"]),
            "valid_to": r["valid_to"],
        })

    type_prefix = entity_id.split(":", 1)[0] if ":" in entity_id else "unknown"
    return ({"id": entity_id, "type": type_prefix, "triples": triples},
            all_applied, redacted_count)


def fetch_cached_page(web_db_path: str, root_entity: str,
                     redact_rules: set[str]) -> dict | None:
    """Pull the most recent cached rendered_page for root_entity, if any.
    Apply redactions over the page summary + bullet text too — the LLM may
    have woven sensitive content into its synthesis.
    """
    import sqlite3
    if not Path(web_db_path).exists():
        return None
    try:
        conn = sqlite3.connect(web_db_path)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            """SELECT page_json, generated_at, tokens_in, tokens_out, cost_usd
               FROM page_cache WHERE entity_id = ?
               ORDER BY generated_at DESC LIMIT 1""",
            (root_entity,),
        ).fetchone()
        conn.close()
        if not row:
            return None
        page = json.loads(row["page_json"])
        # Redact rendered_page content.
        if redact_rules:
            if page.get("summary"):
                new_summary, _ = apply_redactions(page["summary"], redact_rules)
                page["summary"] = new_summary
            for sec in page.get("sections", []) or []:
                for b in sec.get("bullets", []) or []:
                    if b.get("text"):
                        new_text, _ = apply_redactions(b["text"], redact_rules)
                        b["text"] = new_text
        page["generated_at"] = row["generated_at"]
        page.setdefault("rendered_with", {})
        if row["tokens_in"]: page["rendered_with"]["tokens_in"] = row["tokens_in"]
        if row["tokens_out"]: page["rendered_with"]["tokens_out"] = row["tokens_out"]
        return page
    except Exception as e:
        sys.stderr.write(f"fetch_cached_page failed: {e}\n")
        return None


def export_concept(db_path: str, root_entity: str, depth: int = 1,
                   include_retracted: bool = False,
                   include_page: bool = True,
                   web_db_path: str | None = None,
                   redact_rules: set[str] | None = None) -> dict:
    from triplestore import TripleStore

    if redact_rules is None:
        redact_rules = {"private", "creditcard", "apikey", "bearer", "awskey",
                        "password", "secret"}

    store = TripleStore(db_path)
    entity_ids = collect_neighborhood(store, root_entity, depth, include_retracted)

    entities = []
    all_applied: list[str] = []
    total_redacted = 0
    triple_count = 0
    fact_count = 0

    for eid in entity_ids:
        entity_obj, applied, n_redacted = serialize_entity(
            store, eid, include_retracted, redact_rules,
        )
        entities.append(entity_obj)
        all_applied.extend(applied)
        total_redacted += n_redacted
        triple_count += len(entity_obj["triples"])
        if eid.startswith("fact:"):
            fact_count += 1

    store.close()

    rendered_page = None
    if include_page and web_db_path:
        rendered_page = fetch_cached_page(web_db_path, root_entity, redact_rules)

    envelope = {
        "format": "sinain-concept/v1",
        "exported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "exporter": {
            "tool": "sinain-core",
            "tool_version": "1.14.0",
            "schema_version": "triplestore/v3",
            "embedding_model": "all-MiniLM-L6-v2",
        },
        "root_entity": root_entity,
        "depth": depth,
        "stats": {
            "entities": len(entity_ids),
            "facts": fact_count,
            "triples": triple_count,
        },
        "entities": entities,
        "rendered_page": rendered_page,
        "redactions": {
            "applied": sorted(set(all_applied)),
            "rules_version": REDACT_RULES_VERSION,
            "redacted_count": total_redacted,
        },
    }

    # Compute checksum over canonical JSON of (root_entity + entities) — this is
    # what the receiver should validate against on import.
    canonical = json.dumps(
        {"root_entity": root_entity, "entities": entities},
        sort_keys=True, ensure_ascii=False, separators=(",", ":"),
    )
    envelope["checksum"] = "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return envelope


def main() -> None:
    parser = argparse.ArgumentParser(description="Concept Export")
    parser.add_argument("--db", required=True)
    parser.add_argument("--root", required=True, help="Root entity id (e.g. entity:citibank)")
    parser.add_argument("--depth", type=int, default=1)
    parser.add_argument("--include-retracted", action="store_true")
    parser.add_argument("--include-page", action="store_true",
                        help="Bundle the cached rendered_page if available")
    parser.add_argument("--web-db", default=None,
                        help="Path to web.db for page cache lookup")
    parser.add_argument("--redact", default="private,creditcard,apikey,bearer,awskey,password,secret",
                        help="Comma-separated redaction rule names")
    args = parser.parse_args()

    if not Path(args.db).exists():
        print(json.dumps({"error": f"db not found: {args.db}"}))
        sys.exit(1)

    rules = {r.strip() for r in args.redact.split(",") if r.strip()}
    envelope = export_concept(
        args.db, args.root, depth=args.depth,
        include_retracted=args.include_retracted,
        include_page=args.include_page,
        web_db_path=args.web_db,
        redact_rules=rules,
    )
    print(json.dumps(envelope, ensure_ascii=False))


if __name__ == "__main__":
    main()
