#!/usr/bin/env python3
"""Benchmark runner — evaluates sinain's knowledge graph against published benchmarks.

Usage:
    python3 eval/benchmarks/runner.py --benchmarks longmemeval --subset 5
    python3 eval/benchmarks/runner.py --benchmarks longmemeval --conditions sinain-memory,full-context
    python3 eval/benchmarks/runner.py --benchmarks longmemeval --format markdown --resume
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Add sinain-memory to path
_koog_dir = str(Path(__file__).resolve().parent.parent.parent)
if _koog_dir not in sys.path:
    sys.path.insert(0, _koog_dir)

from eval.benchmarks.config import DATA_DIR, RESULTS_DIR, QA_MODEL, JUDGE_MODEL
from eval.benchmarks.base_adapter import BenchmarkAdapter, BenchmarkInstance
from eval.benchmarks.longmemeval_adapter import LongMemEvalAdapter
from eval.benchmarks.ingest import ingest_instance, get_knowledge_doc
from eval.benchmarks.query import answer_question, _get_retrieved_facts, compute_content_recall
from eval.benchmarks.evaluate import (
    token_f1, aggregate_results,
)
from eval.benchmarks.judges.qa_judge import judge_qa
from eval.benchmarks.report import generate_markdown, generate_json


def _get_adapter(name: str) -> BenchmarkAdapter:
    if name == "longmemeval":
        return LongMemEvalAdapter()
    raise ValueError(f"Unknown benchmark: {name}. Available: longmemeval")


def _load_resume(resume_path: Path) -> dict[str, dict]:
    """Load previously computed results for resume support."""
    results = {}
    if resume_path.exists():
        for line in resume_path.read_text().strip().split("\n"):
            if line:
                entry = json.loads(line)
                results[entry["id"]] = entry
    return results


def run_benchmark(
    benchmark_name: str,
    conditions: list[str],
    *,
    subset: int | None = None,
    qa_model: str = QA_MODEL,
    judge_model: str = JUDGE_MODEL,
    output_dir: Path = RESULTS_DIR,
    cache_dir: Path = DATA_DIR,
    resume: bool = False,
    skip_llm: bool = False,
    stratified: bool = False,
) -> tuple[dict, list[dict]]:
    """Run a benchmark end-to-end. Returns (summary, details)."""

    adapter = _get_adapter(benchmark_name)

    # Load dataset
    print(f"\n{'='*60}")
    print(f"  Benchmark: {benchmark_name}")
    print(f"  Conditions: {', '.join(conditions)}")
    print(f"  QA model: {qa_model}")
    print(f"  Judge model: {judge_model}")
    print(f"{'='*60}\n")

    instances = adapter.load_dataset(str(cache_dir))

    # Flatten questions
    all_questions = []
    for inst in instances:
        for q in inst.questions:
            all_questions.append((inst, q))

    if subset:
        if stratified:
            # Take equal samples from each question category
            from collections import defaultdict
            by_cat: dict[str, list] = defaultdict(list)
            for pair in all_questions:
                by_cat[pair[1].category].append(pair)
            per_cat = max(1, subset // len(by_cat))
            sampled = []
            for cat in sorted(by_cat):
                sampled.extend(by_cat[cat][:per_cat])
            all_questions = sampled[:subset]
        else:
            all_questions = all_questions[:subset]

    total = len(all_questions)
    print(f"[runner] evaluating {total} questions\n")

    # Resume support
    resume_path = output_dir / f"{benchmark_name}_progress.jsonl"
    completed = _load_resume(resume_path) if resume else {}
    output_dir.mkdir(parents=True, exist_ok=True)

    # Track ingested instances
    instance_dbs: dict[str, Path | None] = {}
    instance_docs: dict[str, str] = {}

    details: list[dict] = []

    for idx, (inst, question) in enumerate(all_questions):
        qid = question.id

        # Skip if already done (with all conditions scored)
        if qid in completed:
            prev = completed[qid]
            all_scored = all(
                prev.get("answers", {}).get(c, {}).get("score") is not None
                for c in conditions
            )
            if all_scored:
                details.append(prev)
                continue
            # Otherwise re-run this question (previous attempt had failures)

        print(f"[{idx+1}/{total}] {qid} [{question.category}]")

        # Ingest instance if not done yet
        if inst.id not in instance_dbs:
            if "sinain-memory" in conditions or "knowledge-doc" in conditions:
                print(f"  ingesting {inst.id} ({len(inst.sessions)} sessions)...")
                instance_dbs[inst.id] = ingest_instance(inst, cache_dir / benchmark_name)
                db = instance_dbs[inst.id]
                if db:
                    instance_docs[inst.id] = get_knowledge_doc(db)
                    print(f"  -> ingested ({db.stat().st_size} bytes)")
                else:
                    instance_docs[inst.id] = "(ingestion failed)"
                    print(f"  -> ingestion failed")
            else:
                instance_dbs[inst.id] = None
                instance_docs[inst.id] = ""

        db_path = instance_dbs.get(inst.id)
        knowledge_doc = instance_docs.get(inst.id, "")
        full_context = adapter.format_full_context(inst)

        # Retrieval metrics (content-based: do retrieved facts contain the answer?)
        retrieval = {}
        if db_path and "sinain-memory" in conditions:
            retrieved_facts = _get_retrieved_facts(str(db_path), question.text)
            retrieval = compute_content_recall(
                retrieved_facts, question.gold_answer,
            )

        # Generate answers per condition
        answers = {}
        for cond in conditions:
            if skip_llm:
                answers[cond] = {"text": "(skipped)", "score": None, "f1": None}
                continue

            # Skip sinain-memory/knowledge-doc if ingestion failed
            if cond in ("sinain-memory", "knowledge-doc") and not db_path:
                answers[cond] = {"text": "(ingestion failed)", "score": 1, "f1": 0.0, "reasoning": "ingestion failed"}
                print(f"  [{cond}] skipped (ingestion failed)")
                continue

            print(f"  [{cond}] generating answer...")
            answer_text = answer_question(
                question, cond,
                db_path=str(db_path) if db_path else None,
                full_context=full_context,
                knowledge_doc=knowledge_doc,
                model=qa_model,
            )

            # Score
            f1 = token_f1(answer_text, question.gold_answer)

            judge_result = judge_qa(
                question.text, question.gold_answer, answer_text,
                condition=cond, model=judge_model,
            )
            score = judge_result["score"] if judge_result else None
            reasoning = judge_result["reasoning"] if judge_result else None

            answers[cond] = {
                "text": answer_text[:500],
                "score": score,
                "f1": round(f1, 4),
                "reasoning": reasoning,
            }
            print(f"    score={score}/5 f1={f1:.2f}")

        entry = {
            "id": qid,
            "question": question.text,
            "gold_answer": question.gold_answer,
            "category": question.category,
            "retrieval": retrieval,
            "answers": answers,
        }
        details.append(entry)

        # Save progress incrementally
        with open(resume_path, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    # Aggregate
    summary = aggregate_results(details)
    return summary, details


def main() -> None:
    parser = argparse.ArgumentParser(description="Sinain Knowledge Graph Benchmark Runner")
    parser.add_argument("--benchmarks", default="longmemeval",
                        help="Comma-separated benchmark names (longmemeval, locomo)")
    parser.add_argument("--conditions", default="sinain-memory,full-context,knowledge-doc",
                        help="Comma-separated conditions to evaluate")
    parser.add_argument("--subset", type=int, default=None,
                        help="Run only first N questions (for dev iteration)")
    parser.add_argument("--qa-model", default=QA_MODEL, help="Model for QA generation")
    parser.add_argument("--judge-model", default=JUDGE_MODEL, help="Model for QA judging")
    parser.add_argument("--output-dir", type=Path, default=RESULTS_DIR)
    parser.add_argument("--cache-dir", type=Path, default=DATA_DIR)
    parser.add_argument("--format", default="json,markdown",
                        help="Output formats (json, markdown)")
    parser.add_argument("--resume", action="store_true", help="Resume from partial results")
    parser.add_argument("--skip-llm", action="store_true",
                        help="Skip LLM calls (retrieval + mechanical metrics only)")
    parser.add_argument("--stratified", action="store_true",
                        help="Sample equally from each question category (with --subset)")
    args = parser.parse_args()

    conditions = [c.strip() for c in args.conditions.split(",")]
    formats = [f.strip() for f in args.format.split(",")]

    for bench_name in args.benchmarks.split(","):
        bench_name = bench_name.strip()
        summary, details = run_benchmark(
            bench_name, conditions,
            subset=args.subset,
            qa_model=args.qa_model,
            judge_model=args.judge_model,
            output_dir=args.output_dir,
            cache_dir=args.cache_dir,
            resume=args.resume,
            skip_llm=args.skip_llm,
            stratified=args.stratified,
        )

        # Write outputs
        args.output_dir.mkdir(parents=True, exist_ok=True)

        if "json" in formats:
            json_path = args.output_dir / f"{bench_name}_results.json"
            json_path.write_text(generate_json(bench_name, summary, details))
            print(f"\n[output] JSON: {json_path}")

        if "markdown" in formats:
            md_path = args.output_dir / f"{bench_name}_results.md"
            md_path.write_text(generate_markdown(bench_name, summary, details))
            print(f"[output] Markdown: {md_path}")

        # Print summary
        print(f"\n{'='*60}")
        print(f"  {bench_name} — Summary")
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
