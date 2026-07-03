#!/usr/bin/env python3
"""sinain-memoryd — resident memory worker (DESIGN-MEMORY-V2.md P1).

Supersedes kg_daemon (serves its full protocol on the same socket, so
sinain-core's ROI client works unchanged) and adds the T1 episodic tier:

  {"op":"ingest","items":[{source,text,ts,channel}...],"kind":"segment|session",
   "context_id":"...", "layers":[...]}
      -> {"ok":true,"episodes":N}       (deterministic, zero LLM, instant)
  {"op":"episodes","since":"ISO","until":"ISO","query":"...","limit":N,
   "include_text":false}
      -> {"episodes":[{id,context_id,t_start,t_end,kind,summary,entities,
                       n_items,text?}...]}
  {"op":"context_block","query":"...","max_chars":N}
      -> {"block":"...", "ms":N}
  {"op":"health"} -> {"ok":true,"episodes":N,"kg_stores":{...}}

Ownership contract (§3.1/§3.8): memoryd is the ONLY writer of the episode
log (append-only JSONL — every append is its own journal entry, so kill -9
loses at most one partial line, skipped on load). Oxigraph stays READ-ONLY
in this process (SINAIN_KG_READONLY=1 inherited from kg_daemon import); the
legacy distillation pipeline remains the T2 writer during the dual-write
transition. Text arriving in `ingest` must already carry the on-disk privacy
level (sinain-core redacts before sending — same policy as
pending-session.json).

Env: SINAIN_KG_SOCK (default /tmp/sinain-kg.sock — takes over the kg socket),
     SINAIN_MEMORY_DIR (default ~/.sinain/memory; episodes at episodes.jsonl).
"""
from __future__ import annotations

try:
    import setproctitle as _setproctitle
    _setproctitle.setproctitle("sinain-memoryd")
except Exception:
    pass

import json
import os
import socket
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kg_daemon as kd  # noqa: E402 — sets SINAIN_KG_READONLY for the process
from memory_v2 import ingest_sessions
from memory_v2.store import Episode, EpisodeStore
from memory_v2.retrieve import build_context_block, search_episodes
from memory_v2.compact import (
    DEFAULT_MODEL, DOMAINS, Fact, _extract_people, _extract_session,
    _fact_id, consolidate, narration_gate,
)

MEMORY_DIR = Path(os.path.expanduser(os.environ.get("SINAIN_MEMORY_DIR", "~/.sinain/memory")))
EPISODES_PATH = MEMORY_DIR / "episodes.jsonl"
FACTS_PATH = MEMORY_DIR / "facts-v2.json"
# Live compaction cadence: check every 60s, run when >=MIN_SEGS uncompacted
# segments exist and >=INTERVAL since the last run. Understanding is a
# background job — never on the ingest path (DESIGN-MEMORY-V2 §3.6).
COMPACT_INTERVAL_S = float(os.environ.get("SINAIN_V2_COMPACT_INTERVAL_S", "600"))
COMPACT_MIN_SEGS = int(os.environ.get("SINAIN_V2_COMPACT_MIN_SEGS", "3"))

_STORE_LOCK = threading.Lock()
_STORE: EpisodeStore | None = None

# ── T2 derived index: facts compacted from episodes (rebuildable) ──────────
_FACTS_LOCK = threading.Lock()
_FACTS: list = []
_ALIASES: dict = {}
_COMPACTED: set = set()  # segment episode ids already compacted


def _load_facts() -> None:
    global _FACTS, _ALIASES, _COMPACTED
    try:
        data = json.loads(FACTS_PATH.read_text(encoding="utf-8"))
        _FACTS = [Fact(**f) for f in data.get("facts", [])]
        _ALIASES = data.get("aliases", {})
        _COMPACTED = set(data.get("compacted_ids", []))
        print(f"[memoryd] facts index: {len(_FACTS)} facts, "
              f"{len(_COMPACTED)} segments compacted", flush=True)
    except (OSError, ValueError, TypeError):
        _FACTS, _ALIASES, _COMPACTED = [], {}, set()


def _save_facts() -> None:
    tmp = FACTS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps({
        "facts": [f.to_dict() for f in _FACTS],
        "aliases": _ALIASES,
        "compacted_ids": sorted(_COMPACTED),
    }, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, FACTS_PATH)  # atomic — crash mid-write never corrupts


