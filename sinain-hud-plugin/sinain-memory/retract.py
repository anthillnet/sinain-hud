#!/usr/bin/env python3
"""Fact retraction (soft-delete) for the web UI.

The triplestore already supports retraction via store.retract_triple() —
this script is the user-initiated equivalent of what knowledge_integrator
does automatically. The new ingredients are:

  1. Audit triples (retracted_reason, retracted_by) so the WHY survives.
  2. Pre-retraction snapshot saved to web.db.retraction_undo, single-use,
     10-minute TTL — gives the UI a real "undo" button.

Soft delete: rows stay; retracted=1 + retracted_tx + valid_to are set.
Bi-temporal queries (entity_as_of) still see the fact at past tx_ids.
Physical removal only happens via gc_retracted_triples (off by default).

Usage:
    python3 retract.py --retract --db <db> --web-db <web.db> \
        --fact-id fact:foo [--reason "..."] [--actor "..."]

    python3 retract.py --restore --db <db> --web-db <web.db> \
        --fact-id fact:foo --undo-token <token>
"""
from __future__ import annotations

import argparse
import json
import secrets
import sqlite3
import sys
import time
from pathlib import Path

UNDO_TTL_MS = 10 * 60 * 1000  # 10 minutes


def snapshot_triples(store, fact_id: str) -> list[dict]:
    """Capture every active triple for a fact entity for restore. Includes
    value_type so re-asserts preserve string-vs-ref semantics."""
    rows = store._conn.execute(
        """SELECT attribute, value, value_type, tx_id, created_at
           FROM triples
           WHERE entity_id = ? AND retracted = 0""",
        (fact_id,),
    ).fetchall()
    return [
        {
            "attribute": r["attribute"],
            "value": r["value"],
            "value_type": r["value_type"],
            "original_tx_id": r["tx_id"],
            "original_created_at": r["created_at"],
        }
        for r in rows
    ]


