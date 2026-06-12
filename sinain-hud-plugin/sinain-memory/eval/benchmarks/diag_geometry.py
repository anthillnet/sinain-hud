#!/usr/bin/env python3
"""diag_geometry.py — retrieval-geometry diagnostic (.planning/phases/retrieval-geometry/00-PLAN.md).

Read-only (no LLM): for each benchmark question, runs the production retrieval
(query_facts_hybrid), embeds the returned evidence (facts + raw excerpts) + query
+ gold, and computes embedding-shape metrics that classify retrieval failures into
deterministic labels:

  dense_neighborhood_collapse | bridge_needed | temporal_collision
  gold_isolated_or_absent     | qa_reasoning_bound

It then runs four read-only counterfactuals over the returned evidence and reports,
per question, which one would surface gold-support keywords the current prompt misses:

  A  MMR (lambda sweep 0.55/0.65/0.75)
  B  cluster cap (<=2 per 0.85-cluster, fill by rank)
  C  two-route retrieval (deterministic keyword partition -> re-retrieve -> merge)
  D  temporal-collision detector (high-sim conflicting-value pairs; suppression preview)

Finally it emits a `recommended_next_probe` per question using the plan's decision rules.

qid -> store hash resolution: a static HASHMAP (18-q stable cloud run) is the default;
pass a runner log to parse the mapping for any other subset (works for 36-q etc).

Usage:
  python3 -m eval.benchmarks.diag_geometry <results_dir> [run_log] [qid ...]
Emits <results_dir>/geometry_report.jsonl and geometry_report.md.
"""
import json
import math
import os
import re
import sys

import numpy as np

STOP = set("the a an of to in on for and or is are was were be been i you he she it we they me my "
           "your with at by from this that what when where how many much who which did do does have "
           "has had will would can could about into out up down".split())

# Question terms that signal a latest/historical-state intent (temporal_collision gate).
TEMPORAL_Q = set("current currently now latest last recent recently still update updated updates changed "
                 "change new newly anymore today these days nowadays former previously originally".split())

# Static qid -> store hash for the 18-q stable cloud run (kept in sync with diag_prompt.HASHMAP).
HASHMAP = {
    "6a1eabeb": "5f46a05de12589a4", "6aeb4375": "c91e464dc5e426a1", "830ce83f": "c84cdf27b0fee280",
    "0a995998": "9a412228a23e075c", "6d550036": "96ad954260a3e9f4", "gpt4_59c863d7": "9b70561f1aa22f96",
    "7161e7e2": "1cfd46292e3291d9", "c4f10528": "ba74574075b29b0f", "89527b6b": "de31f5e20489597f",
    "8a2466db": "f80267e722d1e51d", "06878be2": "48c5055736e621d1", "75832dbd": "4bb8236cf0a41b48",
    "e47becba": "f98f91aa7a13a3de", "118b2229": "6da2e83365fa5123", "51a45a95": "135abdb49ff3f2c5",
    "gpt4_59149c77": "67c35ab121496ae5", "gpt4_f49edff3": "c75b28a407e5ad28", "71017276": "6b1097b0d30fb25d",
}


def _kw(s):
    return [w for w in re.findall(r"[a-z0-9]+", (s or "").lower()) if w not in STOP and len(w) > 2]


def _kwset(s):
    return set(_kw(s))


# Value tokens that carry "state" — numbers, dates, money. Used by the collision detector.
_NUM_RE = re.compile(r"\b\d[\d,./:-]*\b")


def _value_tokens(s):
    """Numeric / date-ish tokens in a fact value — the things that change over time."""
    return set(m.group(0).strip(".,") for m in _NUM_RE.finditer((s or "").lower()))


def _parse_hashmap(log_path):
    """qid -> store hash, from runner log lines:
      [N/NN] <qid> [category]
      [ingest] raw_store: wrote N chunk(s) sidecar for <HASH>.db"""
    hm, cur = {}, None
    for ln in open(log_path, errors="ignore"):
        m = re.match(r"\[\d+/\d+\]\s+(\S+)\s+\[", ln)
        if m:
            cur = m.group(1)
        m2 = re.search(r"sidecar for ([0-9a-f]{12,})\.db", ln)
        if m2 and cur and cur not in hm:
            hm[cur] = m2.group(1)
    return hm


def _cos_matrix(mat):
    n = mat / (np.linalg.norm(mat, axis=1, keepdims=True) + 1e-9)
    return n @ n.T


