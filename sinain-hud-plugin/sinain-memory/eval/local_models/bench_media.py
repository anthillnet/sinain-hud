"""Private eval surface — internal recorded media (CONFIDENTIAL).

⚠️  CONFIDENTIAL: the recording referenced by this module contains real business
context. All operator-machine paths are env-var-driven so no client-identifying
string lives in the source.

NEVER:
- Commit the recording, transcript, ground-truth set, or extracted facts to git
- Reference the recording or its content in public docs
- Cite numbers from this surface in external benchmark claims (LongMemEval-S is
  the external surface — see `bench_longmemeval.py`)
- Push `.planning/eval-internal/` to any remote

ALWAYS:
- Verify `.planning/eval-internal/` is gitignored before writing scores
  (`bench_harness._assert_private_dir_gitignored` enforces this)
- Keep numbers from this surface in operator-only narratives

## Implementation: video-replay → distillation → query-judge

Pipeline (in `run()`):
  1. Extract frames from video at fixed intervals (ffmpeg, default every 60s)
  2. Parse transcript file into time-aligned audio feed items
  3. OCR each frame via OllamaVision using the candidate model (skipped for
     text-only candidates with a logged note)
  4. Merge frames + transcript into one timeline, sorted by timestamp
  5. Split timeline into N-minute windows treated as "sessions" so the existing
     ingest_instance() can batch and distill them via the candidate model
  6. Load ~10 ground-truth queries from media-ground-truth.json
  7. For each query: retrieve facts, generate answer, judge via gpt-4o
  8. Aggregate to a BenchResult — pass/fail per query plus mean accuracy

Outcome 2 in the Phase B north star (meeting recall). See
`docs/memory-v2-local-first.md § "Phase B north star"`.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from eval.local_models.bench_harness import BenchResult, ModelCandidate


# Operator-machine paths — referenced only by env var.
MEDIA_VIDEO_ENV = "MEDIA_VIDEO_PATH"
MEDIA_TRANSCRIPT_ENV = "MEDIA_TRANSCRIPT_PATH"
DEFAULT_GROUND_TRUTH_PATH = (
    Path(__file__).resolve().parents[4]
    / ".planning" / "eval-internal" / "media-ground-truth.json"
)

# Frame sampling cadence and session-window size are tuned for meeting-class
# content (slow visual changes; speakers across minutes).
FRAME_SAMPLE_INTERVAL_S = 60       # one frame per minute
SESSION_WINDOW_S = 300              # 5-minute "sessions" for ingest batching


def _resolve_video_path() -> Path:
    raw = os.environ.get(MEDIA_VIDEO_ENV)
    if not raw:
        raise RuntimeError(
            f"Set {MEDIA_VIDEO_ENV} to the local recording path before running "
            "the private bench. (Path is operator-specific — never commit.)"
        )
    return Path(os.path.expanduser(raw))


def _resolve_transcript_path() -> Path:
    raw = os.environ.get(MEDIA_TRANSCRIPT_ENV)
    if not raw:
        raise RuntimeError(
            f"Set {MEDIA_TRANSCRIPT_ENV} to the local transcript path before "
            "running the private bench. (Path is operator-specific — never commit.)"
        )
    return Path(os.path.expanduser(raw))


def _load_ground_truth() -> dict:
    """Load query set + methodology notes from media-ground-truth.json.

    Schema:
      {
        "queries": [
          {"id": str, "question": str, "expected_answer": str,
           "category": "attribution|temporal|summary|recall"},
          ...
        ],
        "methodology_notes": str (optional, human-readable)
      }
    """
    if not DEFAULT_GROUND_TRUTH_PATH.exists():
        raise RuntimeError(
            f"Ground-truth set missing: {DEFAULT_GROUND_TRUTH_PATH}. "
            "Author it before running the private bench. See "
            "bench_media._scaffold_ground_truth_template() for the schema."
        )
    return json.loads(DEFAULT_GROUND_TRUTH_PATH.read_text())


# ----------------------------------------------------------------------
# Video frame extraction (ffmpeg)
# ----------------------------------------------------------------------

def _extract_frames(video: Path, interval_s: int = FRAME_SAMPLE_INTERVAL_S) -> list[tuple[float, Path]]:
    """Sample frames from `video` at `interval_s` seconds. Returns list of (ts_s, jpg_path).

    Frames land in a temp directory; caller is responsible for cleanup.
    """
    tmp = Path(tempfile.mkdtemp(prefix="sinain-bench-frames-"))
    out_pattern = str(tmp / "frame_%05d.jpg")
    # `-vf fps=1/N` samples one frame every N seconds.
    cmd = [
        "ffmpeg", "-loglevel", "error", "-y",
        "-i", str(video),
        "-vf", f"fps=1/{interval_s}",
        "-q:v", "3",
        out_pattern,
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    frames: list[tuple[float, Path]] = []
    for p in sorted(tmp.iterdir()):
        # filename "frame_00001.jpg" → index 1 → ts = (1 - 1) * interval = 0
        m = re.match(r"frame_(\d+)\.jpg", p.name)
        if not m:
            continue
        idx = int(m.group(1))
        ts_s = (idx - 1) * interval_s
        frames.append((float(ts_s), p))
    return frames


# ----------------------------------------------------------------------
# Transcript parsing
# ----------------------------------------------------------------------

# Supported timestamp formats:
#   ResearchOps SpeechKit:   "[#525506 | 00:00:00] SPEAKER_01: text"
#   bracketed:               "[00:01:23] speaker: text"  /  "[01:23] speaker: text"
#   plain:                   "00:01:23 speaker: text"   /  "01:23 - speaker: text"
_TS_PATTERNS = [
    # ResearchOps SpeechKit — [#segmentId | HH:MM:SS] SPEAKER_NN: text
    re.compile(r"^\[#\d+\s*\|\s*(\d{1,2}):(\d{2}):(\d{2})\]\s*([\w_]+):\s*(.*)$"),
    # bracketed HH:MM:SS
    re.compile(r"^\[(\d{1,2}):(\d{2}):(\d{2})\]\s*[-:]?\s*(?:([\w][\w\s]*?):\s*)?(.*)$"),
    # bracketed MM:SS
    re.compile(r"^\[(\d{1,2}):(\d{2})\]\s*[-:]?\s*(?:([\w][\w\s]*?):\s*)?(.*)$"),
    # plain HH:MM:SS
    re.compile(r"^(\d{1,2}):(\d{2}):(\d{2})\s*[-:]?\s*(?:([\w][\w\s]*?):\s*)?(.*)$"),
    # plain MM:SS
    re.compile(r"^(\d{1,2}):(\d{2})\s*[-:]?\s*(?:([\w][\w\s]*?):\s*)?(.*)$"),
]


def _parse_transcript(path: Path) -> list[dict]:
    """Parse a transcript file into FeedItem-shaped dicts {ts, source, text}.

    Permissive: supports ResearchOps SpeechKit + several bracketed/plain
    timestamp formats. Lines without a parseable timestamp are appended to the
    previous line's text (so multi-line speaker turns aren't dropped). Lines
    starting with `#` are treated as headers and skipped.
    """
    lines = path.read_text(encoding="utf-8").splitlines()
    items: list[dict] = []
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        matched = False
        for pat in _TS_PATTERNS:
            m = pat.match(line)
            if not m:
                continue
            groups = m.groups()
            if len(groups) == 5:  # HH:MM:SS variants
                hh, mm, ss, speaker, text = groups
                ts_s = int(hh) * 3600 + int(mm) * 60 + int(ss)
            else:  # MM:SS variants
                mm, ss, speaker, text = groups
                ts_s = int(mm) * 60 + int(ss)
            speaker = (speaker or "speaker").strip()
            text = (text or "").strip()
            if not text:
                # Only timestamp + speaker on this line — wait for continuation
                continue
            items.append({
                "ts": float(ts_s),
                "source": f"audio:{speaker.lower().replace(' ', '_')}",
                "text": text,
            })
            matched = True
            break
        if not matched and items:
            # Append to previous turn — multi-line speaker text
            items[-1]["text"] = (items[-1]["text"] + " " + line).strip()
    return items


# ----------------------------------------------------------------------
# Frame OCR via OllamaVision (only for vision-capable candidates)
# ----------------------------------------------------------------------

def _ocr_frames(candidate: "ModelCandidate", frames: list[tuple[float, Path]]) -> list[dict]:
    """OCR every frame using the candidate's Ollama tag. Returns FeedItem dicts.

    Returns an empty list (with a warning) if the candidate has no ollama_id
    (text-only specialist). The bench still runs on transcript-only signal.
    """
    if not candidate.ollama_id:
        print(
            f"[bench_media] candidate '{candidate.name}' has no ollama_id; "
            "skipping vision OCR — bench runs on transcript only.",
            file=sys.stderr,
        )
        return []

    _project_root = str(Path(__file__).resolve().parents[4])
    if _project_root not in sys.path:
        sys.path.insert(0, _project_root)
    from sense_client.ollama_vision import OllamaVision
    from PIL import Image

    tag = candidate.ollama_id.removeprefix("ollama/")
    vision = OllamaVision(model=tag, timeout=120.0, max_tokens=300)
    if not vision.is_available():
        print("[bench_media] Ollama not reachable; skipping OCR.", file=sys.stderr)
        return []

    items: list[dict] = []
    for ts_s, frame_path in frames:
        try:
            with Image.open(frame_path) as img:
                img.load()
                text = vision.describe(
                    img,
                    "Describe this screen frame: what application is visible, what UI "
                    "elements are shown, and any text you can read. Be specific about "
                    "names, file paths, and any structured content. 2-4 sentences.",
                )
        except Exception as e:
            print(f"[bench_media] OCR failed for frame at {ts_s}s: {e}", file=sys.stderr)
            text = None
        if text:
            items.append({
                "ts": float(ts_s),
                "source": "screen:ocr",
                "text": text,
            })
    return items


# ----------------------------------------------------------------------
# Timeline → BenchmarkInstance for existing ingest path
# ----------------------------------------------------------------------

def _split_into_sessions(
    timeline: list[dict],
    window_s: int = SESSION_WINDOW_S,
) -> list[list[dict]]:
    """Group timeline items into time-window 'sessions' so ingest_instance
    can batch them via the production distiller subprocess.
    """
    if not timeline:
        return []
    sessions: list[list[dict]] = []
    current: list[dict] = []
    window_start = timeline[0]["ts"]
    for item in timeline:
        if item["ts"] - window_start >= window_s and current:
            sessions.append(current)
            current = []
            window_start = item["ts"]
        current.append(item)
    if current:
        sessions.append(current)
    return sessions


def _build_instance(timeline: list[dict], instance_id: str):
    """Wrap timeline into a BenchmarkInstance the existing ingest path accepts.

    Float timestamps (seconds since video start) get converted to ISO datetime
    strings here — `knowledge_integrator.py:554` requires `digest['ts'][:16]`
    to be valid ISO format, so feed items need ISO timestamps too.
    """
    from datetime import datetime, timedelta, timezone
    _scripts_dir = str(Path(__file__).resolve().parents[2])
    if _scripts_dir not in sys.path:
        sys.path.insert(0, _scripts_dir)
    from eval.benchmarks.base_adapter import BenchmarkInstance

    # Anchor the recording to an arbitrary base time — only the relative
    # spacing matters for distillation; absolute date is just a placeholder.
    base = datetime(2026, 5, 18, 10, 0, 0, tzinfo=timezone.utc)
    sessions_float = _split_into_sessions(timeline)
    sessions: list[list[dict]] = [
        [
            {**item, "ts": (base + timedelta(seconds=float(item["ts"]))).isoformat()}
            for item in session
        ]
        for session in sessions_float
    ]
    # Questions aren't ingested — they're used for retrieval. Empty here; we
    # query separately via answer_question/judge_qa.
    return BenchmarkInstance(
        id=instance_id,
        sessions=sessions,
        questions=[],
        raw_sessions=[],
        metadata={"source": "media-bench", "n_sessions": len(sessions)},
    )


# ----------------------------------------------------------------------
# Query evaluation
# ----------------------------------------------------------------------

def _evaluate_queries(
    db_path: Path,
    queries: list[dict],
    qa_model: str,
    judge_model: str,
) -> list[dict]:
    """For each query: retrieve, generate answer, judge. Return per-query results."""
    _scripts_dir = str(Path(__file__).resolve().parents[2])
    if _scripts_dir not in sys.path:
        sys.path.insert(0, _scripts_dir)
    from eval.benchmarks.base_adapter import BenchmarkQuestion
    from eval.benchmarks.query import answer_question
    from eval.benchmarks.judges.qa_judge import judge_qa

    results: list[dict] = []
    for q in queries:
        bench_q = BenchmarkQuestion(
            id=q["id"],
            text=q["question"],
            gold_answer=q["expected_answer"],
            category=q.get("category", "recall"),
        )
        try:
            answer = answer_question(
                bench_q,
                condition="sinain-memory",
                db_path=str(db_path),
                model=qa_model,
                profile="eval",
            )
        except Exception as e:
            results.append({**q, "answer": None, "score": None, "error": str(e)})
            continue

        judge_result = judge_qa(
            bench_q.text, bench_q.gold_answer, answer,
            condition="sinain-memory",
            category=bench_q.category,
            model=judge_model,
        )
        score = judge_result["score"] if judge_result else None
        results.append({
            **q,
            "answer": answer[:500] if answer else None,
            "score": score,
            "judge_reasoning": judge_result.get("reasoning") if judge_result else None,
        })
    return results


# ----------------------------------------------------------------------
# Main entry
# ----------------------------------------------------------------------

def run(candidate: "ModelCandidate", *, subset: int | None = None) -> "BenchResult":
    """Run the meeting-recall bench (Outcome 2 in Phase B north star)."""
    from eval.local_models.bench_harness import BenchResult
    # Setup ingest env (reuses common.call_llm routing → candidate model)
    _scripts_dir = str(Path(__file__).resolve().parents[2])
    if _scripts_dir not in sys.path:
        sys.path.insert(0, _scripts_dir)
    from eval.benchmarks.ingest import ingest_instance
    from eval.benchmarks.config import QA_MODEL, JUDGE_MODEL, DATA_DIR

    video_path = _resolve_video_path()
    transcript_path = _resolve_transcript_path()
    ground_truth = _load_ground_truth()
    queries = ground_truth.get("queries", [])
    if subset:
        queries = queries[:subset]
    if not queries:
        raise RuntimeError(
            f"No queries in {DEFAULT_GROUND_TRUTH_PATH}. Author at least one "
            "to bench meeting recall."
        )

    started = time.monotonic()

    # 1+2. Extract frames + parse transcript
    print(f"[bench_media] extracting frames from {video_path.name}...", file=sys.stderr)
    frames = _extract_frames(video_path)
    print(f"[bench_media] {len(frames)} frames extracted", file=sys.stderr)

    print(f"[bench_media] parsing transcript {transcript_path.name}...", file=sys.stderr)
    transcript_items = _parse_transcript(transcript_path)
    print(f"[bench_media] {len(transcript_items)} transcript items parsed", file=sys.stderr)

    # 3. OCR frames via candidate's vision (skipped for text-only candidates)
    print(f"[bench_media] OCRing frames via candidate...", file=sys.stderr)
    ocr_items = _ocr_frames(candidate, frames)
    print(f"[bench_media] {len(ocr_items)} OCR items", file=sys.stderr)

    # 4. Merge + sort timeline
    timeline = sorted(transcript_items + ocr_items, key=lambda x: x["ts"])
    if not timeline:
        raise RuntimeError("Empty timeline — transcript parse + OCR both produced no items")

    # 5. Ingest via existing pipeline (uses SINAIN_BENCH_MODEL via bench_harness env)
    instance_id = f"media-{candidate.name}-{int(time.time())}"
    instance = _build_instance(timeline, instance_id)
    print(
        f"[bench_media] ingesting {len(instance.sessions)} sessions "
        f"(window={SESSION_WINDOW_S}s)...",
        file=sys.stderr,
    )
    cache_dir = DATA_DIR / "media"
    db_path = ingest_instance(instance, cache_dir)
    if not db_path or not db_path.exists():
        raise RuntimeError("Ingestion failed — no DB produced")

    # 6+7. Evaluate queries
    print(f"[bench_media] evaluating {len(queries)} queries...", file=sys.stderr)
    per_query = _evaluate_queries(db_path, queries, QA_MODEL, JUDGE_MODEL)

    # Aggregate
    judged = [r for r in per_query if r.get("score") is not None]
    correct = sum(1 for r in judged if r["score"] == 5)
    pass_rate = (correct / len(judged)) if judged else None
    mean_score = (sum(r["score"] for r in judged) / len(judged)) if judged else None
    wall_clock_s = time.monotonic() - started

    return BenchResult(
        candidate=candidate,
        surface="media",
        score={
            "pass_rate": pass_rate,
            "mean_judge_score": round(mean_score, 4) if mean_score is not None else None,
            "n_queries": len(queries),
            "judged": len(judged),
            "correct": correct,
            "per_query": per_query,
            "ingest_stats": {
                "n_transcript_items": len(transcript_items),
                "n_ocr_items": len(ocr_items),
                "n_sessions": len(instance.sessions),
                "db_path": str(db_path),
                "db_size_bytes": db_path.stat().st_size if db_path.exists() else None,
            },
            "methodology": {
                "judge_model": JUDGE_MODEL,
                "judge_rubric": "paper-aligned-binary (score==5 → correct)",
                "qa_model": QA_MODEL,
                "qa_temperature": 0.0,
                "video_path_env": MEDIA_VIDEO_ENV,
                "transcript_path_env": MEDIA_TRANSCRIPT_ENV,
                "ground_truth_file": str(DEFAULT_GROUND_TRUTH_PATH),
                "frame_sample_interval_s": FRAME_SAMPLE_INTERVAL_S,
                "session_window_s": SESSION_WINDOW_S,
            },
        },
        latency_ms_p50=None,
        latency_ms_p99=None,
        notes=[
            f"wall-clock seconds: {wall_clock_s:.1f}",
            f"candidate routed to {candidate.ollama_id or candidate.openrouter_id}",
            "CONFIDENTIAL — never publish, never reference externally",
        ],
    )
