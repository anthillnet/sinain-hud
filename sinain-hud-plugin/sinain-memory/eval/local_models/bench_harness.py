"""Pluggable model-adapter bench harness for Phase A of the v2 memory redesign.

Iterates over **model candidates** (third axis on top of conditions and profiles
in the existing benchmark runner) and dispatches each candidate to both eval
surfaces: public LongMemEval-S (`bench_longmemeval.py`) and private internal
media (`bench_media.py`).

Per BLOCKING CONSTRAINT 2 in the phase plan, every bench run records the full
methodology stack (model, prompt version, temperature, dataset version, n) so
results from different runs are only compared when the stack matches.

Usage (post-implementation):
    python3 -m eval.local_models.bench_harness --list-models
    python3 -m eval.local_models.bench_harness --layer l3 --surface longmemeval
    python3 -m eval.local_models.bench_harness --layer l2 --surface media --candidate gemma-4-e4b-it

Status: SCAFFOLD — model registry + CLI shape are in place. Actual model-swap
logic (loading Gemma 4 via MLX, swapping the distiller's model env var, etc.)
is TODO and lands in the first 12-A-PLAN.md task.
"""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Literal


Layer = Literal["l2", "l3"]
Surface = Literal["longmemeval", "media", "vision"]


@dataclass(frozen=True)
class ModelCandidate:
    """A single candidate model for one architecture layer.

    The methodology fields (`prompt_version`, `temperature`) flow through to the
    result record so every score is comparable only to others with the same stack.

    `openrouter_id` is set when the model is benchable today via OpenRouter
    (matches the v2 design's "cloud-coequal" path). Local-only candidates
    (runtime="mlx" or "ollama") have `openrouter_id=None` and will raise a
    clear "needs Ollama routing" error until Phase B lands that integration.
    """

    name: str
    layer: Layer
    size_gb: float
    license: str
    runtime: Literal["mlx", "ollama", "openrouter"]
    prompt_version: str
    temperature: float = 0.0
    openrouter_id: str | None = None
    ollama_id: str | None = None  # full tag including `ollama/` prefix, e.g. `ollama/qwen2.5:7b`
    notes: str = ""


