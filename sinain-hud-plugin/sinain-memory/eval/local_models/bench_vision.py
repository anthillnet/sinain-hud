"""L2 vision bench surface — Ollama vision endpoint via the existing routing.

Per candidate, for each image in `vision_dataset/`:
  1. Encode image and send to candidate via OllamaVision (sense_client's native
     Ollama /api/chat client — already handles base64 encoding, resize, JPEG
     conversion, timeout, availability checks).
  2. Capture model output + per-image latency.
  3. Judge by sending (image, candidate's output) to gpt-4o-vision via
     OpenRouter, prompting it to score 1-5 for accuracy + completeness.
  4. Aggregate into a BenchResult comparable to the LongMemEval-S surface.

This is the L2 layer for the v2 unified-architecture bench: every unified
candidate (llava, gemma4:e4b, llama3.2-vision, qwen2.5-vl) runs on BOTH this
surface and the L3 LongMemEval surface. The winner is the candidate that
clears the quality bar on both layers with one model loaded.

Status: scaffold + smoke. The vision dataset starts as a one-image seed
(`~/.sinain/capture/frame.jpg` if present) — bench output is per-image so
adding more images later is additive, not a methodology change.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from eval.local_models.bench_harness import BenchResult, ModelCandidate


VISION_DATASET_DIR = Path(__file__).resolve().parent / "vision_dataset"

# Judge prompt — scores how well the candidate's description matches what's
# actually in the image. Returns a single integer 1-5 to stay parseable.
JUDGE_SYSTEM = (
    "You are a vision-eval judge. The user provides an image and a candidate "
    "model's description of that image. Score the description on accuracy AND "
    "completeness using this 5-point rubric:\n"
    "  5 = fully accurate, captures all major UI elements + visible text + context\n"
    "  4 = mostly accurate, missing one or two notable details\n"
    "  3 = partially accurate, gets the gist but misses or misnames key items\n"
    "  2 = mostly wrong, occasional accurate detail\n"
    "  1 = completely wrong, hallucinated, or empty\n"
    "Respond with ONLY a single integer 1-5 — nothing else, no explanation."
)
# Vision judge — image + candidate output → integer 1-5. Kept separate from
# the text-only JUDGE_MODEL in eval/benchmarks/config.py because vision input
# needs a multimodal judge. Update this constant if a cheaper vision judge
# proves equally accurate.
JUDGE_MODEL = "deepseek/deepseek-v4-flash"


class VisionRoutingNotImplemented(RuntimeError):
    """Raised when a candidate has no Ollama-routable model ID for vision."""


def _resolve_candidate_model_tag(candidate: "ModelCandidate") -> str:
    """Get the Ollama tag (without `ollama/` prefix) for OllamaVision.

    OllamaVision takes the bare model name (e.g. `llava:latest`), not the
    prefixed routing form. We strip the prefix the harness uses for text
    routing in common.call_llm.
    """
    if not candidate.ollama_id:
        raise VisionRoutingNotImplemented(
            f"Candidate '{candidate.name}' has no ollama_id. Vision bench is "
            "Ollama-only today (cloud vision bench is a separate surface, TBD)."
        )
    return candidate.ollama_id.removeprefix("ollama/")


def _load_dataset() -> list[Path]:
    """Pick up every image file in vision_dataset/. Sorted for determinism."""
    if not VISION_DATASET_DIR.exists():
        return []
    return sorted(
        p for p in VISION_DATASET_DIR.iterdir()
        if p.is_file() and p.suffix.lower() in (".jpg", ".jpeg", ".png")
    )


def _judge_response(image_bytes: bytes, candidate_text: str) -> int | None:
    """Send (image, candidate output) to gpt-4o-vision; return integer score 1-5.

    Returns None on parse failure (judge gave non-integer or out-of-range).
    """
    # Path-hack so this module can be invoked from sinain-memory/
    # without requiring a wheel install.
    _scripts_dir = str(Path(__file__).resolve().parents[2])
    if _scripts_dir not in sys.path:
        sys.path.insert(0, _scripts_dir)
    from common import call_llm, LLMError  # noqa: E402

    user_prompt = (
        f"Candidate model description:\n\n{candidate_text}\n\n"
        "Score it 1-5 against the image."
    )
    try:
        raw = call_llm(
            JUDGE_SYSTEM,
            user_prompt,
            model=JUDGE_MODEL,
            max_tokens=8,
            temperature=0.0,
            images=[image_bytes],
        )
    except LLMError as e:
        print(f"[vision-judge] failed: {e}", file=sys.stderr)
        return None

    # Strict integer parse; some models add a trailing period or newline.
    cleaned = raw.strip().rstrip(".").strip()
    try:
        score = int(cleaned)
    except ValueError:
        # Last-ditch: pull the first digit 1-5
        for ch in cleaned:
            if ch in "12345":
                return int(ch)
        return None
    if 1 <= score <= 5:
        return score
    return None


def run(
    candidate: "ModelCandidate",
    *,
    subset: int | None = None,
    stratified: bool = False,  # accepted for interface symmetry; unused here
) -> "BenchResult":
    """Run the vision bench for `candidate`.

    Methodology stack (recorded in result):
      - candidate route: Ollama /api/chat via OllamaVision (native, not OpenAI-compat)
      - judge: openai/gpt-4o (vision-capable, paper-aligned shape: integer 1-5)
      - judge temperature: 0.0
      - dataset: vision_dataset/ (currently seed-only — see README in that dir)
    """
    from eval.local_models.bench_harness import BenchResult

    tag = _resolve_candidate_model_tag(candidate)

    # Import lazily so OllamaVision's PIL dependency isn't required to load this module.
    # parents: [0]local_models [1]eval [2]sinain-memory [3]sinain-hud-plugin [4]sinain-hud (project root)
    _project_root = str(Path(__file__).resolve().parents[4])
    if _project_root not in sys.path:
        sys.path.insert(0, _project_root)
    from sense_client.ollama_vision import OllamaVision
    from PIL import Image

    images = _load_dataset()
    if subset:
        images = images[:subset]

    if not images:
        return BenchResult(
            candidate=candidate,
            surface="vision",
            score={
                "_status": "no images in vision_dataset/ — add seed images to bench",
                "n": 0,
            },
            latency_ms_p50=None,
            latency_ms_p99=None,
            notes=[
                f"vision_dataset is empty: {VISION_DATASET_DIR}",
                "drop .jpg/.png files into the directory and re-run",
            ],
        )

    vision = OllamaVision(model=tag, timeout=120.0, max_tokens=300)
    if not vision.is_available():
        raise RuntimeError(
            "Ollama not reachable at http://localhost:11434 — start `ollama serve`"
        )

    per_image: list[dict] = []
    latencies_ms: list[float] = []
    scores: list[int] = []
    judge_failures = 0

    started = time.monotonic()
    for img_path in images:
        img_bytes = img_path.read_bytes()
        with Image.open(img_path) as pil_img:
            pil_img.load()
            t0 = time.monotonic()
            candidate_text = vision.describe(pil_img)
            elapsed_ms = (time.monotonic() - t0) * 1000.0

        latencies_ms.append(elapsed_ms)

        if candidate_text is None:
            per_image.append({
                "image": img_path.name,
                "text": None,
                "score": None,
                "latency_ms": elapsed_ms,
                "error": "OllamaVision returned None (timeout / unavailable)",
            })
            continue

        score = _judge_response(img_bytes, candidate_text)
        if score is None:
            judge_failures += 1
        else:
            scores.append(score)
        per_image.append({
            "image": img_path.name,
            "text": candidate_text[:400],
            "score": score,
            "latency_ms": elapsed_ms,
        })

    wall_clock_s = time.monotonic() - started
    mean_score = (sum(scores) / len(scores)) if scores else None
    raw_accuracy = (
        sum(1 for s in scores if s == 5) / len(scores)
    ) if scores else None

    def _percentile(vals: list[float], p: float) -> float | None:
        if not vals:
            return None
        s = sorted(vals)
        idx = max(0, min(len(s) - 1, int(round(p / 100.0 * (len(s) - 1)))))
        return s[idx]

    return BenchResult(
        candidate=candidate,
        surface="vision",
        score={
            "raw_accuracy": raw_accuracy,
            "mean_judge_score": round(mean_score, 4) if mean_score is not None else None,
            "n_images": len(images),
            "judged": len(scores),
            "judge_failures": judge_failures,
            "per_image": per_image,
            "methodology": {
                "judge_model": JUDGE_MODEL,
                "judge_rubric": "vision-accuracy-and-completeness-1-to-5",
                "judge_temperature": 0.0,
                "candidate_transport": "Ollama /api/chat via OllamaVision",
                "dataset_dir": str(VISION_DATASET_DIR),
                "subset": subset,
            },
        },
        latency_ms_p50=_percentile(latencies_ms, 50),
        latency_ms_p99=_percentile(latencies_ms, 99),
        notes=[
            f"wall-clock seconds: {wall_clock_s:.1f}",
            f"candidate routed to ollama tag {tag}",
        ],
    )