def _components(sim, thr):
    """Connected components at similarity >= thr. Returns (comp_of, comps).
    comp_of[i] = component id of item i; comps = list of member-index lists."""
    n = sim.shape[0]
    comp_of = [-1] * n
    comps = []
    for i in range(n):
        if comp_of[i] != -1:
            continue
        cid = len(comps)
        stack, members = [i], []
        comp_of[i] = cid
        while stack:
            j = stack.pop()
            members.append(j)
            for k in range(n):
                if comp_of[k] == -1 and sim[j, k] >= thr:
                    comp_of[k] = cid
                    stack.append(k)
        comps.append(members)
    return comp_of, comps


def _entropy(comps, n):
    """Normalized Shannon entropy of cluster-size distribution (0=collapsed, 1=even)."""
    if n == 0 or len(comps) <= 1:
        return 0.0
    h = 0.0
    for c in comps:
        p = len(c) / n
        if p > 0:
            h -= p * math.log(p)
    return round(h / math.log(len(comps)), 3)


def _qsims(qv, mat):
    return (mat @ qv) / (np.linalg.norm(mat, axis=1) * (np.linalg.norm(qv) + 1e-9) + 1e-9)


def _mmr(qv, mat, k, lam):
    """Maximal-marginal-relevance selection over evidence rows. Returns selected indices."""
    sims = _qsims(qv, mat)
    csim = _cos_matrix(mat)
    sel, cand = [], list(range(mat.shape[0]))
    while cand and len(sel) < k:
        best, bi = -1e9, None
        for i in cand:
            div = max((csim[i, j] for j in sel), default=0.0)
            sc = lam * sims[i] - (1 - lam) * div
            if sc > best:
                best, bi = sc, i
        sel.append(bi)
        cand.remove(bi)
    return sel


def _cluster_cap(comps, ranks, cap, k):
    """Counterfactual B: <= `cap` items per 0.85-cluster, clusters ordered by best (lowest) rank,
    fill any remaining slots by global rank. `ranks[i]` is the original retrieval rank of item i."""
    order = sorted(range(len(comps)), key=lambda c: min(ranks[i] for i in comps[c]))
    sel = []
    for c in order:
        for m in sorted(comps[c], key=lambda i: ranks[i])[:cap]:
            if len(sel) < k:
                sel.append(m)
    if len(sel) < k:
        for i in sorted(range(len(ranks)), key=lambda i: ranks[i]):
            if i not in sel and len(sel) < k:
                sel.append(i)
    return sel[:k]


def _route_terms(question):
    """Counterfactual C helper: deterministic two-way partition of query keywords into routes.
    No LLM. Split on a connective if present (recommend/suggest/based on/given/since/because/for),
    else split the keyword list in half by position."""
    ql = (question or "").lower()
    connectives = [" based on ", " given ", " since ", " because ", " recommend", " suggest",
                   " for the ", " considering ", " that i ", " did i "]
    for c in connectives:
        idx = ql.find(c)
        if idx > 0:
            return _kw(ql[:idx]), _kw(ql[idx:])
    kws = _kw(ql)
    if len(kws) < 4:
        return kws, kws
    mid = len(kws) // 2
    return kws[:mid], kws[mid:]


def _covers_gold(text, gk, thr=0.6):
    return bool(gk) and sum(1 for k in gk if k in text) / len(gk) >= thr


def _recommend(labels, gold_in_prompt, mmr_adds, cap_adds, route_adds):
    """Plan decision-rule precedence -> a single next-probe recommendation."""
    if "temporal_collision" in labels:
        return "bitemporal_supersession (T1-SUPERSEDE)"
    if "gold_unmeasurable_proxy" in labels:
        return "derived_answer (count/number): proxy blind -> inspect QA synthesis"
    if not gold_in_prompt and "bridge_needed" in labels and route_adds:
        return "two_route_retrieval (T1-RECON / T2-LINKS)"
    if not gold_in_prompt and "dense_neighborhood_collapse" in labels and (mmr_adds or cap_adds):
        return "diversity_retrieval (MMR / cluster-cap, T1-COUNT)"
    if not gold_in_prompt and "gold_isolated_or_absent" in labels:
        return "entity_centric_expansion / raw_neighbor (T1-RECON)"
    if gold_in_prompt:
        return "qa_determinism / task_specific_synthesis (not retrieval)"
    return "inspect_manually"


