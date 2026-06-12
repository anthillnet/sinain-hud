#!/usr/bin/env python3
"""diag_stages.py — P0 failure-stage dashboard.

Reads a LongMemEval progress.jsonl (per-question records with the new
``retrieval.stage`` field set by runner._classify_failure_stage) and prints a
category × stage matrix. This is the scoreboard the memory-improvement phases
are measured against: it answers "of the multi-session fails, how many are
write-drop vs retrieval-miss vs stale-current vs answer-side?" — so each phase
targets the dominant stage instead of guessing.

Usage:
    python3 -m eval.benchmarks.diag_stages <progress.jsonl> [condition]

Stages: ok | write_drop | ambiguous | retrieval_miss | stale_current |
        answer_side | unknown | (none = not attributed)
"""
import json
import sys
from collections import Counter, defaultdict

STAGES = ["ok", "answer_side", "retrieval_miss", "stale_current",
          "write_drop", "ambiguous", "unknown", "none"]
CAT_ORDER = ["single-session-user", "single-session-assistant",
             "single-session-preference", "knowledge-update",
             "temporal-reasoning", "multi-session"]


def load(path: str, condition: str):
    seen = {}  # id -> (category, stage, label) ; last write wins (resume-safe)
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            cat = r.get("category", "?")
            stage = (r.get("retrieval") or {}).get("stage") or "none"
            ans = (r.get("answers") or {}).get(condition, {})
            label = ans.get("paper_label")
            seen[r["id"]] = (cat, stage, label)
    return seen


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    path = sys.argv[1]
    condition = sys.argv[2] if len(sys.argv) > 2 else "sinain-memory"
    seen = load(path, condition)

    by_cat_stage = defaultdict(Counter)   # cat -> stage -> n
    cat_tot = Counter()
    cat_pass = Counter()
    for cat, stage, label in seen.values():
        by_cat_stage[cat][stage] += 1
        cat_tot[cat] += 1
        if label == 1:
            cat_pass[cat] += 1

    cats = [c for c in CAT_ORDER if c in cat_tot] + \
           [c for c in sorted(cat_tot) if c not in CAT_ORDER]
    fail_stages = [s for s in STAGES if s != "ok"]

    # header
    w = 26
    print(f"\nFailure-stage dashboard  ({len(seen)} questions, condition={condition})\n")
    hdr = f"{'category':{w}s} {'pass':>7s}  " + "  ".join(f"{s[:9]:>9s}" for s in fail_stages)
    print(hdr)
    print("-" * len(hdr))
    for c in cats:
        rate = f"{cat_pass[c]}/{cat_tot[c]}"
        cells = "  ".join(f"{by_cat_stage[c].get(s, 0):>9d}" for s in fail_stages)
        print(f"{c:{w}s} {rate:>7s}  {cells}")
    # totals
    tot_pass = sum(cat_pass.values())
    tot_n = sum(cat_tot.values())
    tot_cells = "  ".join(
        f"{sum(by_cat_stage[c].get(s, 0) for c in cats):>9d}" for s in fail_stages
    )
    print("-" * len(hdr))
    print(f"{'TOTAL':{w}s} {f'{tot_pass}/{tot_n}':>7s}  {tot_cells}")

    # multi-session spotlight (the target category)
    ms = by_cat_stage.get("multi-session", Counter())
    ms_fail = {s: n for s, n in ms.items() if s != "ok" and n}
    if ms_fail:
        print("\nmulti-session fails by stage:",
              ", ".join(f"{s}={n}" for s, n in sorted(ms_fail.items(), key=lambda x: -x[1])))


if __name__ == "__main__":
    main()
