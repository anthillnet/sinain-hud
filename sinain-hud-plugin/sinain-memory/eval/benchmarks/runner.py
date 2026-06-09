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
import os
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
    token_f1, aggregate_results, aggregate_paper_results,
)
from eval.benchmarks.judges.qa_judge import judge_qa
from eval.benchmarks.judges.longmemeval_judge import judge_paper
from eval.benchmarks.report import generate_markdown, generate_json


def _get_adapter(name: str) -> BenchmarkAdapter:
    if name == "longmemeval":
        return LongMemEvalAdapter()
    raise ValueError(f"Unknown benchmark: {name}. Available: longmemeval")


def _log_distillation_summary(db_path: Path, sample_n: int = 5) -> None:
    """Log fact count + sample values right after ingestion completes.

    Distinguishes "distiller produced atomic facts" from "distiller produced
    narratives" as the first thing you see when a bench finishes ingest —
    diagnoses regressions like phi4-mini under structured output where the
    schema fixed the *shape* but the BA-degree fact still didn't land.
    """
    import sys as _sys
    _sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
    try:
        from triplestore import TripleStore
        store = TripleStore(str(db_path))
        fact_ids = {eid for eid, _ in store.entities_with_attr("value") if eid.startswith("fact:")}
        sample = []
        for eid in list(fact_ids)[:sample_n]:
            attrs = store.entity(eid)
            val = attrs.get("value", [""])[0] if attrs.get("value") else ""
            ent = attrs.get("entity", [""])[0] if attrs.get("entity") else "?"
            sample.append(f"      [{ent}] {val[:140]}")
        store.close()
        # Path.stat().st_size on a directory returns inode size (not disk use);
        # log fact count instead — more informative for the RDF backend.
        print(f"  -> ingested: {len(fact_ids)} fact entities")
        if sample:
            print("     sample:")
            for line in sample:
                print(line)
    except Exception as e:
        print(f"  -> ingested (distillation-summary logging failed: {e})")


def _log_retrieval_diagnostics(
    question, retrieved_facts: list[dict], retrieval: dict, db_path
) -> "str | None":
    """Log top retrieved facts for the question. When content_recall@10 < 100%,
    additionally search the graph for facts containing gold-answer keywords —
    distinguishes "missing from graph" (distillation failure) from "buried"
    (retrieval failure).

    Returns the retrieval-side verdict for P0 failure-stage attribution:
    "retrieval_miss" | "stale_current" | "ambiguous" | "write_drop", or None
    when gold reached top-1 (no retrieval-stage failure to diagnose).
    """
    qid = getattr(question, "id", "?")
    cr1 = retrieval.get("content_recall@1", "?")
    cr10 = retrieval.get("content_recall@10", "?")
    print(f"  [retrieval] {qid}: content_recall@1={cr1} @10={cr10}, top facts:")
    for i, f in enumerate(retrieved_facts[:5]):
        val = (f.get("value", "") or "")[:140]
        ent = f.get("entity", f.get("entity_id", "?"))
        print(f"      {i+1}. [{ent}] {val}")
    # Distillation-vs-retrieval check fires when the gold answer didn't make
    # it to top-1 (@1<1.0). This captures both "fact missing" and "fact
    # present but outranked by a hallucinated alternative" — the latter was
    # phi4 q2's failure (Duration="approximately one hour" outranked the
    # 45-minute commute fact even though both were in top-10).
    try:
        cr1_val = float(cr1) if cr1 not in ("?", None) else 1.0
    except (ValueError, TypeError):
        cr1_val = 1.0
    if cr1_val < 1.0:
        return _grep_graph_for_keywords(question, db_path)
    return None