def _compact_cycle() -> None:
    """One background compaction pass over uncompacted segment windows.

    The measured v2 write path (durability rubric + people pass + narration
    gate + deterministic consolidation) applied to the LIVE store. Facts are
    a derived index: any failure is fail-open and re-derivable from episodes.
    """
    from memory_v2.compact import resolve_aliases
    with _STORE_LOCK:
        segs = [e for e in _store().episodes
                if e.kind == "segment" and e.text and e.id not in _COMPACTED]
    if len(segs) < COMPACT_MIN_SEGS:
        return
    # Group segments by their ingest batch (id prefix ep-<sid>-NNN).
    from collections import defaultdict
    batches: dict[str, list] = defaultdict(list)
    for e in segs:
        batches[e.id.rsplit("-", 1)[0]].append(e)
    model = DEFAULT_MODEL
    new_facts: list = []
    people_records: list[dict] = []
    done_ids: list[str] = []
    for _sid, eps in sorted(batches.items(), key=lambda kv: kv[1][0].t_start):
        text = "\n".join(e.text for e in eps)
        date = (eps[0].t_start or "")[:10]
        ep_ids = [e.id for e in eps]
        layers = sorted({l for e in eps for l in e.layers})
        data = _extract_session(text, date, model)
        for rec in _extract_people(text, date, model):
            name = str(rec.get("name", "")).strip()
            if not name:
                continue
            people_records.append(rec)
            for at in rec.get("attributes") or []:
                a, v = str(at.get("attribute", "")).strip(), str(at.get("value", "")).strip()
                if a and v:
                    new_facts.append(Fact(
                        id=_fact_id("people", name, f"{a}: {v}"), domain="people",
                        subject=name, fact=f"{a}: {v}",
                        valid_at=str(at.get("date", "") or date)[:10],
                        layers=layers, episode_ids=ep_ids, meta={"pass": "people"}))
            for rel in rec.get("relationships") or []:
                o, rl = str(rel.get("person", "")).strip(), str(rel.get("relation", "")).strip()
                if o and rl:
                    new_facts.append(Fact(
                        id=_fact_id("people", name, f"{rl}: {o}"), domain="people",
                        subject=name, fact=f"{rl}: {o}", valid_at=date,
                        layers=layers, episode_ids=ep_ids, meta={"pass": "people"}))
        for rf in (data.get("facts") or []):
            if not isinstance(rf, dict):
                continue
            dom = str(rf.get("domain", "")).strip().lower()
            subj = str(rf.get("subject", "")).strip()
            ftext = str(rf.get("fact", "")).strip()
            if dom not in DOMAINS or not subj or len(ftext) < 8:
                continue
            new_facts.append(Fact(
                id=_fact_id(dom, subj, ftext), domain=dom, subject=subj,
                fact=ftext, valid_at=str(rf.get("date", "") or date)[:10],
                layers=layers, episode_ids=ep_ids, meta={}))
        # Tier-1 summary onto the batch's session node
        summ = str(data.get("summary") or "").strip()
        if summ:
            with _STORE_LOCK:
                for e in _store().episodes:
                    if e.id == f"{_sid}-session":
                        e.summary = summ
        done_ids.extend(ep_ids)
    if not done_ids:
        return
    with _FACTS_LOCK:
        global _FACTS, _ALIASES
        aliases = resolve_aliases(people_records)
        _ALIASES.update(aliases)
        for f in new_facts:
            c = _ALIASES.get(f.subject.strip().lower())
            if c:
                f.subject = c
                f.id = _fact_id(f.domain, c, f.fact)
        merged = consolidate(_FACTS + new_facts)
        merged, rejected = narration_gate(merged)
        _FACTS = merged
        _COMPACTED.update(done_ids)
        _save_facts()
    print(f"[memoryd] compacted {len(done_ids)} segments -> "
          f"+{len(new_facts)} raw, {len(_FACTS)} total facts "
          f"({rejected} narration-rejected)", flush=True)


def _compaction_loop() -> None:
    if os.environ.get("SINAIN_V2_COMPACT_LIVE", "1") == "0":
        print("[memoryd] live compaction disabled (SINAIN_V2_COMPACT_LIVE=0)", flush=True)
        return
    if not os.environ.get("OPENROUTER_API_KEY"):
        print("[memoryd] no OPENROUTER_API_KEY — live compaction idle "
              "(episodes still fully served)", flush=True)
        return
    last = 0.0
    while True:
        time.sleep(60)
        if time.monotonic() - last < COMPACT_INTERVAL_S:
            continue
        try:
            _compact_cycle()
        except Exception as e:  # noqa: BLE001 — derived index, fail-open
            print(f"[memoryd] compaction cycle failed (fail-open): {str(e)[:120]}",
                  file=sys.stderr, flush=True)
        last = time.monotonic()


def _store() -> EpisodeStore:
    global _STORE
    if _STORE is None:
        _STORE = EpisodeStore(EPISODES_PATH)
        print(f"[memoryd] episode store: {len(_STORE)} episodes ({EPISODES_PATH})", flush=True)
    return _STORE