# Initial registry from docs/memory-v2-local-first.md § "Model choices (May 2026)".
# Mistral Small 4 specs unverified as of plan date — held back from registry
# until verified against the official Mistral changelog (see Open Questions).
#
# Cloud baselines are included on purpose: they (a) prove the harness end-to-end
# before Ollama routing lands, and (b) give us the "cloud-coequal" baseline the
# v2 design positions local models against. Per BLOCKING CONSTRAINT 2, scores
# from cloud baselines and local candidates are comparable only when the
# methodology stack matches (judge, rubric, temperature, dataset version).
DEFAULT_CANDIDATES: list[ModelCandidate] = [
    # --- L3 cloud baselines (runnable today via OpenRouter) ---
    ModelCandidate(
        name="gemini-2.5-flash-lite",
        layer="l3",
        size_gb=0.0,  # cloud — N/A
        license="proprietary",
        runtime="openrouter",
        prompt_version="v1",
        openrouter_id="google/gemini-2.5-flash-lite",
        notes="Cloud baseline (current production default); reference point for local candidates",
    ),
    ModelCandidate(
        name="gemini-2.5-flash",
        layer="l3",
        size_gb=0.0,
        license="proprietary",
        runtime="openrouter",
        prompt_version="v1",
        openrouter_id="google/gemini-2.5-flash",
        notes="Cloud baseline (smart tier); upper bound for cheap-cloud distillation quality",
    ),
    # --- L2 specialist candidates (DEPRECATED by 2026-05-17 unified-architecture revision) ---
    # Kept in registry for documentation: these were the original v2 specialist
    # picks for L2 vision before the architecture pivoted to unified default.
    # Reactivate if Phase A bench data shows unified models miss the quality bar.
    ModelCandidate(
        name="gemma-4-e4b-it",
        layer="l2",
        size_gb=3.5,
        license="gemma-terms",
        runtime="mlx",
        prompt_version="v1",
        openrouter_id=None,
        ollama_id=None,
        notes="DEPRECATED (2026-05-17): superseded by unified-track candidates. "
              "Was original design-doc default for specialized L2; MLX-native. "
              "Kept as documentation; reactivate only if unified track misses quality bar.",
    ),
    ModelCandidate(
        name="qwen3-vl-4b",
        layer="l2",
        size_gb=4.0,
        license="apache-2.0",
        runtime="mlx",
        prompt_version="v1",
        openrouter_id=None,
        ollama_id=None,
        notes="DEPRECATED (2026-05-17): superseded by unified-track candidates. "
              "Was alternative specialized-L2 pick.",
    ),
    # --- L3 specialist-challenger candidates ---
    # Per 2026-05-17 architecture revision, the default v2 architecture is unified
    # (single multimodal model serves L2+L3+L4). These specialists are kept as the
    # "challenger track": only revisited if unified track misses the quality bar.
    ModelCandidate(
        name="qwen3.5-9b-instruct",
        layer="l3",
        size_gb=5.2,
        license="apache-2.0",
        runtime="ollama",
        prompt_version="v1",
        openrouter_id=None,
        ollama_id=None,
        notes="DEPRECATED (2026-05-17): was original design-doc specialist L3 target. "
              "Qwen 3.5 not on Ollama as of May 2026. Use qwen2.5-7b as text-only "
              "challenger if unified track misses bar.",
    ),
    ModelCandidate(
        name="qwen2.5-7b",
        layer="l3",
        size_gb=4.7,
        license="apache-2.0",
        runtime="ollama",
        prompt_version="v1",
        openrouter_id=None,
        ollama_id="ollama/qwen2.5:7b",
        notes="CHALLENGER (specialist text-only). Originally Phase A's first real v2 L3 "
              "contender; now kept as the strongest text-specialist baseline if unified "
              "track misses quality bar. Direct pair with qwen2.5-vl-7b-unified isolates "
              "the cost/benefit of multimodality. Benched 2026-05-17: 0/3 on subset=3, "
              "1841s wall-clock — slower than expected on Apple Silicon.",
    ),
    ModelCandidate(
        name="llama3.1-8b-smoke",
        layer="l3",
        size_gb=4.7,
        license="llama-3-community",
        runtime="ollama",
        prompt_version="v1",
        openrouter_id=None,
        ollama_id="ollama/llama3.1:latest",
        notes="EXCEEDS 30s production timeout on batched 10-session distillation "
              "(verified 2026-05-17 — every call timed out). Kept in registry as "
              "documentation of the latency boundary; do not re-bench without a "
              "smaller batch size or async distillation architecture.",
    ),
    ModelCandidate(
        name="llama3.2-3b-smoke",
        layer="l3",
        size_gb=2.0,
        license="llama-3-community",
        runtime="ollama",
        prompt_version="v1",
        openrouter_id=None,
        ollama_id="ollama/llama3.2:3b",
        notes="ALSO EXCEEDS 30s production timeout on batched 10-session distillation "
              "(verified 2026-05-17). Smaller model didn't fix it — the bottleneck is "
              "prompt size (15000 chars/batch), not model parameter count. Phase A "
              "architectural finding: BATCH_SIZE=10 is cloud-tuned (minimize calls); "
              "local routing needs BATCH_SIZE=1-2 or async distillation. Do NOT bump "
              "the production timeout to mask this.",
    ),
    # --- Paranoid-mode incumbent (load-bearing baseline for current local users) ---
    # --- Unified-track candidates (default v2 architecture per 2026-05-17 revision) ---
    # One multimodal model serves L2 vision + L3 extraction + L4 consolidation.
    # See docs/memory-v2-local-first.md § "Model architecture" for why.
    ModelCandidate(
        name="llava-paranoid-incumbent",
        layer="l3",
        size_gb=4.7,
        license="llama-2-community",
        runtime="ollama",
        prompt_version="v1",
        openrouter_id=None,
        ollama_id="ollama/llava:latest",
        notes="UNIFIED-TRACK + PARANOID-MODE BASELINE: today's paranoid-mode local "
              "model AND a unified-architecture candidate (one model serves L2+L3+L4). "
              "Load-bearing baseline — v2 must not regress on this for current local users.",
    ),
    ModelCandidate(
        name="gemma4-e4b-unified",
        layer="l3",
        size_gb=9.6,
        license="gemma-terms",
        runtime="ollama",
        prompt_version="v1",
        openrouter_id=None,
        ollama_id="ollama/gemma4:e4b",
        notes="UNIFIED-TRACK: Gemma 4 E4B multimodal (vision + text). Already pulled. "
              "Larger than llava (9.6GB vs 4.7GB) but newer and likely stronger on both "
              "L2 OCR/scene and L3 JSON adherence.",
    ),
    ModelCandidate(
        name="llama3.2-vision-11b-unified",
        layer="l3",
        size_gb=8.0,
        license="llama-3-community",
        runtime="ollama",
        prompt_version="v1",
        openrouter_id=None,
        ollama_id="ollama/llama3.2-vision:11b",
        notes="UNIFIED-TRACK: Meta's multimodal — needs `ollama pull llama3.2-vision:11b`. "
              "Balanced size/quality position between llava and gemma4:e4b.",
    ),
    ModelCandidate(
        name="qwen2.5-vl-7b-unified",
        layer="l3",
        size_gb=8.0,
        license="apache-2.0",
        runtime="ollama",
        prompt_version="v1",
        openrouter_id=None,
        ollama_id="ollama/qwen2.5-vl:7b",
        notes="UNIFIED-TRACK: Qwen's multimodal — needs `ollama pull qwen2.5-vl:7b`. "
              "Apache 2.0 (cleanest licensing of the unified candidates). Direct "
              "comparison vs qwen2.5:7b (text-only) isolates the multimodality cost.",
    ),
    # Mistral Small 4 candidate intentionally omitted until specs verified.
]