def main():
    results_dir = sys.argv[1]
    rest = sys.argv[2:]
    log_path = None
    if rest and os.path.isfile(rest[0]):
        log_path, rest = rest[0], rest[1:]
    want = set(rest)

    det = {r["id"]: r for r in json.load(open(f"{results_dir}/longmemeval_results.json"))["details"]}
    hm = dict(HASHMAP)
    if log_path:
        hm.update(_parse_hashmap(log_path))

    sys.path.insert(0, ".")
    sys.path.insert(0, "../..")
    from graph_query import query_facts_hybrid, format_facts_compact
    from eval.benchmarks.config import MAX_FACTS_PER_QUERY
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer("all-MiniLM-L6-v2")
    STORES = "eval/benchmarks/data/longmemeval/stores"

    def emb(texts):
        return np.array(model.encode(texts, show_progress_bar=False), dtype=float)

    out = open(f"{results_dir}/geometry_report.jsonl", "w")
    md = open(f"{results_dir}/geometry_report.md", "w")
    md.write("| qid | cat | lab | gold_in_prompt | n_ev | clu@.85 | top_share | redund@.85 | "
             "entropy | q_top1 | q_gold | mmr | cap | route | labels | next_probe |\n"
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n")

    for qid, r in det.items():
        if want and qid not in want:
            continue
        h = hm.get(qid)
        if not h:
            continue
        db = f"{STORES}/{h}.db"
        if not os.path.exists(db):
            continue
        q = r["question"]
        gold = r["gold_answer"]
        lab = r["answers"]["sinain-memory"]["paper_label"]
        facts = query_facts_hybrid(db, q, max_facts=MAX_FACTS_PER_QUERY)
        prompt = format_facts_compact(facts, max_chars=2000).lower()
        ev = [(f.get("value", "") or "") for f in facts if (f.get("value", "") or "").strip()]
        is_raw = [bool(f.get("source") == "raw-excerpt" or f.get("entity") == "excerpt")
                  for f in facts if (f.get("value", "") or "").strip()]
        n_raw = sum(is_raw)
        gk = _kw(gold)
        # Numeric / very-short gold (count & derived-answer questions, e.g. "3", "two")
        # has no keyword the proxy can match -> gold_in_prompt is meaningless for it.
        gold_measurable = bool(gk)
        gold_in_prompt = _covers_gold(prompt, gk)
        geom, labels = {}, []
        mmr_adds = cap_adds = route_adds = temporal_pairs = False
        cf = {}

        if len(ev) >= 2:
            mat = emb(ev)
            qv = emb([q])[0]
            sim = _cos_matrix(mat)
            iu = np.triu_indices(len(ev), 1)
            pair = sim[iu]
            geom["mean_pairwise_sim"] = round(float(pair.mean()), 3)
            geom["max_pairwise_sim"] = round(float(pair.max()), 3)
            ranks = list(range(len(ev)))  # ev already in production retrieval order

            comps_085 = None
            for t in (0.78, 0.85, 0.92):
                comp_of, comps = _components(sim, t)
                tag = int(round(t * 100))
                geom[f"cluster_count_{tag}"] = len(comps)
                geom[f"top_cluster_share_{tag}"] = round(max(len(c) for c in comps) / len(ev), 3)
                geom[f"redundancy_ratio_{tag}"] = round(float((pair >= t).mean()), 3)
                if t == 0.85:
                    comps_085 = comps
                    geom["cluster_entropy_085"] = _entropy(comps, len(ev))
            # back-compat aliases used by earlier consumers
            geom["top_cluster_share_085"] = geom["top_cluster_share_85"]
            geom["redundancy_ratio_085"] = geom["redundancy_ratio_85"]

            qsims = _qsims(qv, mat)
            geom["query_to_top1_sim"] = round(float(qsims.max()), 3)
            gv = None
            if gk:
                gv = emb([gold])[0]
                geom["query_to_gold_sim"] = round(
                    float(np.dot(qv, gv) / (np.linalg.norm(qv) * np.linalg.norm(gv) + 1e-9)), 3)

            # ---- Counterfactual A: MMR lambda sweep ----
            mmr_hits = {}
            for lam in (0.55, 0.65, 0.75):
                idx = _mmr(qv, mat, min(8, len(ev)), lam)
                txt = " ".join(ev[i] for i in idx).lower()
                hit = (not gold_in_prompt) and _covers_gold(txt, gk)
                mmr_hits[f"lam_{int(lam*100)}"] = hit
            mmr_adds = any(mmr_hits.values())
            cf["mmr"] = {"adds_gold": mmr_adds, "by_lambda": mmr_hits}

            # ---- Counterfactual B: cluster cap ----
            cap_idx = _cluster_cap(comps_085, ranks, cap=2, k=min(8, len(ev)))
            cap_txt = " ".join(ev[i] for i in cap_idx).lower()
            cap_adds = (not gold_in_prompt) and _covers_gold(cap_txt, gk)
            base_top = set(range(min(8, len(ev))))
            cf["cluster_cap"] = {
                "adds_gold": cap_adds,
                "overlap_at_8": round(len(base_top & set(cap_idx)) / max(1, len(base_top)), 3),
                "distinct_clusters": len({comp for comp in
                                          (_components(sim, 0.85)[0][i] for i in cap_idx)}),
            }

            # ---- Counterfactual C: two-route retrieval (re-retrieves; deterministic split) ----
            ra, rb = _route_terms(q)
            route_txt = ""
            try:
                half = max(4, MAX_FACTS_PER_QUERY // 2)
                fa = query_facts_hybrid(db, " ".join(ra), max_facts=half) if ra else []
                fb = query_facts_hybrid(db, " ".join(rb), max_facts=half) if rb else []
                route_vals = [(f.get("value", "") or "") for f in (fa + fb)]
                route_txt = " ".join(route_vals).lower()
            except Exception as e:  # retrieval on a degenerate sub-query — skip, don't crash the q
                cf["two_route_error"] = str(e)[:120]
            route_adds = (not gold_in_prompt) and _covers_gold(route_txt, gk)
            cf["two_route"] = {"adds_gold": route_adds,
                               "route_a": ra[:6], "route_b": rb[:6]}

            # ---- Counterfactual D: temporal-collision detector (suppression preview) ----
            collisions, cat_collisions = [], []
            for a in range(len(ev)):
                for b in range(a + 1, len(ev)):
                    if sim[a, b] < 0.85:
                        continue
                    ka, kb = _kwset(ev[a]), _kwset(ev[b])
                    subj_overlap = ka & kb
                    if not subj_overlap:
                        continue
                    va, vb = _value_tokens(ev[a]), _value_tokens(ev[b])
                    if va and vb and va != vb:
                        # same subject neighborhood, conflicting NUMERIC state -> collision
                        collisions.append((a, b))
                    elif sim[a, b] >= 0.88 and len(subj_overlap) >= 2 and (ka ^ kb):
                        # high-sim same-subject pair, no numbers, but differing content tokens
                        # -> candidate CATEGORICAL supersession (city->suburbs, brand A->B).
                        # Surfaced for human review only; too fuzzy to auto-label.
                        cat_collisions.append((a, b))
            temporal_pairs = len(collisions) > 0
            q_is_temporal = bool(_kwset(q) & TEMPORAL_Q)
            cf["temporal"] = {"collision_pairs": len(collisions),
                              "categorical_pairs": len(cat_collisions),
                              "question_is_state": q_is_temporal,
                              # which (later-ranked) item each pair would suppress under recency
                              "suppress_candidates": sorted({max(a, b) for a, b in collisions})[:6]}

            # ---- deterministic labels ----
            if geom["top_cluster_share_85"] >= 0.50 or geom["redundancy_ratio_85"] >= 0.30 or mmr_adds or cap_adds:
                labels.append("dense_neighborhood_collapse")
            if temporal_pairs and q_is_temporal:
                labels.append("temporal_collision")
            if (not gold_in_prompt) and route_adds and geom["cluster_count_85"] >= 2:
                labels.append("bridge_needed")
            if gold_in_prompt:
                labels.append("qa_reasoning_bound")
            elif not gold_measurable:
                labels.append("gold_unmeasurable_proxy")
            else:
                labels.append("gold_isolated_or_absent")

        next_probe = _recommend(labels, gold_in_prompt, mmr_adds, cap_adds, route_adds)

        rec = dict(qid=qid, category=r["category"], paper_label=lab, gold_answer=gold[:80],
                   n_evidence=len(ev), n_raw_excerpts=n_raw, gold_in_prompt=gold_in_prompt,
                   geometry=geom, counterfactuals=cf, labels=labels,
                   recommended_next_probe=next_probe)
        out.write(json.dumps(rec) + "\n")
        g = geom
        md.write(f"| {qid} | {r['category'][:12]} | {lab} | {gold_in_prompt} | {len(ev)} | "
                 f"{g.get('cluster_count_85','')} | {g.get('top_cluster_share_85','')} | "
                 f"{g.get('redundancy_ratio_85','')} | {g.get('cluster_entropy_085','')} | "
                 f"{g.get('query_to_top1_sim','')} | {g.get('query_to_gold_sim','')} | "
                 f"{mmr_adds} | {cap_adds} | {route_adds} | {','.join(labels)} | {next_probe} |\n")
        out.flush()
        md.flush()
        print(f"{qid} {r['category'][:12]} lab={lab} labels={labels} probe={next_probe} "
              f"top_share={g.get('top_cluster_share_85')} mmr={mmr_adds} cap={cap_adds} route={route_adds}")

    out.close()
    md.close()
    print(f"\nwrote {results_dir}/geometry_report.{{jsonl,md}}")


if __name__ == "__main__":
    main()