def _classify_failure_stage(
    retrieval: dict, retrieval_class: "str | None", sinain_answer: "dict | None"
) -> str:
    """P0 per-question failure-stage attribution. Combines the retrieval-side
    verdict (from _log_retrieval_diagnostics) with answer correctness to locate
    WHERE a multi-session question failed — the scoreboard the memory phases are
    measured against. Returns one of:
      ok | answer_side | retrieval_miss | stale_current | write_drop |
      ambiguous | unknown.
    """
    label = (sinain_answer or {}).get("paper_label")
    if label == 1:
        return "ok"
    # Answer wrong (or unscored): attribute the failing stage.
    try:
        cr1 = float(retrieval.get("content_recall@1", 0) or 0)
        cr10 = float(retrieval.get("content_recall@10", 0) or 0)
    except (TypeError, ValueError):
        cr1 = cr10 = 0.0
    # Gold reached top-1 yet the model still got it wrong -> answer-side
    # (synthesis / abstention / stale-pick), unless the graph copy is superseded
    # (then it's a stale-current problem even though it ranked).
    if cr1 >= 1.0:
        return "stale_current" if retrieval_class == "stale_current" else "answer_side"
    # Gold in graph (or in top-10) but mis-ranked -> retrieval miss.
    if retrieval_class in ("retrieval_miss", "stale_current"):
        return retrieval_class
    if cr10 >= 1.0:
        return "retrieval_miss"
    if retrieval_class in ("write_drop", "ambiguous"):
        return retrieval_class
    return "unknown"