@dataclass
class BenchResult:
    candidate: ModelCandidate
    surface: Surface
    score: dict  # surface-specific (LongMemEval IPR + raw accuracy, private-surface recall)
    latency_ms_p50: float | None
    latency_ms_p99: float | None
    notes: list[str] = field(default_factory=list)
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_jsonable(self) -> dict:
        return {
            "candidate": {
                "name": self.candidate.name,
                "layer": self.candidate.layer,
                "size_gb": self.candidate.size_gb,
                "license": self.candidate.license,
                "runtime": self.candidate.runtime,
                "prompt_version": self.candidate.prompt_version,
                "temperature": self.candidate.temperature,
            },
            "surface": self.surface,
            "score": self.score,
            "latency_ms_p50": self.latency_ms_p50,
            "latency_ms_p99": self.latency_ms_p99,
            "notes": self.notes,
            "timestamp": self.timestamp,
        }


PUBLIC_RESULTS_DIR = Path(__file__).resolve().parent / "results"
PRIVATE_RESULTS_DIR = Path(__file__).resolve().parents[4] / ".planning" / "eval-internal"


def _assert_private_dir_gitignored() -> None:
    """Refuse to write private-surface scores unless `.planning/eval-internal/` is gitignored.

    Defense-in-depth: `.planning/` is already gitignored, but explicit verification
    prevents accidents if commit_docs flips or someone tries `git add -f`. See
    BLOCKING CONSTRAINT 1 in the phase plan.
    """
    repo_root = Path(__file__).resolve().parents[4]
    gitignore = repo_root / ".gitignore"
    if not gitignore.exists():
        raise RuntimeError(
            f"Refusing to write private scores: .gitignore not found at {gitignore}"
        )
    text = gitignore.read_text()
    if ".planning/eval-internal/" not in text and ".planning/" not in text:
        raise RuntimeError(
            "Refusing to write private scores: neither '.planning/eval-internal/' "
            "nor '.planning/' is in .gitignore. Add it before running the private bench."
        )


