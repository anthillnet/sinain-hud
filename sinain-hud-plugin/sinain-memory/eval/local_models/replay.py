"""Capture-and-replay eval substrate.

Companion to the `@_record_candidate` hook in graph_query.py. Reads an
NDJSON baseline captured with SINAIN_EVAL_CAPTURE=1, re-runs each query
against the current code, and reports retrieval drift as:

  - Jaccard@k of returned entity slugs (intersection / union of top-k sets)
  - top-1 stability (does the #1 entity slug still match?)
  - latency Δ (median across reps vs baseline single-shot latency)

Per-question deltas plus aggregate. Gated changes that don't affect
retrieval output show Jaccard@k near 1.0 and latency Δ near 0; structural
fixes show clear positive or negative shifts.

Usage:
    # 1. Capture a baseline (off by default — opt in per process)
    SINAIN_EVAL_CAPTURE=1 python3 -m eval.local_models.bench_retrieval \\
        --subset 30 --out results/cap-baseline.json
    # baseline ndjson lands at $SINAIN_MEMORY_DIR/eval-captures.ndjson
    mv ~/.sinain/memory/eval-captures.ndjson results/cap-baseline.ndjson

    # 2. Make code change

    # 3. Replay
    python3 -m eval.local_models.replay \\
        --against results/cap-baseline.ndjson --reps 1 --jaccard-k 10
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

# Add sinain-memory root to path (parents: [0]local_models [1]eval [2]sinain-memory)
_root = Path(__file__).resolve().parents[2]
if str(_root) not in sys.path:
    sys.path.insert(0, str(_root))

import graph_query  # noqa: E402

_PATH_FNS = {
    "query_facts_hybrid": graph_query.query_facts_hybrid,
}
# query_stage2_triples is feat-branch-only (Phase B.4.5 Stage 4); register
# it if present so replay works against either branch's graph_query surface.
if hasattr(graph_query, "query_stage2_triples"):
    _PATH_FNS["query_stage2_triples"] = graph_query.query_stage2_triples


def _jaccard(a: list[str], b: list[str], k: int) -> float:
    sa, sb = set(a[:k]), set(b[:k])
    if not sa and not sb:
        return 1.0
    return len(sa & sb) / len(sa | sb) if (sa | sb) else 1.0


def _replay_one(row: dict, reps: int) -> dict:
    fn = _PATH_FNS.get(row["retrieval_path"])
    if fn is None:
        return {"skipped": True, "reason": f"unknown path {row['retrieval_path']}"}
    db_path = row["db_path"]
    if not Path(db_path).exists():
        return {"skipped": True, "reason": f"db missing {db_path}"}

    # Round-trip the kwargs the captured call was made with — without this,
    # profile-driven params (precision_mode, hop_depth, …) silently default
    # and replay reports drift on a no-op.
    kwargs = row.get("kwargs", {}) or {}

    slug_lists: list[list[str]] = []
    latencies: list[float] = []
    for _ in range(reps):
        t0 = time.perf_counter()
        facts = fn(db_path, row["query"], **kwargs)
        latencies.append((time.perf_counter() - t0) * 1000.0)
        slugs: list[str] = []
        if isinstance(facts, list):
            for f in facts:
                if isinstance(f, dict):
                    eid = f.get("entity_id") or f.get("entityId")
                    if eid:
                        slugs.append(eid)
        slug_lists.append(slugs)

    # Use first rep for set-comparison stability; latency is medianed.
    current_slugs = slug_lists[0]
    return {
        "skipped": False,
        "current_slugs": current_slugs,
        "latency_ms": statistics.median(latencies),
    }


def run(baseline_path: Path, reps: int, jaccard_k: int, verbose: bool) -> dict:
    rows = [json.loads(line) for line in baseline_path.read_text().splitlines() if line.strip()]
    # EVAL-05: exclude ablation runs from drift gating. Legacy rows without the
    # 'ablation' field default to 'none' via .get() — fully backward-compatible.
    rows = [r for r in rows if r.get("ablation", "none") == "none"]
    # Ensure replay itself doesn't re-capture — would corrupt downstream comparisons.
    import os
    os.environ.pop("SINAIN_EVAL_CAPTURE", None)

    per_question: list[dict] = []
    for idx, row in enumerate(rows):
        result = _replay_one(row, reps)
        if result["skipped"]:
            if verbose:
                print(f"  [skip {idx}] {result['reason']}", file=sys.stderr)
            per_question.append({"idx": idx, "query": row["query"], "skipped": True})
            continue
        baseline_slugs = row.get("retrieved_entity_slugs", [])
        current_slugs = result["current_slugs"]
        jaccard = _jaccard(baseline_slugs, current_slugs, jaccard_k)
        if not baseline_slugs and not current_slugs:
            top1_stable = True
        elif baseline_slugs and current_slugs:
            top1_stable = baseline_slugs[0] == current_slugs[0]
        else:
            top1_stable = False
        per_question.append({
            "idx": idx,
            "query": row["query"],
            "retrieval_path": row["retrieval_path"],
            "jaccard_at_k": jaccard,
            "top1_stable": top1_stable,
            "baseline_latency_ms": row.get("latency_ms"),
            "current_latency_ms": round(result["latency_ms"], 2),
            "latency_delta_ms": (
                round(result["latency_ms"] - row.get("latency_ms", 0.0), 2)
                if row.get("latency_ms") is not None else None
            ),
            "baseline_top": baseline_slugs[:3],
            "current_top": current_slugs[:3],
        })
        if verbose:
            print(
                f"  [{idx}] jaccard@{jaccard_k}={jaccard:.2f} top1={'✓' if top1_stable else '✗'} "
                f"Δlat={per_question[-1]['latency_delta_ms']}ms  q={row['query'][:60]!r}",
                file=sys.stderr,
            )

    scored = [r for r in per_question if not r.get("skipped")]
    jaccards = [r["jaccard_at_k"] for r in scored]
    top1s = [1 if r["top1_stable"] else 0 for r in scored]
    deltas = [r["latency_delta_ms"] for r in scored if r["latency_delta_ms"] is not None]

    summary = {
        "config": {
            "baseline": str(baseline_path),
            "reps": reps,
            "jaccard_k": jaccard_k,
            "n_baseline_rows": len(rows),
            "n_scored": len(scored),
            "n_skipped": len(rows) - len(scored),
        },
        "aggregate": {
            f"jaccard_at_{jaccard_k}_mean": statistics.mean(jaccards) if jaccards else 0.0,
            f"jaccard_at_{jaccard_k}_median": statistics.median(jaccards) if jaccards else 0.0,
            "top1_stability_rate": statistics.mean(top1s) if top1s else 0.0,
            "latency_delta_ms_median": statistics.median(deltas) if deltas else 0.0,
        },
        "per_question": per_question,
    }

    print("\n=== REPLAY SUMMARY ===", file=sys.stderr)
    agg = summary["aggregate"]
    print(f"  scored:        {summary['config']['n_scored']}/{summary['config']['n_baseline_rows']}", file=sys.stderr)
    print(f"  jaccard@{jaccard_k}:    mean={agg[f'jaccard_at_{jaccard_k}_mean']:.3f}  median={agg[f'jaccard_at_{jaccard_k}_median']:.3f}", file=sys.stderr)
    print(f"  top-1 stable:  {agg['top1_stability_rate']*100:.1f}%", file=sys.stderr)
    print(f"  Δlatency (med): {agg['latency_delta_ms_median']:+.2f} ms", file=sys.stderr)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Capture-replay eval — compare retrieval drift vs an NDJSON baseline")
    parser.add_argument("--against", type=Path, required=True, help="NDJSON baseline path")
    parser.add_argument("--reps", type=int, default=1, help="Reps per query (latency only — slugs use rep 0)")
    parser.add_argument("--jaccard-k", type=int, default=10, help="Top-k for Jaccard set comparison")
    parser.add_argument("--out", type=Path, default=None, help="Write JSON report to this path")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    summary = run(
        baseline_path=args.against,
        reps=args.reps,
        jaccard_k=args.jaccard_k,
        verbose=args.verbose,
    )
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(summary, indent=2))
        print(f"  written: {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