def _grep_graph_for_keywords(question, db_path) -> "str | None":
    """Search the graph for facts containing gold-answer phrases / keywords.

    Phrase-first matching prevents the false-positive we saw with
    "Business Administration": single-keyword search hit 21 facts about
    "starting a business" (entrepreneurship), masking the real distillation
    gap. Phrase mode requires the multi-word gold phrase to appear as a
    substring; a fact like "starting own business venture" no longer matches
    "Business Administration" because the words aren't contiguous.

    Decision tree:
      1. If gold has 2+ words: require the gold-answer phrase (lowercased,
         whitespace-collapsed) as a contiguous substring of some fact.
      2. Else: require single-keyword match (legacy).
      3. Else: skip.

    Classification:
      - Phrase + keyword both miss → DISTILLATION GAP (fact missing).
      - Phrase miss but keyword hits → AMBIGUOUS (likely DISTILLATION GAP
        with overlapping vocabulary in unrelated facts; surfaced separately).
      - Phrase hits → RETRIEVAL GAP (fact present, ranker missed it).
    """
    import sys as _sys
    _sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
    try:
        from triplestore import TripleStore
        import re
        store = TripleStore(str(db_path))
        gold = (getattr(question, "gold_answer", "") or "").strip()
        if not gold:
            store.close()
            return None

        # Build the phrase candidates: full gold answer, plus contiguous
        # 2-3 word windows of content words (skips short/stop words).
        gold_lc = re.sub(r"\s+", " ", gold.lower()).strip()
        content_words = [w for w in re.findall(r"[a-z]{3,}", gold_lc)]
        # Phrase candidates: full gold, then sliding 3-grams, then 2-grams.
        phrase_candidates: list[str] = []
        if len(content_words) >= 2:
            phrase_candidates.append(" ".join(content_words))
            for n in (3, 2):
                for i in range(len(content_words) - n + 1):
                    p = " ".join(content_words[i:i + n])
                    if p not in phrase_candidates:
                        phrase_candidates.append(p)
        keyword_candidates = sorted(set(content_words), key=len, reverse=True)[:5]

        # Single-pass scan over all facts.
        phrase_hits: list[tuple[str, str, str, bool]] = []  # (matched_phrase, eid, value, superseded)
        keyword_hits: list[tuple[int, str, str]] = []  # (match_count, eid, value)
        for eid in {e for e, _ in store.entities_with_attr("value") if e.startswith("fact:")}:
            attrs = store.entity(eid)
            val_full = attrs.get("value", [""])[0] if attrs.get("value") else ""
            val_lc = re.sub(r"\s+", " ", val_full.lower())
            # Phrase pass — first match wins (we surface the longest phrase
            # since phrase_candidates is in length-desc order after gold).
            # A fact carrying ``valid_to`` is superseded (P0 stale-current signal):
            # the gold value IS in the graph but has been retracted as no-longer-current.
            for p in phrase_candidates:
                if p in val_lc:
                    superseded = bool(attrs.get("valid_to"))
                    phrase_hits.append((p, eid, val_full[:200], superseded))
                    break
            # Keyword pass — count distinct keywords matched.
            kw_matched = [k for k in keyword_candidates if k in val_lc]
            if kw_matched:
                keyword_hits.append((len(kw_matched), eid, val_full[:200]))
        store.close()

        if phrase_hits:
            # The gold fact IS in the graph. If every phrase-hit is superseded,
            # the failure is stale-current (the value exists but was retracted);
            # otherwise it's a ranking/retrieval miss.
            all_superseded = all(h[3] for h in phrase_hits)
            verdict = "stale_current" if all_superseded else "retrieval_miss"
            tag = "STALE-CURRENT" if all_superseded else "RETRIEVAL GAP"
            print(f"  [diagnostic] {tag} — graph contains {len(phrase_hits)} fact(s) "
                  f"with gold-phrase match (looked for {phrase_candidates[:3]!r}"
                  f"{', all superseded' if all_superseded else ''}); top:")
            for matched_phrase, eid, val, sup in phrase_hits[:3]:
                print(f"      {eid} [matched: {matched_phrase!r}{', superseded' if sup else ''}]: {val}")
            return verdict
        elif keyword_hits:
            # Common case for multi-word gold: scattered vocabulary in
            # semantically-unrelated facts. Mostly a distillation gap, but
            # report as AMBIGUOUS so the operator can verify by reading.
            keyword_hits.sort(key=lambda h: -h[0])
            print(f"  [diagnostic] AMBIGUOUS — no contiguous gold-phrase match, but "
                  f"{len(keyword_hits)} fact(s) contain individual gold keywords "
                  f"{keyword_candidates!r}. Most likely DISTILLATION GAP with overlapping "
                  "vocabulary. Top 3 keyword matches (verify by reading):")
            for _, eid, val in keyword_hits[:3]:
                print(f"      {eid}: {val}")
            return "ambiguous"
        else:
            print(f"  [diagnostic] DISTILLATION GAP — no facts contain gold keywords "
                  f"{keyword_candidates!r}; the answer never reached the graph. "
                  "Investigate distiller prompt / model.")
            return "write_drop"
    except Exception as e:
        print(f"  [diagnostic] graph keyword search failed: {e}")
        return None


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
    qids: list | None = None,
    offset: int = 0,
    qa_model: str = QA_MODEL,
    judge_model: str = JUDGE_MODEL,
    judge_mode: str = "paper",
    ablate: str = "none",
    ablate_mode: str = "passthrough",
    output_dir: Path = RESULTS_DIR,
    cache_dir: Path = DATA_DIR,
    resume: bool = False,
    skip_llm: bool = False,
    stratified: bool = False,
    profile: str | None = None,
) -> tuple[dict, list[dict]]:
    """Run a benchmark end-to-end. Returns (summary, details).

    profile: optional caller profile applied to sinain-memory retrieval.
        Lets a single benchmark run measure a specific caller shape.
    """

    adapter = _get_adapter(benchmark_name)

    # Load dataset
    print(f"\n{'='*60}")
    print(f"  Benchmark: {benchmark_name}")
    print(f"  Conditions: {', '.join(conditions)}")
    print(f"  Profile: {profile or '(default)'}")
    print(f"  QA model: {qa_model}")
    print(f"  Judge model: {judge_model}")
    print(f"{'='*60}\n")

    instances = adapter.load_dataset(str(cache_dir))

    # Flatten questions
    all_questions = []
    for inst in instances:
        for q in inst.questions:
            all_questions.append((inst, q))

    # Batch slicing (additive; offset=0 is a no-op). Questions load in deterministic dataset
    # order, so all_questions[offset:offset+subset] is a stable slice across runs — the basis
    # for batched full-500 evaluation (run_lme_batched.sh). Applied BEFORE stratified/subset so
    # a non-stratified batch is exactly the contiguous slice [offset : offset+subset].
    if offset:
        all_questions = all_questions[offset:]

    if qids:
        qset = {q.strip() for q in qids if q.strip()}
        all_questions = [(inst, q) for inst, q in all_questions if getattr(q, "id", None) in qset]
        print(f"[runner] --qids filter -> {len(all_questions)} questions", flush=True)

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
                    _log_distillation_summary(db)
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
        retrieved_facts: list[dict] = []
        retrieval_class: "str | None" = None
        if db_path and "sinain-memory" in conditions:
            retrieved_facts = _get_retrieved_facts(str(db_path), question.text, profile=profile)
            retrieval = compute_content_recall(
                retrieved_facts, question.gold_answer,
            )
            retrieval_class = _log_retrieval_diagnostics(question, retrieved_facts, retrieval, db_path)

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
            # Self-consistency voting (SINAIN_QA_VOTES, default 5). The QA model
            # (gemini-2.5-flash) is NOT deterministic even at temperature=0 +
            # seed (verified 2026-05-29 — provider ignores seed), so a single
            # answer makes n=6 paper_label deltas indistinguishable from jitter.
            # We sample k answers, judge each, and take the MAJORITY label; the
            # vote_split (incl. mean) is the real, comparison-stable signal.
            # k=1 reproduces the old single-shot behavior. Retrieval is computed
            # once above (deterministic) — only the QA+judge step is repeated.
            n_votes = max(1, int(os.environ.get("SINAIN_QA_VOTES", "5")))
            samples: list[tuple[str, float, object]] = []
            for _v in range(n_votes):
                a_text = answer_question(
                    question, cond,
                    db_path=str(db_path) if db_path else None,
                    full_context=full_context,
                    knowledge_doc=knowledge_doc,
                    model=qa_model,
                    profile=profile,
                )
                a_f1 = token_f1(a_text, question.gold_answer)
                if judge_mode == "paper":
                    lbl: object = 1 if judge_paper(
                        question_type=question.category,
                        question_id=question.id,
                        question=question.text,
                        gold=question.gold_answer,
                        response=a_text,
                    ) else 0
                else:
                    jr = judge_qa(
                        question.text, question.gold_answer, a_text,
                        condition=cond, model=judge_model,
                    )
                    lbl = jr["score"] if jr else None
                samples.append((a_text, a_f1, lbl))

            texts = [s[0] for s in samples]
            mean_f1 = round(sum(s[1] for s in samples) / len(samples), 4)
            ans_entry: dict = {"f1": mean_f1}

            if judge_mode == "paper":
                labels = [s[2] for s in samples if s[2] is not None]
                ones = sum(1 for x in labels if x == 1)
                # strict majority (tie → 0, conservative)
                maj = 1 if labels and ones * 2 > len(labels) else 0
                rep = next((t for t, _, x in samples if x == maj), texts[0])
                ans_entry["text"] = rep[:500]
                ans_entry["paper_label"] = maj
                ans_entry["score"] = None
                ans_entry["reasoning"] = None
                ans_entry["vote_split"] = {
                    "labels": labels, "ones": ones, "k": len(labels),
                    "mean": round(ones / len(labels), 3) if labels else None,
                }
                print(f"    paper_label={maj} ({ones}/{len(labels)}) f1={mean_f1:.2f}")
            else:
                nums = [x for x in (s[2] for s in samples) if isinstance(x, (int, float))]
                sc = round(sum(nums) / len(nums), 2) if nums else None
                ans_entry["text"] = texts[0][:500]
                ans_entry["score"] = sc
                ans_entry["reasoning"] = None
                ans_entry["vote_split"] = {"scores": nums, "k": len(nums), "mean": sc}
                print(f"    score={sc}/5 (k={len(nums)}) f1={mean_f1:.2f}")

            answers[cond] = ans_entry

        # P0 failure-stage attribution: WHERE did this question fail? (recorded
        # in retrieval.stage so the dashboard can slice category × stage.)
        if db_path and "sinain-memory" in conditions:
            if skip_llm:
                retrieval["stage"] = retrieval_class or ("retrieval_ok" if retrieval else None)
            else:
                retrieval["stage"] = _classify_failure_stage(
                    retrieval, retrieval_class, answers.get("sinain-memory")
                )

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

    # Aggregate (legacy 1-5 path always populated; paper-mode adds keys on top)
    summary = aggregate_results(details)
    if judge_mode == "paper":
        paper_summary = aggregate_paper_results(
            details,
            paper_label_key="paper_label",
            condition=conditions[0] if conditions else "sinain-memory",
        )
        summary.update(paper_summary)
        summary["judge_mode"] = "paper"

    # Paper-mode pins to longmemeval_judge.DEFAULT_JUDGE_MODEL (the paper's
    # exact judge) — keeps "paper" semantically pinned to LongMemEval reference
    # even if the legacy qa_judge default drifts.
    from eval.benchmarks.judges.longmemeval_judge import DEFAULT_JUDGE_MODEL as PAPER_JUDGE_MODEL
    summary["methodology"] = {
        **(summary.get("methodology") or {}),
        "judge_mode": judge_mode,
        "judge_model": (
            PAPER_JUDGE_MODEL if judge_mode == "paper" else judge_model
        ),
        "qa_model": qa_model,
        "ablate": ablate,
        "ablate_mode": ablate_mode,
        "profile": profile,
        "subset": subset,
        "stratified": stratified,
    }
    return summary, details


