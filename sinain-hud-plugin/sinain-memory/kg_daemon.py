#!/usr/bin/env python3
"""sinain-kg — warm knowledge-graph retrieval daemon.

Holds the Oxigraph stores OPEN read-only with their FTS indices RESIDENT and
serves lean ROI retrieval over a Unix socket. Replaces the per-call
`graph_query.py` spawn that sinain-core's `queryKnowledgeFactsMulti` pays for
every ROI/clipboard enrichment.

Why this is a big win (measured on a 683k+294k-triple graph):
  - per-spawn `graph_query.py` ROI query: ~5-10s (Python + FTS index rebuild +
    hop-2 graph expansion + scaffolds). On a large store it brushes the 10s
    caller timeout — enrichment is effectively broken.
  - this daemon, lean profile (FTS + tag, RRF-fused; NO graph expansion /
    scaffolds), warm: ~0.3-0.7s. Quality is on par for ROI seeds (LLM-judge:
    lean 3.38 vs hybrid 3.50 / pairwise 4-4) — the daemon returns RRF
    CANDIDATES and sinain-core does its existing MiniLM rerank (Step 2), so no
    embedding model is loaded here.

Concurrency: SINAIN_KG_READONLY=1 makes every RdfStore open in this process
read-only — including the ones graph_query opens internally — so reads do NOT
take the RocksDB write lock and coexist with the distillation writer. Each
store reopens its read-only snapshot when the DB changes (mtime) or the
snapshot ages out (bounded staleness, fine for enrichment). Retrieval is
serialized per store (RdfStore / its FTS index are not thread-safe).

Protocol — one JSON request per line over the socket, one JSON line back:
  {"op":"ping","dbs":[path,...]}
  {"op":"roi","query":"...","entities":[...],"dbs":[path,...],"max_facts":16}
      -> {"facts":[ {value,entity_id,kind,...}, ... ],"ms":N}   (RRF candidates)
  {"op":"refresh"}   -> drop all snapshots; reopen lazily

Env: SINAIN_KG_SOCK (default /tmp/sinain-kg.sock),
     SINAIN_KG_REFRESH_S (snapshot max age before reopen, default 60).
"""
from __future__ import annotations

import json
import os
import socket
import sys
import threading
import time
from pathlib import Path

# Read-only for the WHOLE process before any store opens (incl. graph_query's).
os.environ.setdefault("SINAIN_KG_READONLY", "1")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import graph_query as gq  # noqa: E402
from rdf_store import RdfStore  # noqa: E402

SOCK_PATH = os.environ.get("SINAIN_KG_SOCK", "/tmp/sinain-kg.sock")
REFRESH_S = float(os.environ.get("SINAIN_KG_REFRESH_S", "60"))


class WarmStore:
    """One read-only store kept warm (FTS prebuilt), reopened when the DB
    changes on disk or the snapshot ages out. Queries reuse the module-cached
    RdfStore that graph_query's channel functions open, so they hit this warm
    FTS index rather than rebuilding it per call."""

    def __init__(self, db_path: str):
        self.db_path = db_path
        self.lock = threading.Lock()
        self._open()

    def _open(self) -> None:
        self.store = RdfStore(self.db_path)   # read-only (env); module-cached
        self.store._ensure_fts()              # build inverted index once
        self.opened_at = time.monotonic()
        self.mtime = self._mtime()

    def _mtime(self) -> float:
        try:
            return os.path.getmtime(self.db_path)
        except OSError:
            return 0.0

    def _maybe_refresh(self) -> None:
        if (time.monotonic() - self.opened_at) > REFRESH_S or self._mtime() != self.mtime:
            try:
                self.store.close()  # pops the module cache so _open reopens fresh
            except Exception:
                pass
            self._open()

    def query(self, query: str, entities: list[str], n: int) -> list[dict]:
        with self.lock:
            self._maybe_refresh()
            fts = gq.query_facts_fts(self.db_path, query, n) if query.strip() else []
            tag = gq.query_facts_by_entities(self.db_path, entities, n) if entities else []
        return _rrf([fts, tag])

    def fact_count(self) -> int:
        try:
            return len(self.store._store)
        except Exception:
            return -1


_STORES: dict[str, WarmStore] = {}
_STORES_LOCK = threading.Lock()


def _warm(db_path: str) -> "WarmStore | None":
    if not Path(db_path).exists():
        return None
    with _STORES_LOCK:
        ws = _STORES.get(db_path)
        if ws is None:
            ws = WarmStore(db_path)
            _STORES[db_path] = ws
        return ws


def _rrf(lists, k: int = 60):
    scores: dict[str, float] = {}
    keep: dict[str, dict] = {}
    for lst in lists:
        for rank, f in enumerate(lst):
            fid = f.get("fact_id") or f.get("entity_id") or f"{f.get('about','')}|{str(f.get('value',''))[:48]}"
            scores[fid] = scores.get(fid, 0.0) + 1.0 / (k + rank + 1)
            keep.setdefault(fid, f)
    return [keep[i] for i in sorted(scores, key=lambda x: -scores[x])]


def op_roi(req: dict) -> dict:
    query = req.get("query", "") or ""
    entities = req.get("entities", []) or []
    dbs = req.get("dbs") or []
    n = int(req.get("max_facts", 16))
    t = time.time()
    per_db = []
    for db in dbs:
        ws = _warm(db)
        if ws is not None:
            per_db.append(ws.query(query, entities, n))
    facts = _rrf(per_db)[: n * 2]  # candidates; sinain-core reranks + filters
    return {"facts": facts, "count": len(facts), "ms": round((time.time() - t) * 1000, 1)}


def op_refresh(_req: dict) -> dict:
    with _STORES_LOCK:
        for ws in _STORES.values():
            with ws.lock:
                try:
                    ws.store.close()
                except Exception:
                    pass
                ws._open()
    return {"ok": True}


def op_ping(req: dict) -> dict:
    dbs = req.get("dbs") or []
    return {"ok": True, "stores": {db: (_warm(db).fact_count() if _warm(db) else None) for db in dbs}}


OPS = {"ping": op_ping, "roi": op_roi, "refresh": op_refresh}


def _serve(conn: socket.socket) -> None:
    with conn:
        buf = b""
        while b"\n" not in buf:
            chunk = conn.recv(65536)
            if not chunk:
                return
            buf += chunk
        try:
            req = json.loads(buf.split(b"\n", 1)[0].decode())
            fn = OPS.get(req.get("op"))
            resp = fn(req) if fn else {"error": f"unknown op {req.get('op')!r}"}
        except Exception as e:  # noqa: BLE001
            resp = {"error": f"{type(e).__name__}: {e}"}
        try:
            conn.sendall((json.dumps(resp) + "\n").encode())
        except OSError:
            pass


def main() -> None:
    if os.path.exists(SOCK_PATH):
        os.unlink(SOCK_PATH)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(SOCK_PATH)
    srv.listen(64)
    print(f"[sinain-kg] ready · {SOCK_PATH} (refresh={REFRESH_S:.0f}s)", flush=True)
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=_serve, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
