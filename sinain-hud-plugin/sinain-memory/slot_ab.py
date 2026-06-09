#!/usr/bin/env python3
"""slot_ab.py — same-store A/B for Tier-1 write-time slot supersession.

Isolates the supersession effect from re-distill variance: ingest each haystack
ONCE (slot OFF), QA it (baseline), then COPY the store, run slot_supersede_sweep
on the copy, and QA again (treatment). Compare paper_label per qid.

Usage: python3 slot_ab.py /tmp/ku_ab_qids.txt   (run with production SINAIN_* flags set)
"""
import os
import shutil
import sys
import tempfile

from eval.benchmarks.config import DATA_DIR, QA_MODEL
from eval.benchmarks.longmemeval_adapter import LongMemEvalAdapter
from eval.benchmarks.ingest import ingest_instance, get_knowledge_doc
from eval.benchmarks.query import answer_question
from eval.benchmarks.judges.longmemeval_judge import judge_paper
from knowledge_integrator import slot_supersede_sweep

K = int(os.environ.get("SINAIN_QA_VOTES", "5"))


def majority_label(question, db_path, full_ctx, kdoc):
    ones = 0
    for _ in range(K):
        txt = answer_question(question, "sinain-memory", db_path=str(db_path),
                              full_context=full_ctx, knowledge_doc=kdoc,
                              model=QA_MODEL, profile=None)
        if judge_paper(question_type=question.category, question_id=question.id,
                       question=question.text, gold=question.gold_answer, response=txt):
            ones += 1
    return 1 if ones * 2 > K else 0, ones, (txt or "")[:80]


def main():
    qids = set(open(sys.argv[1]).read().strip().split(","))
    adapter = LongMemEvalAdapter()
    instances = adapter.load_dataset(str(DATA_DIR))
    # map: instance -> the target questions in it
    targets = []
    for inst in instances:
        qs = [q for q in inst.questions if getattr(q, "id", None) in qids]
        if qs:
            targets.append((inst, qs))
    print(f"slot A/B: {sum(len(q) for _, q in targets)} qids across {len(targets)} haystacks, K={K}\n", flush=True)

    off_pass = on_pass = 0; off2on_fix = on2off_reg = 0; n = 0
    for inst, qs in targets:
        try:
            db = ingest_instance(inst, DATA_DIR / "longmemeval")
        except Exception as e:
            print(f"  [{inst.id}] ingest failed: {e}", flush=True); continue
        if not db:
            print(f"  [{inst.id}] ingest -> None", flush=True); continue
        full_ctx = adapter.format_full_context(inst)
        kdoc = get_knowledge_doc(db)
        # treatment store = copy + sweep
        swept = os.path.join(tempfile.mkdtemp(), "swept.db")
        shutil.copytree(db, swept)
        nret = slot_supersede_sweep(swept)
        for q in qs:
            off, o1, _ = majority_label(q, db, full_ctx, kdoc)
            on, n1, ans = majority_label(q, swept, full_ctx, get_knowledge_doc(swept))
            n += 1; off_pass += off; on_pass += on
            flip = ""
            if off == 0 and on == 1: off2on_fix += 1; flip = "  ✅ FIX"
            elif off == 1 and on == 0: on2off_reg += 1; flip = "  ❌ REGRESS"
            print(f"  {q.id:14s} off={off}({o1}/{K}) on={on}({n1}/{K}) retract={nret}{flip}", flush=True)
        shutil.rmtree(os.path.dirname(swept), ignore_errors=True)

    print(f"\n=== SLOT A/B ({n} qids) ===")
    print(f"  baseline (off): {off_pass}/{n}")
    print(f"  treatment (on): {on_pass}/{n}")
    print(f"  fixes (0->1): {off2on_fix}   regressions (1->0): {on2off_reg}   net: {on_pass-off_pass:+d}")


if __name__ == "__main__":
    main()