def main() -> None:
    parser = argparse.ArgumentParser(description="Sinain Knowledge Graph Benchmark Runner")
    parser.add_argument("--benchmarks", default="longmemeval",
                        help="Comma-separated benchmark names (longmemeval, locomo)")
    parser.add_argument("--conditions", default="sinain-memory,full-context,knowledge-doc",
                        help="Comma-separated conditions to evaluate")
    parser.add_argument("--offset", type=int, default=0,
                        help="Skip the first N questions (dataset order) before subset. Enables "
                             "batched full-500 eval: --offset 50 --subset 50 = slice [50:100].")
    parser.add_argument("--subset", type=int, default=None,
                        help="Run only first N questions (for dev iteration)")
    parser.add_argument("--qids", default=None,
                        help="Comma-separated question ids to run (targeted A/B); overrides subset selection")
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
    parser.add_argument(
        "--profile", default=None,
        choices=["agent-tick", "escalation", "mcp-default", "browse", "eval"],
        help="Named caller profile applied to sinain-memory retrieval.",
    )
    parser.add_argument(
        "--judge-mode",
        choices=["paper", "legacy"],
        default="paper",
        help="Judge protocol: 'paper' = binary per-question-type (EVAL-04 paper-comparable); "
             "'legacy' = 1-5 graded (acme IPR backward compat).",
    )
    parser.add_argument(
        "--ablate",
        choices=["none", "distiller", "integrator", "retrieval", "schema"],
        default="none",
        help="Subsystem to replace with deterministic stub (EVAL-01). 'schema' is "
             "reserved but deferred to Phase 5 (D-03).",
    )
    parser.add_argument(
        "--ablate-mode",
        choices=["passthrough", "oracle"],
        default="passthrough",
        help="Ablation flavor: 'passthrough' = no-op stub; 'oracle' = gold-derived perfect output.",
    )
    parser.add_argument(
        "--write-baseline",
        action="store_true",
        help="At end of run, write baseline doc to .planning/eval-internal/BASELINE-<date>.{md,json} (EVAL-04).",
    )
    args = parser.parse_args()

    import os
    # D-03 schema deferral — fail BEFORE any LLM cost is spent.
    if args.ablate == "schema":
        print(
            "[runner] ERROR: --ablate=schema deferred to Phase 5 (locked decision D-03, "
            "2026-05-26). Schema ablation requires both write and read paths to swap; "
            "no pluggable storage interface exists today. Reserved env-var route; not "
            "implemented in Phase 1.",
            file=sys.stderr,
        )
        sys.exit(2)

    # RESEARCH.md § Pitfall 2: subset without stratified biases categories.
    if args.subset and not args.stratified:
        print(
            "[runner] WARNING: --subset without --stratified may bias question_type "
            "distribution. Recommend --stratified for ablation runs.",
            file=sys.stderr,
        )

    conditions = [c.strip() for c in args.conditions.split(",")]
    formats = [f.strip() for f in args.format.split(",")]

    # Set SINAIN_ABLATE env so ingest.py + query.py + subprocess hand-offs see it.
    prior_ablate = os.environ.get("SINAIN_ABLATE")
    prior_ablate_mode = os.environ.get("SINAIN_ABLATE_MODE")
    os.environ["SINAIN_ABLATE"] = args.ablate
    os.environ["SINAIN_ABLATE_MODE"] = args.ablate_mode

    try:
        for bench_name in args.benchmarks.split(","):
            bench_name = bench_name.strip()
            summary, details = run_benchmark(
                bench_name, conditions,
                subset=args.subset,
                qids=(args.qids.split(",") if args.qids else None),
                offset=args.offset,
                qa_model=args.qa_model,
                judge_model=args.judge_model,
                judge_mode=args.judge_mode,
                ablate=args.ablate,
                ablate_mode=args.ablate_mode,
                output_dir=args.output_dir,
                cache_dir=args.cache_dir,
                resume=args.resume,
                skip_llm=args.skip_llm,
                stratified=args.stratified,
                profile=args.profile,
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

            # Optional milestone-reference baseline doc (EVAL-04)
            if args.write_baseline:
                from datetime import datetime
                from eval.benchmarks.ablation.variance_attribution import write_baseline
                date_str = datetime.utcnow().strftime("%Y-%m-%d")
                project_root = Path(__file__).resolve().parent.parent.parent.parent.parent
                out_dir = project_root / ".planning" / "eval-internal"
                out_dir.mkdir(parents=True, exist_ok=True)
                bl_md = out_dir / f"BASELINE-{date_str}.md"
                bl_json = out_dir / f"BASELINE-{date_str}.json"
                # Attach git provenance + n_questions if absent so the front-matter is complete.
                summary.setdefault("sinain_commit", _git_short_sha())
                summary.setdefault("sinain_branch", _git_branch_name())
                summary.setdefault("date_run", date_str)
                summary.setdefault("ablation", args.ablate)
                summary.setdefault("profile", args.profile or "eval")
                write_baseline(summary, bl_md, bl_json)
                print(f"[output] Baseline: {bl_md}")

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
            ov = summary.get("overall")
            if ov:
                print(f"  overall accuracy: {ov.get('accuracy', 0)*100:.1f}% "
                      f"[{ov.get('ci_low', 0)*100:.1f}%, {ov.get('ci_high', 0)*100:.1f}%] "
                      f"(n={ov.get('n', '?')})")
            print()
    finally:
        if prior_ablate is None:
            os.environ.pop("SINAIN_ABLATE", None)
        else:
            os.environ["SINAIN_ABLATE"] = prior_ablate
        if prior_ablate_mode is None:
            os.environ.pop("SINAIN_ABLATE_MODE", None)
        else:
            os.environ["SINAIN_ABLATE_MODE"] = prior_ablate_mode


def _git_short_sha() -> str:
    import subprocess
    try:
        r = subprocess.run(["git", "rev-parse", "--short", "HEAD"],
                           capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            return r.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return "unknown"


def _git_branch_name() -> str:
    import subprocess
    try:
        r = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"],
                           capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            return r.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return "unknown"


if __name__ == "__main__":
    main()
