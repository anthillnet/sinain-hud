#!/usr/bin/env python3
"""distill_test.py — fast single-haystack distiller A/B.

Re-distills ONE question's haystack into a temp store (fresh, ~3-4 min) and reports
whether the gold answer's keywords appear in the distilled facts — so a distiller
prompt change can be validated in minutes instead of a 70-min full re-distill.

Usage: python3 -m eval.benchmarks.distill_test <qid> [<qid> ...]
Honors the same env (SINAIN_BENCH_MODEL etc.) and pipeline-version cache key, so it
distills fresh whenever session_distiller/integrator/ingest change.
"""
import re
import sys
import tempfile
from pathlib import Path

from eval.benchmarks.longmemeval_adapter import LongMemEvalAdapter
from eval.benchmarks.ingest import ingest_instance

STOP = set("the a an of to in on for and or is are was were be i you my your with at how "
           "many much who which did do does have has from this that what when where".split())


def _kw(s):
    return [w for w in re.findall(r"[a-z0-9]+", s.lower()) if w not in STOP and len(w) > 2]


def main():
    qids = set(sys.argv[1:])
    cache_dir = Path("eval/benchmarks/data")  # adapter appends "longmemeval/"
    adapter = LongMemEvalAdapter()
    instances = adapter.load_dataset(str(cache_dir))
    # build qid -> (instance, question)
    targets = []
    for inst in instances:
        for q in inst.questions:
            if q.id in qids:
                targets.append((inst, q))
    if not targets:
        print("no matching qids found"); return
    tmp = Path(tempfile.mkdtemp(prefix="distill-test-"))
    sys.path.insert(0, "."); sys.path.insert(0, "../..")
    from graph_query import query_facts_hybrid
    for inst, q in targets:
        db = ingest_instance(inst, tmp / "longmemeval")
        facts = [f for f in query_facts_hybrid(str(db), q.text, max_facts=50)
                 if f.get("source") != "raw-excerpt"]
        gk = _kw(q.gold_answer)
        blob = " ".join(f.get("value", "") for f in facts).lower()
        present = [k for k in gk if k in blob]
        print("=" * 70)
        print(f"{q.id} | gold={q.gold_answer[:70]!r}")
        print(f"  TOTAL distilled facts retrieved: {len(facts)}")
        for f in facts[:6]:
            print(f"    · {(f.get('value','') or '')[:90]}")
        print(f"  gold-kw in distilled facts: {len(present)}/{len(gk)}  {present[:8]}")
        # show facts that share any gold kw
        for f in facts[:50]:
            v = f.get("value", "")
            if gk and any(k in v.lower() for k in gk):
                print(f"    ~ {v[:100]}")


if __name__ == "__main__":
    main()
