#!/usr/bin/env python3
"""lint_knowledge — the wiki's lint() operation over the knowledge graph.

Classifies CURRENT facts against the durability rules (durability.py) and the
T1/T2 boundary, reports findings, and (with --apply) bulk soft-retracts them —
bi-temporal, per-fact undo snapshots, same audit shape as web-ui retraction.
Nothing is deleted; the transcript escrow (raw sidecar / T1 episodes) keeps
every source utterance regardless.

Verdicts:
  escrow       kind=verbatim — raw transcript/agent output stored as a fact.
               Belongs in T1; applied by default.
  ephemeral    distilled claim failing the durability gate (presence data,
               stubs — "The user is working in Chrome"). Applied by default.
  fragment     auto-extracted bare phrase ("pinned side bar") — no claim.
               Applied by default.
  unattributed entity=general, no user reference — the junk-drawer subject.
               Report-only unless --aggressive (some are salvageable
               project notes; retraction is reversible either way).
  keep         everything else (not listed in output unless --verbose).

Usage:
  lint_knowledge.py --db <kg.db> [--web-db <web.db>] --report
  lint_knowledge.py --db <kg.db> --web-db <web.db> --apply [--aggressive]

Output: JSON {ok, counts, applied, findings:[{fact_id, entity, kind, value,
verdict, reason}]} on stdout.
"""
from __future__ import annotations

import argparse
import json
import secrets
import sqlite3
import sys
import time
from pathlib import Path

from durability import is_ephemeral, NARRATION_RE  # noqa: F401 (re-export for tests)
from retract import snapshot_triples, UNDO_TTL_MS

# Regex mirror of knowledge_integrator._USER_REF (kept local to avoid pulling
# the integrator's heavy import surface into a lint run).
import re
_USER_REF = re.compile(r"\b(?:the user(?:'s|s')?|the user is|user's)\b", re.IGNORECASE)

APPLY_VERDICTS = ("escrow", "ephemeral", "fragment")


def classify(fid: str, attrs: dict) -> tuple[str, str] | None:
    """Return (verdict, reason) for a fact, or None for keep."""
    first = lambda k: (attrs.get(k) or [""])[0]
    kind = first("kind")
    value = first("value")
    entity = first("entity")

    if kind == "verbatim":
        return ("escrow",
                "raw transcript/agent output stored as a fact — T1 episode material")
    if kind == "auto-extracted" and len(value) < 30 and len(value.split()) <= 4:
        return ("fragment",
                "bare capitalized-phrase fragment — carries no claim")
    if kind in ("distilled", "auto-extracted", ""):
        if is_ephemeral(value):
            return ("ephemeral",
                    "presence data or stub — fails the two-week durability test")
        if entity == "general" and not _USER_REF.search(value or ""):
            return ("unattributed",
                    "junk-drawer subject 'general' with no user reference")
    return None


def collect_findings(db_path: str) -> list[dict]:
    from triplestore import TripleStore
    store = TripleStore(db_path)
    findings: list[dict] = []
    for fid, _ in store.entities_with_attr("value"):
        if not str(fid).startswith("fact:"):
            continue
        attrs = store.entity(fid)
        if not attrs or attrs.get("valid_to") or attrs.get("retracted_reason"):
            continue
        verdict = classify(fid, attrs)
        if not verdict:
            continue
        first = lambda k: (attrs.get(k) or [""])[0]
        findings.append({
            "fact_id": fid,
            "entity": first("entity"),
            "kind": first("kind"),
            "confidence": first("confidence"),
            "first_seen": first("first_seen"),
            "value": (first("value") or "")[:300],
            "verdict": verdict[0],
            "reason": verdict[1],
        })
    store.close()
    # Stable order: verdict, then entity, then id — the wiki page and repeat
    # runs render identically.
    findings.sort(key=lambda f: (f["verdict"], f["entity"], f["fact_id"]))
    return findings


def apply_findings(db_path: str, web_db_path: str | None,
                   findings: list[dict], aggressive: bool) -> int:
    """Bulk soft-retract — one store session, per-fact undo snapshots."""
    from triplestore import TripleStore
    verdicts = APPLY_VERDICTS + (("unattributed",) if aggressive else ())
    targets = [f for f in findings if f["verdict"] in verdicts]
    if not targets:
        return 0

    store = TripleStore(db_path)
    now_ms = int(time.time() * 1000)
    undo_rows, log_rows = [], []
    applied = 0
    for f in targets:
        fid = f["fact_id"]
        snapshot = snapshot_triples(store, fid)
        if not snapshot:
            continue
        reason = f"lint:{f['verdict']}"
        tx_id = store.begin_tx(source="lint",
                               metadata={"reason": reason, "actor": "lint"})
        for t in snapshot:
            store.retract_triple(tx_id, fid, t["attribute"], t["value"])
        store.assert_triple(tx_id, fid, "retracted_reason", reason, "string")
        store.assert_triple(tx_id, fid, "retracted_by", "lint", "string")
        token = secrets.token_hex(16)
        # begin_tx returns a context dict since the Oxigraph migration —
        # coerce for the integer retracted_tx column (see retract.py).
        tx_row = tx_id if isinstance(tx_id, int) else 0
        undo_rows.append((token, fid, json.dumps(snapshot), tx_row, reason,
                          "lint", now_ms, now_ms + UNDO_TTL_MS))
        log_rows.append((now_ms, fid, reason, "lint", f.get("entity") or None))
        f["undo_token"] = token
        applied += 1
    store.close()

    if web_db_path and Path(web_db_path).exists():
        try:
            conn = sqlite3.connect(web_db_path)
            conn.executemany(
                """INSERT INTO retraction_undo
                   (token, fact_id, snapshot_json, retracted_tx,
                    reason, actor, created_at, expires_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""", undo_rows)
            conn.executemany(
                """INSERT INTO retraction_log
                   (ts, fact_id, reason, actor, source_entity)
                   VALUES (?, ?, ?, ?, ?)""", log_rows)
            conn.commit()
            conn.close()
        except Exception as e:
            sys.stderr.write(f"lint: undo persist failed: {e}\n")
    return applied


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--web-db", default=None)
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--aggressive", action="store_true",
                    help="also retract 'unattributed' findings")
    args = ap.parse_args()

    findings = collect_findings(args.db)
    counts: dict[str, int] = {}
    for f in findings:
        counts[f["verdict"]] = counts.get(f["verdict"], 0) + 1

    applied = 0
    if args.apply:
        applied = apply_findings(args.db, args.web_db, findings, args.aggressive)

    print(json.dumps({
        "ok": True,
        "mode": "apply" if args.apply else "report",
        "counts": counts,
        "applied": applied,
        "findings": findings,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
