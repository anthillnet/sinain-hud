"""Scratch: run specific qids against PINNED guard9 store hashes (bypasses the
stale 18-q HASHMAP in diag_oneq). Read-only over the store; no re-distill.
Usage: python3 -m eval.benchmarks.diag_count <qid> [k]
"""
import os, sys
sys.path.insert(0, ".")
sys.path.insert(0, "../..")
from eval.benchmarks.longmemeval_adapter import LongMemEvalAdapter
from eval.benchmarks.query import answer_question
from eval.benchmarks.judges.longmemeval_judge import judge_paper
from eval.benchmarks.config import QA_MODEL, DATA_DIR

GUARD9 = {
    "0a995998": "8f8bb33b04123854",
    "6d550036": "a1a12cbfdefab88b",
    "gpt4_59c863d7": "24854ded2c7fceb0",
    "3a704032": "fbc1d0cfab62f63f",
    "6ae235be": "f36a828d1e8751cd",
    "d7c942c3": "b2be80400a6d2d7f",
    "0edc2aef": "139d5ea6ad31be96",
}


def main():
    qid = sys.argv[1]
    k = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    h = GUARD9[qid]
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
    print(f"--- {k} QA votes (model={QA_MODEL}) ---")
    labels = []
    for v in range(k):
        a = answer_question(question, "sinain-memory", db_path=db_path, model=QA_MODEL)
        lbl = 1 if judge_paper(
            question_type=question.category, question_id=question.id,
            question=question.text, gold=question.gold_answer, response=a,
        ) else 0
        labels.append(lbl)
        print(f"  vote {v+1}: label={lbl}  ans={a[:240]!r}")
    ones = sum(labels)
    print(f"\nRESULT {qid}: {ones}/{k}  (majority={'PASS' if ones * 2 > k else 'FAIL'})")


if __name__ == "__main__":
    main()