def list_candidates(layer: Layer | None = None) -> list[ModelCandidate]:
    if layer is None:
        return list(DEFAULT_CANDIDATES)
    return [c for c in DEFAULT_CANDIDATES if c.layer == layer]


def run_bench(
    candidate: ModelCandidate,
    surface: Surface,
    *,
    subset: int | None = None,
    stratified: bool = False,
) -> BenchResult:
    """Dispatch a single (candidate, surface) bench run.

    Delegates to bench_longmemeval / bench_media. bench_longmemeval is real;
    bench_media is still a stub. Both share the same interface so this
    dispatcher stays stable.

    `stratified` applies only to bench_longmemeval (samples evenly across the
    9 LongMemEval categories instead of taking first-N).
    """
    if surface == "longmemeval":
        from eval.local_models import bench_longmemeval

        return bench_longmemeval.run(candidate, subset=subset, stratified=stratified)
    if surface == "media":
        _assert_private_dir_gitignored()
        from eval.local_models import bench_media

        return bench_media.run(candidate, subset=subset)
    if surface == "vision":
        from eval.local_models import bench_vision

        return bench_vision.run(candidate, subset=subset)
    raise ValueError(f"unknown surface: {surface}")


def write_result(result: BenchResult) -> Path:
    if result.surface == "longmemeval":
        target_dir = PUBLIC_RESULTS_DIR
    elif result.surface == "vision":
        target_dir = PUBLIC_RESULTS_DIR
    elif result.surface == "media":
        target_dir = PRIVATE_RESULTS_DIR
    else:
        raise ValueError(f"unknown surface: {result.surface}")
    target_dir.mkdir(parents=True, exist_ok=True)
    out_path = (
        target_dir
        / f"{result.candidate.name}__{result.surface}__{result.timestamp.replace(':', '-')}.json"
    )
    out_path.write_text(json.dumps(result.to_jsonable(), indent=2, ensure_ascii=False))
    return out_path


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Phase A — local-model bench harness")
    parser.add_argument("--list-models", action="store_true")
    parser.add_argument("--layer", choices=["l2", "l3"], default=None)
    parser.add_argument("--surface", choices=["longmemeval", "media", "vision"], default=None)
    parser.add_argument(
        "--candidate", default=None,
        help="Specific candidate name; defaults to all candidates for --layer",
    )
    parser.add_argument(
        "--subset", type=int, default=None,
        help="Run on first N questions/segments only — for dev iteration",
    )
    parser.add_argument(
        "--stratified", action="store_true",
        help="With --subset, sample evenly across LongMemEval's 9 categories "
        "(applies to longmemeval surface only).",
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()

    if args.list_models:
        for c in list_candidates(args.layer):
            print(f"  [{c.layer}] {c.name}  ({c.size_gb} GB, {c.license}, {c.runtime})")
            if c.notes:
                print(f"      {c.notes}")
        return

    if args.surface is None or args.layer is None:
        raise SystemExit(
            "specify --surface (longmemeval|media|vision) and --layer (l2|l3) — "
            "or use --list-models to see the registry"
        )

    candidates = (
        [c for c in list_candidates(args.layer) if c.name == args.candidate]
        if args.candidate
        else list_candidates(args.layer)
    )
    if not candidates:
        raise SystemExit(f"no candidates match layer={args.layer} candidate={args.candidate}")

    for c in candidates:
        print(
            f"\n[bench] {c.name} on {args.surface} "
            f"(subset={args.subset}, stratified={args.stratified})"
        )
        result = run_bench(
            c, args.surface, subset=args.subset, stratified=args.stratified,
        )
        path = write_result(result)
        print(f"  -> wrote {path}")


if __name__ == "__main__":
    main()
