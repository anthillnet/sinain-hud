"""Public eval surface — LongMemEval-S 500 questions, paper-aligned judge.

This is the number sinain reports externally for comparisons against Hindsight,
Mem0, A-Mem, LangMem, etc. Methodology stack is documented per BLOCKING
CONSTRAINT 2 in the phase plan: GPT-4o judge, paper-aligned binary rubric,
deterministic QA (temperature=0).

Thin wrapper over `eval.benchmarks.runner.run_benchmark`. The bench harness is
responsible for picking a candidate; this module sets `SINAIN_BENCH_MODEL` so
the existing distiller hand-off in `eval/benchmarks/ingest.py:41-42` forwards
the model down to the subprocess, where `common._resolve_model` honors it.

Local-only candidates (runtime != "openrouter" and openrouter_id is None) raise
a clear error — they need the Ollama routing that lands in Phase A.2.
"""

from __future__ import annotations

import os
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from eval.local_models.bench_harness import BenchResult, ModelCandidate


class LocalRoutingNotImplemented(RuntimeError):
    """Raised when a candidate has no runnable routing (no openrouter_id and no ollama_id)."""


def _resolve_candidate_model_id(candidate: "ModelCandidate") -> str:
    """Pick the model ID string to inject into SINAIN_BENCH_MODEL.

    Precedence:
      - `openrouter_id` (cloud route via OpenRouter) — used when set
      - `ollama_id` (local route via Ollama, must include `ollama/` prefix) — used
        when openrouter_id absent. common.call_llm sees the prefix and dispatches
        to http://localhost:11434 instead of OpenRouter.

    Raises LocalRoutingNotImplemented if neither is set (e.g., MLX-only candidate
    before MLX integration lands).
    """
    if candidate.openrouter_id:
        return candidate.openrouter_id
    if candidate.ollama_id:
        return candidate.ollama_id
    raise LocalRoutingNotImplemented(
        f"Candidate '{candidate.name}' (runtime={candidate.runtime}) has no "
        f"routable model ID. Set openrouter_id (cloud) or ollama_id (local, "
        f"`ollama/<tag>`) on the registry entry. MLX-only routing is Phase A.3."
    )


def _apply_candidate_env(
    candidate: "ModelCandidate",
    ablate: str = "none",
    ablate_mode: str = "passthrough",
) -> dict[str, str | None]:
    """Set process env so the distiller subprocess routes to `candidate`.

    Returns prior values so the caller can restore them. The model ID is
    forwarded across the subprocess boundary via SINAIN_BENCH_MODEL
    (ingest.py:41-42 → SINAIN_FAST_MODEL); common._resolve_model honors the
    override; common.call_llm dispatches to OpenRouter or Ollama based on
    whether the resolved model starts with `ollama/`.

    Note: the production `DISTILLER_TIMEOUT_S=30` cap is intentionally kept
    in place. If a candidate can't distill a 10-session batch in 30s on local
    inference, that's a real signal for Phase A — production sinain v2 with
    the same model + same batching would face the same constraint. Pick a
    smaller model, shrink the batch size, or move distillation async; do NOT
    silently bump the production timeout to hide it.
    """
    model_id = _resolve_candidate_model_id(candidate)
    prior: dict[str, str | None] = {
        "SINAIN_BENCH_MODEL": os.environ.get("SINAIN_BENCH_MODEL"),
        "SINAIN_FAST_MODEL": os.environ.get("SINAIN_FAST_MODEL"),
        "SINAIN_ABLATE": os.environ.get("SINAIN_ABLATE"),
        "SINAIN_ABLATE_MODE": os.environ.get("SINAIN_ABLATE_MODE"),
    }
    os.environ["SINAIN_BENCH_MODEL"] = model_id
    os.environ["SINAIN_FAST_MODEL"] = model_id
    os.environ["SINAIN_ABLATE"] = ablate
    os.environ["SINAIN_ABLATE_MODE"] = ablate_mode
    return prior