def op_ingest(req: dict) -> dict:
    # Single-episode form — WSM breakpoint/return events (§3.8: the engine's
    # frozen snapshots become attested episodes; the engine keeps no durable
    # state of its own). {"op":"ingest","episode":{kind,context_id,text,ts,...}}
    ep = req.get("episode")
    if isinstance(ep, dict):
        import hashlib
        kind = str(ep.get("kind") or "breakpoint")
        ts = str(ep.get("ts") or "")
        ctx = str(ep.get("context_id") or "live")
        with _STORE_LOCK:
            st = _store()
            st.append(Episode(
                id="ep-" + hashlib.sha256(f"{ctx}|{ts}|{kind}".encode()).hexdigest()[:12],
                context_id=ctx, t_start=ts, t_end=str(ep.get("t_end") or ts),
                kind=kind, source=str(ep.get("source") or "agent"),
                layers=[l for l in (ep.get("layers") or []) if isinstance(l, str)],
                text=str(ep.get("text") or "")[:6000],
                summary=str(ep.get("summary") or "")[:500],
                entities=[str(e) for e in (ep.get("entities") or [])][:12],
                meta=ep.get("meta") if isinstance(ep.get("meta"), dict) else {},
            ))
            return {"ok": True, "episodes": 1, "total": len(st)}

    items = req.get("items") or []
    items = [i for i in items if isinstance(i, dict) and str(i.get("text", "")).strip()]
    if not items:
        return {"ok": True, "episodes": 0}
    context_id = str(req.get("context_id") or "live")
    layers = [l for l in (req.get("layers") or []) if isinstance(l, str)]
    with _STORE_LOCK:
        st = _store()
        before = len(st)
        ingest_sessions([items], context_id=context_id, layers=layers, store=st)
        return {"ok": True, "episodes": len(st) - before, "total": len(st)}


def op_episodes(req: dict) -> dict:
    since = req.get("since") or None
    until = req.get("until") or None
    query = (req.get("query") or "").strip()
    limit = max(1, min(int(req.get("limit", 20)), 200))
    include_text = bool(req.get("include_text"))
    t = time.time()
    with _STORE_LOCK:
        st = _store()
        if query:
            eps = [e for _s, e in search_episodes(st, query, k=limit)]
            # search covers segments; constrain to window if given
            eps = [e for e in eps
                   if (not since or e.t_end >= since) and (not until or e.t_start <= until)]
        else:
            eps = st.by_time(since, until)
        eps = sorted(eps, key=lambda e: e.t_start)[-limit:]
        out = []
        for e in eps:
            row = {"id": e.id, "context_id": e.context_id, "t_start": e.t_start,
                   "t_end": e.t_end, "kind": e.kind, "summary": e.summary,
                   "entities": e.entities[:10], "n_items": e.meta.get("n_items")}
            if include_text:
                row["text"] = e.text[:4000]
            out.append(row)
    return {"episodes": out, "count": len(out), "ms": round((time.time() - t) * 1000, 1)}


def op_context_block(req: dict) -> dict:
    query = (req.get("query") or "").strip()
    max_chars = max(500, min(int(req.get("max_chars", 6000)), 20000))
    t = time.time()
    with _FACTS_LOCK:
        facts, aliases = list(_FACTS), dict(_ALIASES)
    with _STORE_LOCK:
        block = build_context_block(_store(), query, facts=facts,
                                    aliases=aliases, max_chars=max_chars)
    return {"block": block, "facts_indexed": len(facts),
            "ms": round((time.time() - t) * 1000, 1)}


def op_health(req: dict) -> dict:
    with _STORE_LOCK:
        n = len(_store())
    base = kd.op_ping(req)
    return {"ok": True, "episodes": n, "facts": len(_FACTS),
            "segments_compacted": len(_COMPACTED),
            "kg_stores": base.get("stores", {})}


OPS = {**kd.OPS, "ingest": op_ingest, "episodes": op_episodes,
       "context_block": op_context_block, "health": op_health}


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
            conn.sendall((json.dumps(resp, ensure_ascii=False) + "\n").encode())
        except OSError:
            pass


def main() -> None:
    sock_path = kd.SOCK_PATH
    if os.path.exists(sock_path):
        os.unlink(sock_path)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(sock_path)
    srv.listen(64)
    _store()  # load episodes before accepting traffic
    _load_facts()
    threading.Thread(target=_compaction_loop, daemon=True,
                     name="v2-compaction").start()
    print(f"[memoryd] ready · {sock_path}", flush=True)
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=_serve, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
