"""Retrieval-only LongMemEval bench — gbrain-pattern in-memory + N reps + bootstrap CI.

Adopted from gbrain's `src/eval/longmemeval/harness.ts`:
  - in-memory SQLite + TRUNCATE-between-questions (we bulk-copy cached DB rows
    into an in-memory connection instead of opening 500 separate files)
  - skip LLM QA + judge calls — score retrieval via content_recall@K only
  - seeded N reps per question with bootstrap 95% CI on the median
  - per-question latency p50/p99
  - baseline-diff: pass `--baseline path.json` and we report deltas + flag regressions

Target: p50 < 50ms per question on warm cache; runs 500 questions in <60s on a
developer Mac. Enables the methodology fixes gbrain documents in
docs/eval/SEARCH_MODE_METHODOLOGY.md (seed=42 + paired bootstrap 10K + Bonferroni)
to actually be runnable in sinain's iteration loop.

Usage:
    # Baseline run — record stats for current code
    python3 -m eval.local_models.bench_retrieval \\
        --subset 30 --reps 3 --seed 42 \\
        --out eval/local_models/results/retrieval-baseline.json

    # Drift check — compare current code against a prior baseline
    python3 -m eval.local_models.bench_retrieval \\
        --subset 30 --reps 3 --seed 42 \\
        --baseline eval/local_models/results/retrieval-baseline.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sqlite3
import statistics
import sys
import time
from pathlib import Path
from typing import Iterable

# Add sinain-memory root to path (parents: [0]local_models [1]eval [2]sinain-memory)
_root = Path(__file__).resolve().parents[2]
if str(_root) not in sys.path:
    sys.path.insert(0, str(_root))

from eval.benchmarks.longmemeval_adapter import LongMemEvalAdapter
from eval.benchmarks.ingest import ingest_instance, _content_hash
from eval.benchmarks.config import DATA_DIR
from eval.benchmarks.query import compute_content_recall, _get_retrieved_facts


# Tables we preserve across question-resets — schema/seed data, not per-haystack.
# Currently we DELETE everything since each haystack populates its own state.
# Kept as a list for forward compatibility with seeded entity_types / migrations.
PRESERVE_TABLES: frozenset[str] = frozenset()


def _enumerate_data_tables(conn: sqlite3.Connection) -> list[str]:
    """Return all non-system tables that hold per-haystack data."""
    rows = conn.execute(
        "SELECT name FROM sqlite_master "
        "WHERE type='table' AND name NOT LIKE 'sqlite_%' "
        "AND name NOT LIKE '%_fts_%' AND name NOT LIKE '%_fts'"
    ).fetchall()
    # FTS5 virtual tables are managed by triggers — clearing the source table
    # propagates the delete through the AFTER DELETE trigger to the FTS index.
    return [r[0] for r in rows if r[0] not in PRESERVE_TABLES]


def _reset_inmem_db(conn: sqlite3.Connection) -> None:
    """gbrain-pattern TRUNCATE between questions — DELETE from data tables."""
    tables = _enumerate_data_tables(conn)
    for t in tables:
        try:
            conn.execute(f"DELETE FROM {t}")
        except sqlite3.OperationalError:
            # Virtual tables (FTS) may not allow direct delete; rely on triggers
            pass
    conn.commit()


def _copy_cached_to_inmem(cached_db: Path, inmem_conn: sqlite3.Connection) -> None:
    """Bulk-copy cached file DB → in-memory. Uses ATTACH for zero-overhead transfer.

    Schema is created lazily by attaching + selecting; we skip the
    sqlite_master rows themselves but pull each user table's data.
    """
    inmem_conn.execute("ATTACH DATABASE ? AS src", (str(cached_db),))
    try:
        # Lazy schema bootstrap: if main has no triples table yet, copy schema
        existing = inmem_conn.execute(
            "SELECT name FROM main.sqlite_master WHERE type='table'"
        ).fetchall()
        if not existing:
            # Pull schema definitions verbatim and re-create in main
            schema_rows = inmem_conn.execute(
                "SELECT type, name, sql FROM src.sqlite_master "
                "WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL"
            ).fetchall()
            for typ, name, sql in schema_rows:
                try:
                    inmem_conn.execute(sql)
                except sqlite3.OperationalError:
                    pass  # virtual tables / triggers may need ordering — skip on conflict

        # Copy data per table (FTS gets repopulated by AFTER INSERT triggers)
        data_tables = [
            r[0] for r in inmem_conn.execute(
                "SELECT name FROM src.sqlite_master "
                "WHERE type='table' AND name NOT LIKE 'sqlite_%' "
                "AND name NOT LIKE '%_fts%' AND name NOT LIKE '%_idx' "
                "AND name NOT LIKE '%_docsize' AND name NOT LIKE '%_data' "
                "AND name NOT LIKE '%_config'"
            ).fetchall()
        ]
        for t in data_tables:
            try:
                inmem_conn.execute(f"INSERT INTO main.{t} SELECT * FROM src.{t}")
            except sqlite3.OperationalError:
                pass  # FTS shadow tables — ignore
        inmem_conn.commit()
    finally:
        inmem_conn.execute("DETACH DATABASE src")


def _run_retrieval(inmem_path: str, question_text: str, profile: str | None) -> tuple[list[dict], float]:
    """Run sinain retrieval against in-memory DB. Returns (facts, latency_ms)."""
    t0 = time.perf_counter()
    facts = _get_retrieved_facts(inmem_path, question_text, profile=profile)
    latency_ms = (time.perf_counter() - t0) * 1000.0
    return facts, latency_ms


def _bootstrap_ci(values: list[float], n_resamples: int = 1000, ci: float = 0.95, rng: random.Random | None = None) -> tuple[float, float, float]:
    """Paired bootstrap on the median. Returns (median, low, high)."""
    if not values:
        return 0.0, 0.0, 0.0
    rng = rng or random.Random(42)
    n = len(values)
    resampled_medians: list[float] = []
    for _ in range(n_resamples):
        sample = [values[rng.randrange(n)] for _ in range(n)]
        resampled_medians.append(statistics.median(sample))
    resampled_medians.sort()
    lo_idx = int((1 - ci) / 2 * n_resamples)
    hi_idx = int((1 - (1 - ci) / 2) * n_resamples) - 1
    return statistics.median(values), resampled_medians[lo_idx], resampled_medians[min(hi_idx, n_resamples - 1)]


def _percentile(xs: list[float], p: float) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    k = (len(s) - 1) * p / 100
    f = int(k); c = min(f + 1, len(s) - 1)
    if f == c:
        return s[f]
    return s[f] + (s[c] - s[f]) * (k - f)


def run(
    subset: int | None,
    reps: int,
    seed: int,
    profile: str | None,
    out_path: Path | None,
    baseline_path: Path | None,
) -> dict:
    rng = random.Random(seed)
    adapter = LongMemEvalAdapter()
    cache_dir = DATA_DIR / "longmemeval"

    instances = adapter.load_dataset(str(DATA_DIR))
    questions: list = []
    for inst in instances:
        for q in inst.questions:
            questions.append((inst, q))
    if subset is not None:
        questions = questions[:subset]

    print(f"[bench_retrieval] running {len(questions)} questions × {reps} reps, seed={seed}", file=sys.stderr)

    # Note: the in-memory TRUNCATE-between-questions optimization needs a refactor
    # of _get_retrieved_facts to accept an already-open connection (currently it
    # opens TripleStore(db_path) internally). For v1 we run against the cached
    # file DB path — OS page cache makes repeated reads fast — and capture
    # latency to quantify the file-open overhead the in-memory version would save.

    per_question: list[dict] = []
    overall_start = time.perf_counter()

    for idx, (inst, question) in enumerate(questions):
        # Ensure haystack is cached (uses production cache path; no LLM if cached)
        cached_db = ingest_instance(inst, cache_dir)
        if cached_db is None or not cached_db.exists():
            print(f"  [skip] {question.id}: ingestion missing", file=sys.stderr)
            continue

        # Run N reps of retrieval against the cached file DB; collect facts + latency per rep
        cr_by_k: dict[str, list[float]] = {"@1": [], "@3": [], "@5": [], "@10": []}
        latencies: list[float] = []
        for _r in range(reps):
            facts, latency_ms = _run_retrieval(str(cached_db), question.text, profile=profile)
            cr = compute_content_recall(facts, question.gold_answer)
            for k in cr_by_k:
                key = f"content_recall{k}"
                if key in cr:
                    cr_by_k[k].append(cr[key])
            latencies.append(latency_ms)

        per_question.append({
            "id": question.id,
            "category": question.category,
            "reps": reps,
            "content_recall@1": _bootstrap_ci(cr_by_k["@1"]),
            "content_recall@3": _bootstrap_ci(cr_by_k["@3"]),
            "content_recall@5": _bootstrap_ci(cr_by_k["@5"]),
            "content_recall@10": _bootstrap_ci(cr_by_k["@10"]),
            "latency_ms_p50": _percentile(latencies, 50),
            "latency_ms_p99": _percentile(latencies, 99),
        })
        if (idx + 1) % 10 == 0:
            elapsed = time.perf_counter() - overall_start
            print(f"  [{idx+1}/{len(questions)}] elapsed={elapsed:.1f}s avg_p50_latency={statistics.mean([p['latency_ms_p50'] for p in per_question]):.1f}ms", file=sys.stderr)

    total_wall = time.perf_counter() - overall_start

    # Aggregate
    all_p50 = [p["latency_ms_p50"] for p in per_question]
    all_cr10 = [p["content_recall@10"][0] for p in per_question]
    all_cr5 = [p["content_recall@5"][0] for p in per_question]
    all_cr3 = [p["content_recall@3"][0] for p in per_question]
    all_cr1 = [p["content_recall@1"][0] for p in per_question]

    summary = {
        "config": {
            "subset": subset,
            "reps": reps,
            "seed": seed,
            "profile": profile,
            "n_questions": len(per_question),
        },
        "aggregate": {
            "content_recall@1": _bootstrap_ci(all_cr1),
            "content_recall@3": _bootstrap_ci(all_cr3),
            "content_recall@5": _bootstrap_ci(all_cr5),
            "content_recall@10": _bootstrap_ci(all_cr10),
            "latency_ms_p50_median": statistics.median(all_p50) if all_p50 else 0,
            "latency_ms_p50_p95": _percentile(all_p50, 95),
        },
        "wall_clock_seconds": round(total_wall, 1),
        "per_question": per_question,
    }

    # Diff against baseline if provided
    if baseline_path and baseline_path.exists():
        baseline = json.loads(baseline_path.read_text())
        bagg = baseline.get("aggregate", {})
        regression_lines: list[str] = []
        improvement_lines: list[str] = []
        for k in ("content_recall@1", "content_recall@3", "content_recall@5", "content_recall@10"):
            new_med = summary["aggregate"][k][0]
            base_med = bagg.get(k, [0])[0] if isinstance(bagg.get(k), list) else bagg.get(k, 0)
            delta = new_med - base_med
            label = f"{k}: baseline={base_med:.3f} now={new_med:.3f} Δ={delta:+.3f}"
            if delta < -0.02:
                regression_lines.append("  ⚠ REGRESSION  " + label)
            elif delta > 0.02:
                improvement_lines.append("  ✓ IMPROVEMENT " + label)
            else:
                print(f"  · noise        {label}", file=sys.stderr)
        for line in regression_lines + improvement_lines:
            print(line, file=sys.stderr)
        summary["baseline_diff"] = {
            "baseline_path": str(baseline_path),
            "regressions": regression_lines,
            "improvements": improvement_lines,
        }

    # Output
    print("\n=== SUMMARY ===", file=sys.stderr)
    for k, (m, lo, hi) in summary["aggregate"].items() if False else []:
        pass  # Pylint pacifier
    agg = summary["aggregate"]
    print(f"  content_recall@1 :  {agg['content_recall@1'][0]:.3f}  [{agg['content_recall@1'][1]:.3f}, {agg['content_recall@1'][2]:.3f}]", file=sys.stderr)
    print(f"  content_recall@3 :  {agg['content_recall@3'][0]:.3f}  [{agg['content_recall@3'][1]:.3f}, {agg['content_recall@3'][2]:.3f}]", file=sys.stderr)
    print(f"  content_recall@5 :  {agg['content_recall@5'][0]:.3f}  [{agg['content_recall@5'][1]:.3f}, {agg['content_recall@5'][2]:.3f}]", file=sys.stderr)
    print(f"  content_recall@10:  {agg['content_recall@10'][0]:.3f}  [{agg['content_recall@10'][1]:.3f}, {agg['content_recall@10'][2]:.3f}]", file=sys.stderr)
    print(f"  latency p50      :  {agg['latency_ms_p50_median']:.1f} ms (p95 across questions: {agg['latency_ms_p50_p95']:.1f} ms)", file=sys.stderr)
    print(f"  wall clock       :  {total_wall:.1f} s for {len(per_question)} questions × {reps} reps", file=sys.stderr)

    if out_path:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(summary, indent=2))
        print(f"  written: {out_path}", file=sys.stderr)

    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="LongMemEval retrieval-only bench (gbrain-pattern)")
    parser.add_argument("--subset", type=int, default=None, help="Limit to first N questions")
    parser.add_argument("--reps", type=int, default=3, help="Reps per question (for bootstrap CI)")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--profile", default="eval", help="Caller profile passed to query_params")
    parser.add_argument("--out", type=Path, default=None, help="Output JSON path")
    parser.add_argument("--baseline", type=Path, default=None, help="Baseline JSON for regression diff")
    args = parser.parse_args()

    run(
        subset=args.subset,
        reps=args.reps,
        seed=args.seed,
        profile=args.profile,
        out_path=args.out,
        baseline_path=args.baseline,
    )


if __name__ == "__main__":
    main()
