#!/usr/bin/env python3
"""prior_builder — pretrain the Work-State Model's per-user priors from the KG.

The dossier's load-bearing finding (.planning/athium-design.md §B/§F): idiographic
(per-user) models reach R²~80% where population models sit <5%, so per-user
baselining is the *precondition*, not a refinement. Everyone else has to
cold-start it; Sinain already maintains the personal knowledge graph, so we fit
the priors from history before any live label exists.

This reads the Oxigraph triplestore (knowledge-graph.db) and emits
workstate-prior.json: per-topic embedding centroids + recurrence + friction +
recency, plus a global return-rate and coarse activity base-rates. The live
estimator (sinain-core/src/workstate/) scores the current screen surface against
these priors via cosine similarity.

Interpretable retrieval + base-rate model — no GPU, no training loop. Run:
    python3 prior_builder.py [--memory-dir DIR] [--out FILE]
                             [--max-facts N] [--max-topics N]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

# KG store + embedding client live alongside this module.
from triplestore import TripleStore  # alias for RdfStore
import embed_client

# ── Heuristic vocabularies (domain-blind-ish; coarse, per dossier §B coarse ceiling)
# Friction is scored by EMBEDDING similarity to domain-general struggle concepts
# (language generalizes — a lawyer's "the filing was rejected again" matches; a
# keyword list only ever matched one app culture). Seeds are embedded once per
# build alongside the facts. The threshold is SELF-CALIBRATING: the corpus's own
# 90th-percentile similarity (idiographic baselining, dossier §F) — a fact
# counts as friction when it is more struggle-like than 90% of this user's
# facts, so the scale survives embedding-model changes and corpus mood shifts.
_STRUGGLE_SEEDS = [
    "stuck on a problem that keeps failing despite repeated attempts",
    "blocked and unable to make progress on the task",
    "an error or failure that had to be investigated and fixed",
    "something broke and required troubleshooting and rework",
    "a frustrating issue that kept coming back after being fixed",
    "abandoned an approach because it did not work",
]
_FRICTION_QUANTILE = 0.90
_FRICTION_COS_FLOOR = 0.15  # noise guard for tiny corpora
_ACTIVITY = {
    "coding", "debugging", "reading", "writing", "planning", "research",
    "researching", "reviewing", "review", "meeting", "communication", "design",
}
_STOP = {
    "user", "the", "and", "for", "with", "this", "that", "was", "were", "are",
    "their", "they", "from", "into", "within", "engaged", "focusing", "also",
    "while", "about", "which", "have", "has", "had", "via", "using",
}
# App / tool / infra / generic entity names — surfaces and scaffolding, NOT
# meaningful project-threads. Excluded from topics so the board shows real work,
# not "Chrome" / "Claude" / "project-directories".
_BLOCK = {
    # apps & tools
    "chrome", "google-chrome", "google-chrome-helper", "safari", "firefox",
    "brave", "arc", "opera", "zed", "intellij", "idea", "pycharm", "webstorm",
    "vscode", "vs-code", "xcode", "cursor", "terminal", "iterm", "iterm2",
    "warp", "finder", "preview", "spotlight", "activity-monitor", "slack",
    "telegram", "telegram-lite", "whatsapp", "discord", "signal", "messages",
    "facetime", "gmail", "outlook", "notion", "obsidian", "figma", "linear",
    "jira", "spotify", "keynote", "zoom", "google-meet", "chatgpt", "claude",
    "claude-code", "claude-api", "claude-tag", "claude-helper-tool",
    "claude-desktop", "claude-ai", "youtube", "google-translate", "google-drive",
    "google-docs", "google-document", "google-calendar",
    # generic / infra tokens
    "project", "projects", "project-directory", "project-directories",
    "project-folder", "ide-project-folder-space", "ide", "folder", "folders",
    "directory", "directories", "space", "workspace", "file", "files",
    "document", "documents", "doc", "docs", "tool", "tools", "helper", "api",
    "tag", "tags", "app", "apps", "application", "code", "lite", "desktop",
    "version", "window", "windows", "page", "item", "items", "thing", "stuff",
    "misc", "general", "untitled", "new", "temp", "setup", "config", "settings",
    "video", "progress", "device", "monitor", "activity", "google", "calendar",
    "meet", "drive", "translate", "mail", "community", "ultimate",
    # programming languages & sites — tools, not projects
    "python", "swift", "dart", "javascript", "typescript", "java", "rust",
    "go", "golang", "kotlin", "ruby", "php", "html", "css", "sql", "json",
    "yaml", "bash", "shell", "markdown", "md", "reddit", "twitter", "github",
    "gitlab", "stackoverflow", "medium", "linkedin", "local", "macos", "ios",
    "linux", "android",
}


def _blocked(name: str) -> bool:
    """True if an entity is an app/tool/generic — exact match, or every token is."""
    if name.lower() in _BLOCK:
        return True
    toks = [t for t in re.split(r"[-_\s]+", name.lower()) if len(t) >= 2]
    return bool(toks) and all(t in _BLOCK for t in toks)


def _cos(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def _unit(v: list[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / norm for x in v]


def _tokens(name: str) -> set[str]:
    """Distinctive tokens of an entity name (slug → words, len>=4, non-stop)."""
    raw = re.split(r"[-_\s]+", name.lower())
    return {t for t in raw if len(t) >= 4 and t not in _STOP}


def _parse_ts(values) -> "datetime | None":
    for v in values if isinstance(values, list) else [values]:
        if not v:
            continue
        try:
            return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except ValueError:
            continue
    return None


def _first(attrs: dict, key: str, default=""):
    v = attrs.get(key)
    if isinstance(v, list):
        return v[0] if v else default
    return v if v is not None else default


def _centroid(vecs: list[list[float]]) -> list[float]:
    """L2-normalized mean of unit vectors (cosine-ready)."""
    if not vecs:
        return []
    dim = len(vecs[0])
    acc = [0.0] * dim
    for v in vecs:
        for i in range(dim):
            acc[i] += v[i]
    norm = math.sqrt(sum(x * x for x in acc)) or 1.0
    return [x / norm for x in acc]


def build_prior(memory_dir: str, max_facts: int, max_topics: int) -> dict:
    db_path = str(Path(memory_dir).expanduser() / "knowledge-graph.db")
    if not Path(db_path).exists():
        raise SystemExit(f"no KG at {db_path}")

    # READ-ONLY: pretraining is a pure reader. A writable open takes the RocksDB
    # exclusive lock and, raced against a running core/kg_daemon, can misread
    # contention as corruption — never risk the live KG from this path.
    store = TripleStore(db_path, read_only=True)

    # 1) Load the top facts once (id, value, tags, timestamp, confidence).
    top = store.top_facts_by_confidence(max_facts)
    facts: list[dict] = []
    tag_freq: Counter = Counter()
    for fid, conf in top:
        attrs = store.entity(fid)
        value = _first(attrs, "value", "")
        if not value:
            continue
        tags = attrs.get("tag") or []
        if not isinstance(tags, list):
            tags = [tags]
        tags = {str(t).lower() for t in tags}
        ts = _parse_ts(attrs.get("last_reinforced")) or _parse_ts(
            attrs.get("occurred_at")
        )
        facts.append({"id": fid, "value": value, "tags": tags, "ts": ts,
                      "conf": float(conf)})
        tag_freq.update(tags)

    if not facts:
        raise SystemExit("KG has no facts with values — nothing to pretrain on")

    n_facts = len(facts)
    # Tags appearing in >40% of facts are non-distinctive (e.g. "user") — drop
    # them from topic matching so topics don't all collapse together.
    common = {t for t, c in tag_freq.items() if c > 0.4 * n_facts}

    # 2) Candidate topics = entity nodes, scored by distinctive-tag frequency.
    try:
        entities = store.entities_with_attr("name")
    except Exception:
        entities = []
    scored_entities = []
    for eid, name in entities:
        if _blocked(name):
            continue  # app / tool / generic — not a project-thread
        toks = _tokens(name) - common
        if not toks:
            continue
        score = sum(tag_freq.get(t, 0) for t in toks)
        if score > 0:
            scored_entities.append((eid, name, toks, score))
    scored_entities.sort(key=lambda x: x[3], reverse=True)

    # 3) For each candidate topic, gather member facts (distinctive token in tags).
    topics_raw = []
    for eid, name, toks, _score in scored_entities:
        members = [f for f in facts if f["tags"] & toks]
        if len(members) < 2:  # need recurrence to be a "topic"
            continue
        topics_raw.append({"id": eid, "label": name, "members": members,
                           "toks": toks})
        if len(topics_raw) >= max_topics:
            break

    # 4) Embed every member fact value once (dedup by id), then build centroids.
    uniq: dict[str, str] = {}
    for t in topics_raw:
        for f in t["members"]:
            uniq[f["id"]] = f["value"]
    ids = list(uniq.keys())
    texts = [uniq[i] for i in ids]
    print(f"[prior] embedding {len(texts)} fact values…", file=sys.stderr)
    # Struggle seeds ride along in the same embed call — the friction centroid
    # costs nothing extra.
    embs = embed_client.embed(texts + _STRUGGLE_SEEDS) if texts else []
    if embs is None:
        raise SystemExit("embedding unavailable (core /embed down and no local "
                         "sentence-transformers) — start core or pip install "
                         "sentence-transformers")
    emb_by_id = dict(zip(ids, (_unit(e) for e in embs[: len(ids)])))
    struggle_centroid = _centroid([_unit(e) for e in embs[len(ids):]])
    # Per-user friction threshold: the corpus's own p90 struggle-similarity.
    struggle_sims = {fid: _cos(v, struggle_centroid) for fid, v in emb_by_id.items()}
    ranked_sims = sorted(struggle_sims.values())
    friction_thr = max(
        _FRICTION_COS_FLOOR,
        ranked_sims[int(_FRICTION_QUANTILE * (len(ranked_sims) - 1))] if ranked_sims else 1.0,
    )
    print(f"[prior] friction threshold (corpus p90): {friction_thr:.3f}", file=sys.stderr)

    now = datetime.now(timezone.utc)
    topics_out = []
    for t in topics_raw:
        vecs = [emb_by_id[f["id"]] for f in t["members"] if f["id"] in emb_by_id]
        if not vecs:
            continue
        member_ts = [f["ts"] for f in t["members"] if f["ts"]]
        last_seen = max(member_ts) if member_ts else None
        distinct_days = len({ts.date() for ts in member_ts}) if member_ts else 0
        struggle = sum(
            1 for f in t["members"]
            if struggle_sims.get(f["id"], 0.0) >= friction_thr
        )
        topics_out.append({
            "id": t["id"],
            "label": t["label"],
            "centroid": _centroid(vecs),
            "recurrence": len(t["members"]),
            "distinctDays": distinct_days,
            "frictionPrior": round(struggle / len(t["members"]), 3),
            "lastSeen": last_seen.isoformat() if last_seen else None,
            "ageDays": (now - last_seen).days if last_seen else None,
            "sampleFacts": [f["value"][:160] for f in t["members"][:2]],
        })

    topics_out.sort(key=lambda x: x["recurrence"], reverse=True)

    # Merge near-duplicate topics (e.g. the audio-transcription-* family) by
    # centroid similarity — collapses KG synonym-entities into one thread so the
    # board shows one project, not six fragments of it.
    MERGE_COS = 0.85
    merged: list[dict] = []
    for t in topics_out:
        dup = next(
            (m for m in merged if t["centroid"] and m["centroid"]
             and _cos(t["centroid"], m["centroid"]) >= MERGE_COS),
            None,
        )
        if dup:
            dup["recurrence"] += t["recurrence"]
        else:
            merged.append(t)
    topics_out = merged

    # KEEP short project-name umbrellas ("sinain" — a thread's project label) but
    # drop noise: filename / mega-labels (>5 hyphen-tokens), and LONG descriptive
    # umbrellas (≥3 tokens that appear in most facts — doc titles / phrases like
    # "ai-powered-screen-context-overlay", not real projects). Apps like
    # "claude-ai" are handled by the blocklist above.
    UMBRELLA_FRAC = 0.35

    def _keep(t: dict) -> bool:
        toks = len(t["label"].split("-"))
        if toks > 5:
            return False
        if toks >= 3 and t["recurrence"] / max(1, n_facts) > UMBRELLA_FRAC:
            return False
        return True

    topics_out = [t for t in topics_out if _keep(t)]

    # 5) Global return-rate + coarse activity base-rates (calibration priors).
    all_ts = [f["ts"] for f in facts if f["ts"]]
    span_days = 1
    global_return = 0.0
    if all_ts:
        # Span in calendar days (inclusive) so active/span is a true fraction
        # ≤ 1 — `.days` alone truncates and lets distinct dates outrun it.
        span_days = (max(all_ts).date() - min(all_ts).date()).days + 1
        active_days = len({ts.date() for ts in all_ts})
        global_return = round(min(1.0, active_days / span_days), 3)

    activity_counts = Counter()
    for f in facts:
        for a in (f["tags"] & _ACTIVITY):
            activity_counts[a] += 1
    total_act = sum(activity_counts.values()) or 1
    activity_rates = {a: round(c / total_act, 3)
                      for a, c in activity_counts.most_common(8)}

    return {
        "version": 1,
        "builtAt": now.isoformat(),
        "memoryDir": str(Path(memory_dir).expanduser()),
        "factCount": n_facts,
        "spanDays": span_days,
        "globalReturnRate": global_return,
        "activityBaseRates": activity_rates,
        "topics": topics_out,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Pretrain WSM priors from the KG")
    default_mem = os.environ.get("SINAIN_MEMORY_DIR",
                                 str(Path.home() / ".sinain" / "memory"))
    ap.add_argument("--memory-dir", default=default_mem)
    ap.add_argument("--out", default=None,
                    help="output path (default: <memory-dir>/workstate-prior.json)")
    ap.add_argument("--max-facts", type=int, default=1500)
    ap.add_argument("--max-topics", type=int, default=48)
    args = ap.parse_args()

    prior = build_prior(args.memory_dir, args.max_facts, args.max_topics)
    out = args.out or str(Path(args.memory_dir).expanduser() / "workstate-prior.json")
    Path(out).write_text(json.dumps(prior, indent=2), encoding="utf-8")

    print(f"✓ wrote {out}")
    print(f"  facts={prior['factCount']}  topics={len(prior['topics'])}  "
          f"span={prior['spanDays']}d  returnRate={prior['globalReturnRate']}")
    print(f"  activities={prior['activityBaseRates']}")
    print("  top topics:")
    for t in prior["topics"][:12]:
        print(f"    {t['label']:<28} x{t['recurrence']:<3} "
              f"friction={t['frictionPrior']:<5} age={t['ageDays']}d")


if __name__ == "__main__":
    main()