def retract_fact(db_path: str, web_db_path: str, fact_id: str,
                 reason: str | None, actor: str | None,
                 source_entity: str | None = None) -> dict:
    """Retract all triples for a fact entity + persist undo snapshot."""
    from triplestore import TripleStore

    store = TripleStore(db_path)
    snapshot = snapshot_triples(store, fact_id)
    if not snapshot:
        store.close()
        return {"ok": False, "error": "fact not found or already retracted",
                "fact_id": fact_id}

    metadata = {"actor": actor, "reason": reason, "source": "web-ui"}
    tx_id = store.begin_tx(source="web-ui-retract",
                           metadata={k: v for k, v in metadata.items() if v})

    # Retract every active triple
    triples_retracted = 0
    for t in snapshot:
        triples_retracted += store.retract_triple(
            tx_id, fact_id, t["attribute"], t["value"],
        )

    # Audit triples — these are NEW assertions ABOUT the retraction event
    if reason:
        store.assert_triple(tx_id, fact_id, "retracted_reason", reason, "string")
    if actor:
        store.assert_triple(tx_id, fact_id, "retracted_by", actor, "string")

    store.close()

    # Persist undo snapshot
    token = secrets.token_hex(16)
    now_ms = int(time.time() * 1000)
    expires_at = now_ms + UNDO_TTL_MS

    if Path(web_db_path).exists():
        try:
            conn = sqlite3.connect(web_db_path)
            conn.execute(
                """INSERT INTO retraction_undo
                   (token, fact_id, snapshot_json, retracted_tx,
                    reason, actor, created_at, expires_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (token, fact_id, json.dumps(snapshot),
                 tx_id, reason, actor, now_ms, expires_at),
            )
            conn.execute(
                """INSERT INTO retraction_log
                   (ts, fact_id, reason, actor, source_entity)
                   VALUES (?, ?, ?, ?, ?)""",
                (now_ms, fact_id, reason, actor, source_entity),
            )
            conn.commit()
            conn.close()
        except Exception as e:
            sys.stderr.write(f"undo persist failed: {e}\n")

    return {
        "ok": True,
        "fact_id": fact_id,
        "retracted": True,
        "retracted_tx": tx_id,
        "triples_retracted": triples_retracted,
        "undo_token": token,
        "expires_at": expires_at,
    }


def restore_fact(db_path: str, web_db_path: str, fact_id: str,
                 undo_token: str) -> dict:
    """Re-assert a previously retracted fact from the undo snapshot."""
    from triplestore import TripleStore

    if not Path(web_db_path).exists():
        return {"ok": False, "error": "web.db not available"}

    conn = sqlite3.connect(web_db_path)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT * FROM retraction_undo WHERE token = ? AND fact_id = ?",
        (undo_token, fact_id),
    ).fetchone()

    if not row:
        conn.close()
        return {"ok": False, "error": "undo token not found"}
    if row["consumed_at"] is not None:
        conn.close()
        return {"ok": False, "error": "undo token already consumed"}
    if row["expires_at"] < int(time.time() * 1000):
        conn.close()
        return {"ok": False, "error": "undo token expired"}

    original_retracted_tx = row["retracted_tx"]

    store = TripleStore(db_path)
    tx_id = store.begin_tx(source="web-ui-restore",
                           metadata={"undo_token": undo_token,
                                     "reverses_tx": original_retracted_tx})

    # Un-retract: flip retracted=0 on triples that were closed by the original
    # retraction tx. Avoids creating duplicate triples — the originals come back
    # with their original tx_ids and created_at intact, preserving bi-temporal
    # history.
    cur = store._conn.execute(
        """UPDATE triples SET retracted = 0, retracted_tx = NULL, valid_to = NULL
           WHERE entity_id = ? AND retracted_tx = ?""",
        (fact_id, original_retracted_tx),
    )
    triples_restored = cur.rowcount

    # Also retract the audit triples we wrote during retraction so they don't
    # linger as active facts on the restored entity.
    store.retract_triple(tx_id, fact_id, "retracted_reason")
    store.retract_triple(tx_id, fact_id, "retracted_by")

    store._conn.commit()
    store.close()

    # Mark consumed + log undo
    conn.execute(
        "UPDATE retraction_undo SET consumed_at = ? WHERE token = ?",
        (int(time.time() * 1000), undo_token),
    )
    conn.execute(
        """UPDATE retraction_log SET undone_at = ?
           WHERE rowid = (
             SELECT rowid FROM retraction_log
             WHERE fact_id = ? AND undone_at IS NULL
             ORDER BY ts DESC LIMIT 1
           )""",
        (int(time.time() * 1000), fact_id),
    )
    conn.commit()
    conn.close()

    return {
        "ok": True,
        "fact_id": fact_id,
        "restored": True,
        "restored_tx": tx_id,
        "triples_restored": triples_restored,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Fact retraction / restore")
    parser.add_argument("--db", required=True, help="Knowledge graph DB path")
    parser.add_argument("--web-db", required=True, help="Web metadata DB path")
    parser.add_argument("--fact-id", required=True, help="Fact entity id (e.g. fact:foo)")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--retract", action="store_true")
    mode.add_argument("--restore", action="store_true")
    parser.add_argument("--reason", default=None)
    parser.add_argument("--actor", default=None)
    parser.add_argument("--source-entity", default=None,
                        help="Entity page user was on when retracting (telemetry)")
    parser.add_argument("--undo-token", default=None)
    args = parser.parse_args()

    if not Path(args.db).exists():
        print(json.dumps({"ok": False, "error": f"db not found: {args.db}"}))
        sys.exit(1)

    if args.retract:
        out = retract_fact(args.db, args.web_db, args.fact_id,
                           args.reason, args.actor, args.source_entity)
    else:
        if not args.undo_token:
            print(json.dumps({"ok": False, "error": "--undo-token required for --restore"}))
            sys.exit(1)
        out = restore_fact(args.db, args.web_db, args.fact_id, args.undo_token)

    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
