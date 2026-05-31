#!/usr/bin/env python3
"""diag_oneq.py — run ONE LongMemEval question end-to-end (retrieval→QA k-vote→judge).

Fast iteration harness: no full-set bench. Resolves the question from the adapter,
points at the existing cached store (qid->hash via HASHMAP or a runner log), samples
k QA answers, judges each with the paper judge, prints ones/k + each answer.

Usage:
  python3 -m eval.benchmarks.diag_oneq <qid> [k] [run_log]
"""
import os
import sys

sys.path.insert(0, ".")
sys.path.insert(0, "../..")

from eval.benchmarks.longmemeval_adapter import LongMemEvalAdapter
from eval.benchmarks.query import answer_question
from eval.benchmarks.judges.longmemeval_judge import judge_paper
from eval.benchmarks.config import QA_MODEL, JUDGE_MODEL, DATA_DIR

# qid -> store hash (18-q set); extend from a runner log for other subsets.
HASHMAP = {
    "6a1eabeb": "5f46a05de12589a4", "6aeb4375": "c91e464dc5e426a1", "830ce83f": "c84cdf27b0fee280",
    "0a995998": "9a412228a23e075c", "6d550036": "96ad954260a3e9f4", "gpt4_59c863d7": "9b70561f1aa22f96",
    "7161e7e2": "1cfd46292e3291d9", "c4f10528": "ba74574075b29b0f", "89527b6b": "de31f5e20489597f",
    "8a2466db": "f80267e722d1e51d", "06878be2": "48c5055736e621d1", "75832dbd": "4bb8236cf0a41b48",
    "e47becba": "f98f91aa7a13a3de", "118b2229": "6da2e83365fa5123", "51a45a95": "135abdb49ff3f2c5",
    "gpt4_59149c77": "67c35ab121496ae5", "gpt4_f49edff3": "c75b28a407e5ad28", "71017276": "6b1097b0d30fb25d",
    "0edc2aef": "328dc9c1ca4bd065",
}


def _hash_from_log(log_path, qid):
    import re
    cur = None
    for ln in open(log_path, errors="ignore"):
        m = re.match(r"\[\d+/\d+\]\s+(\S+)\s+\[", ln)
        if m:
            cur = m.group(1)
        m2 = re.search(r"sidecar for ([0-9a-f]{12,})\.db", ln)
        if m2 and cur == qid:
            return m2.group(1)
    return None


def main():
    qid = sys.argv[1]
    k = int(sys.argv[2]) if len(sys.argv) > 2 else 9
    log_path = sys.argv[3] if len(sys.argv) > 3 else None

    h = HASHMAP.get(qid) or (_hash_from_log(log_path, qid) if log_path else None)
    assert h, f"no store hash for {qid} (pass a run log as arg 3)"
    db_path = f"eval/benchmarks/data/longmemeval/stores/{h}.db"
    assert os.path.exists(db_path), f"store missing: {db_path}"

    adapter = LongMemEvalAdapter()
    instances = adapter.load_dataset(str(DATA_DIR))
    question = None
    for inst in instances:
        for q in inst.questions:
            if q.id == qid:
                question = q
                break
        if question:
            break
    assert question, f"qid {qid} not in dataset"

    print(f"qid={qid} [{question.category}] store={h}")
    print(f"Q: {question.text}")
    print(f"GOLD: {question.gold_answer}")
    print(f"--- {k} QA votes (model={QA_MODEL}, judge={JUDGE_MODEL}) ---")

    labels = []
    for v in range(k):
        a = answer_question(question, "sinain-memory", db_path=db_path, model=QA_MODEL)
        lbl = 1 if judge_paper(
            question_type=question.category,
            question_id=question.id,
            question=question.text,
            gold=question.gold_answer,
            response=a,
        ) else 0
        labels.append(lbl)
        print(f"  vote {v+1}: label={lbl}  ans={a[:140]!r}")

    ones = sum(labels)
    print(f"\nRESULT {qid}: {ones}/{k}  (majority={'PASS' if ones * 2 > k else 'FAIL'})")


if __name__ == "__main__":
    main()
