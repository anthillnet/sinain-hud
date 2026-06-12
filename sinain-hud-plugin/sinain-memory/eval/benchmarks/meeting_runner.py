#!/usr/bin/env python3
"""Meeting Memory Benchmark runner — evaluates a captured knowledge-graph.db.

Standalone script: does NOT modify or import runner.py.
Reuses shared infrastructure: query, judge, evaluate, report.

Usage:
    python3 eval/benchmarks/meeting_runner.py \
        --db /tmp/sinain-bench-XXXX/knowledge-graph.db \
        --conditions sinain-memory,full-context

    # Quick test (3 questions):
    python3 eval/benchmarks/meeting_runner.py \
        --db /tmp/sinain-bench-XXXX/knowledge-graph.db \
        --subset 3
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# Add sinain-memory to path
_koog_dir = str(Path(__file__).resolve().parent.parent.parent)
if _koog_dir not in sys.path:
    sys.path.insert(0, _koog_dir)

from eval.benchmarks.config import DATA_DIR, RESULTS_DIR, QA_MODEL, JUDGE_MODEL
from eval.benchmarks.meeting_adapter import MeetingMemoryAdapter
from eval.benchmarks.query import answer_question, _get_retrieved_facts, compute_content_recall
from eval.benchmarks.evaluate import token_f1, aggregate_results
from eval.benchmarks.judges.qa_judge import judge_qa
from eval.benchmarks.report import generate_markdown, generate_json
from eval.benchmarks.runner import (
    _log_distillation_summary,
    _log_retrieval_diagnostics,
)


def run_meeting_benchmark(
    db_path: str,
    conditions: list[str],
    *,
    subset: int | None = None,
    meeting_filter: str | None = None,
    qa_model: str = QA_MODEL,
    judge_model: str = JUDGE_MODEL,
    output_dir: Path = RESULTS_DIR,
    data_dir: Path = DATA_DIR,
    resume: bool = False,
    profile: str | None = None,
) -> tuple[dict, list[dict]]:
    """Run meeting benchmark against a captured knowledge-graph.db."""

    adapter = MeetingMemoryAdapter()
    instances = adapter.load_dataset(str(data_dir))

    if meeting_filter:
        # Prefer an EXACT stem match (id == "meeting-<stem>") so e.g.
        # `--meeting acme-prep` selects ONLY the 25-q file and not also
        # `acme-prep-5min` (substring). Fall back to substring for partial
        # names. Fixes the eval-log stem-match gotcha (n=37 → n=25).
        exact = [i for i in instances if i.id == f"meeting-{meeting_filter}"]
        instances = exact if exact else [i for i in instances if meeting_filter in i.id]
        print(f"[meeting] filtered to {len(instances)} meeting(s) matching '{meeting_filter}'"
              f"{' (exact)' if exact else ' (substring)'}")

    if not instances:
        print("[meeting] no meeting data found — check data/meeting/ directory")
        return {"error": "no data"}, []

    # Validate DB exists for sinain-memory condition
    if "sinain-memory" in conditions:
        if not db_path or not Path(db_path).exists():
            print(f"[meeting] ERROR: --db path does not exist: {db_path}")
            print("  Run the capture pipeline first (see plan Part 1)")
            sys.exit(1)

    print(f"\n{'='*60}")
    print(f"  Meeting Memory Benchmark")
    print(f"  Conditions: {', '.join(conditions)}")
    print(f"  DB: {db_path or '(none)'}")
    print(f"  QA model: {qa_model}")
    print(f"  Judge model: {judge_model}")
    print(f"  Profile: {profile or '(default)'}")
    print(f"{'='*60}\n")

    # One-shot distillation summary for the captured DB. Live-recording
    # bench skips ingestion (real pipeline captured) so we log here once
    # to surface "what made it into the graph" — diagnoses transcription
    # gaps (per 2026-05-28 finding: en-US gate dropped Russian audio,
    # left graph with 8% content recall).
    if db_path and "sinain-memory" in conditions:
        from pathlib import Path as _P
        _log_distillation_summary(_P(db_path))

    # Flatten questions
    all_questions = []
    for inst in instances:
        for q in inst.questions:
            all_questions.append((inst, q))

    if subset:
        all_questions = all_questions[:subset]

    total = len(all_questions)
    print(f"[meeting] evaluating {total} questions\n")

    # Resume support
    resume_path = output_dir / "meeting_progress.jsonl"
    completed: dict[str, dict] = {}
    if resume and resume_path.exists():
        for line in resume_path.read_text().strip().split("\n"):
            if line:
                entry = json.loads(line)
                completed[entry["id"]] = entry

    output_dir.mkdir(parents=True, exist_ok=True)
    details: list[dict] = []

    for idx, (inst, question) in enumerate(all_questions):
        qid = question.id

        if qid in completed:
            details.append(completed[qid])
            continue

        print(f"[{idx+1}/{total}] {qid} [{question.category}]")
        print(f"  Q: {question.text[:80]}...")

        full_context = adapter.format_full_context(inst)

        # Retrieval metrics
        retrieval = {}
        retrieved_facts: list[dict] = []
        if db_path and "sinain-memory" in conditions:
            speaker_filter = (question.metadata or {}).get("speaker_filter") or None
            retrieved_facts = _get_retrieved_facts(
                db_path, question.text, profile=profile, speaker_filter=speaker_filter,
            )
            retrieval = compute_content_recall(retrieved_facts, question.gold_answer)
            _log_retrieval_diagnostics(question, retrieved_facts, retrieval, db_path)

        # Generate answers per condition
        answers = {}
        for cond in conditions:
            if cond == "sinain-memory" and not db_path:
                answers[cond] = {"text": "(no DB)", "score": 1, "f1": 0.0}
                continue

            print(f"  [{cond}] generating answer...")
            # Self-consistency voting (SINAIN_QA_VOTES, default 5): the QA model
            # is non-deterministic at temp=0, so a single 1-5 judge score is
            # noisy (±0.3+ run-to-run). Sample k answers, judge each, take the
            # MEAN score — the comparison-stable signal. k=1 == old behavior.
            n_votes = max(1, int(os.environ.get("SINAIN_QA_VOTES", "5")))
            v_scores: list[float] = []
            v_f1s: list[float] = []
            v_texts: list[str] = []
            for _v in range(n_votes):
                a_text = answer_question(
                    question, cond,
                    db_path=db_path,
                    full_context=full_context,
                    model=qa_model,
                    profile=profile,
                )
                v_texts.append(a_text)
                v_f1s.append(token_f1(a_text, question.gold_answer))
                jr = judge_qa(
                    question.text, question.gold_answer, a_text,
                    condition=cond, model=judge_model,
                )
                if jr and jr.get("score") is not None:
                    v_scores.append(float(jr["score"]))

            score = round(sum(v_scores) / len(v_scores), 2) if v_scores else None
            f1 = round(sum(v_f1s) / len(v_f1s), 4) if v_f1s else 0.0

            answers[cond] = {
                "text": v_texts[0][:500] if v_texts else "",
                "score": score,
                "f1": f1,
                "reasoning": None,
                "vote_split": {"scores": v_scores, "k": len(v_scores)},
            }
            print(f"    score={score}/5 (k={len(v_scores)}) f1={f1:.2f}")

        entry = {
            "id": qid,
            "question": question.text,
            "gold_answer": question.gold_answer,
            "category": question.category,
            "retrieval": retrieval,
            "answers": answers,
        }
        details.append(entry)

        # Save progress
        with open(resume_path, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    summary = aggregate_results(details)
    return summary, details


def main() -> None:
    parser = argparse.ArgumentParser(description="Meeting Memory Benchmark")
    parser.add_argument("--db", required=False, default=None,
                        help="Path to knowledge-graph.db from capture run")
    parser.add_argument("--conditions", default="sinain-memory,full-context",
                        help="Comma-separated conditions (sinain-memory, full-context)")
    parser.add_argument("--subset", type=int, default=None,
                        help="Run only first N questions")
    parser.add_argument("--meeting", default=None,
                        help="Filter to specific meeting by stem (e.g. acme-prep-5min)")
    parser.add_argument("--qa-model", default=QA_MODEL)
    parser.add_argument("--judge-model", default=JUDGE_MODEL)
    parser.add_argument("--output-dir", type=Path, default=RESULTS_DIR)
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    parser.add_argument("--format", default="json,markdown")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--profile", default=None,
                        help="Named caller profile from query_params.QUERY_PROFILES "
                             "(eval, escalation, agent-tick, browse, ...). When set, applies "
                             "precision_mode / hop_depth / format / etc. Default: built-in defaults.")
    args = parser.parse_args()

    conditions = [c.strip() for c in args.conditions.split(",")]
    formats = [f.strip() for f in args.format.split(",")]

    summary, details = run_meeting_benchmark(
        args.db, conditions,
        subset=args.subset,
        meeting_filter=args.meeting,
        qa_model=args.qa_model,
        judge_model=args.judge_model,
        output_dir=args.output_dir,
        data_dir=args.data_dir,
        resume=args.resume,
        profile=args.profile,
    )

    # Write outputs
    args.output_dir.mkdir(parents=True, exist_ok=True)

    if "json" in formats:
        json_path = args.output_dir / "meeting_results.json"
        json_path.write_text(generate_json("meeting", summary, details))
        print(f"\n[output] JSON: {json_path}")

    if "markdown" in formats:
        md_path = args.output_dir / "meeting_results.md"
        md_path.write_text(generate_markdown("meeting", summary, details))
        print(f"[output] Markdown: {md_path}")

    # Print summary
    print(f"\n{'='*60}")
    print(f"  Meeting Memory Benchmark — Summary")
    print(f"{'='*60}")
    ipr = summary.get("ipr")
    if ipr:
        print(f"  IPR: {ipr:.1%}")
    for cond, data in summary.get("conditions", {}).items():
        print(f"  {cond}: {data['mean_score']:.2f}/5 (n={data['n']})")
    for k, v in summary.get("retrieval", {}).items():
        print(f"  {k}: {v:.1%}")
    print()


if __name__ == "__main__":
    main()