def _restore_env(prior: dict[str, str | None]) -> None:
    for k, v in prior.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def run(
    candidate: "ModelCandidate",
    *,
    subset: int | None = None,
    stratified: bool = False,
    ablate: str = "none",
    ablate_mode: str = "passthrough",
    judge_mode: str = "paper",
) -> "BenchResult":
    """Run LongMemEval-S for `candidate`. Result is suitable for public publication.

    Methodology stack (recorded in every result):
      - judge: openai/gpt-4o (paper-aligned binary rubric)
      - qa: google/gemini-2.5-flash (existing benchmark default; unchanged
        across candidates so the L3 swap is the only varied axis)
      - qa_temperature: 0.0
      - dataset: longmemeval-s
      - subset: None = full 500, or first N (dev iteration). With stratified=True
        the subset is sampled evenly across the 9 LongMemEval question categories
        instead of taking first-N (which biases toward single-session-user).
    """
    from eval.local_models.bench_harness import BenchResult

    prior = _apply_candidate_env(candidate, ablate=ablate, ablate_mode=ablate_mode)
    started = time.monotonic()
    try:
        # Import is in-function so module load doesn't drag in the runner.
        from eval.benchmarks.runner import run_benchmark
        from eval.benchmarks.config import QA_MODEL, JUDGE_MODEL

        summary, details = run_benchmark(
            "longmemeval",
            conditions=["sinain-memory"],
            subset=subset,
            qa_model=QA_MODEL,
            judge_model=JUDGE_MODEL,
            judge_mode=judge_mode,
            ablate=ablate,
            ablate_mode=ablate_mode,
            profile="eval",
            stratified=stratified,
        )
    finally:
        elapsed_s = time.monotonic() - started
        _restore_env(prior)

    sinain = (summary.get("conditions") or {}).get("sinain-memory", {})
    n = sinain.get("n") or len(details)

    # Paper-aligned binary: score==5 counts as correct. Only questions that
    # actually got a judge score count toward accuracy — "judge failed" is
    # distinct from "judge scored wrong" so a 402/timeout doesn't fake a 0%.
    judged = [
        d for d in details
        if d.get("answers", {}).get("sinain-memory", {}).get("score") is not None
    ]
    raw_accuracy = None
    if judged:
        correct = sum(1 for d in judged if d["answers"]["sinain-memory"]["score"] == 5)
        raw_accuracy = correct / len(judged)

    per_category: dict[str, dict[str, float | int | None]] = {}
    for d in details:
        cat = d.get("category", "unknown")
        bucket = per_category.setdefault(cat, {"n": 0, "judged": 0, "correct": 0})
        bucket["n"] += 1
        score = d.get("answers", {}).get("sinain-memory", {}).get("score")
        if score is not None:
            bucket["judged"] += 1
            if score == 5:
                bucket["correct"] += 1
    for cat, bucket in per_category.items():
        bucket["accuracy"] = (
            (bucket["correct"] / bucket["judged"]) if bucket["judged"] else None
        )

    return BenchResult(
        candidate=candidate,
        surface="longmemeval",
        score={
            "raw_accuracy": raw_accuracy,
            "mean_judge_score": sinain.get("mean_score"),
            "ipr": summary.get("ipr"),
            "per_category": per_category,
            "n": n,
            "methodology": {
                "judge_model": JUDGE_MODEL,
                "judge_rubric": "paper-aligned-binary (score==5 → correct)",
                "qa_model": QA_MODEL,
                "qa_temperature": 0.0,
                "dataset_version": "longmemeval-s",
                "subset": subset,
                "stratified": stratified,
                "distiller_model_override_env": "SINAIN_BENCH_MODEL",
                "ablate": ablate,
                "ablate_mode": ablate_mode,
                "judge_mode": judge_mode,
            },
        },
        latency_ms_p50=None,  # per-question latencies live in details; aggregate is wall-clock-only for now
        latency_ms_p99=None,
        notes=[
            f"wall-clock seconds: {elapsed_s:.1f}",
            f"distiller routed to {_resolve_candidate_model_id(candidate)}",
        ],
    )
