"""LongMemEval (ICLR 2025) adapter — download + parse into sinain format.

Dataset: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
Paper: https://arxiv.org/abs/2410.10813

Fields per item:
  question_id, question_type, question, answer, question_date,
  haystack_session_ids, haystack_dates, haystack_sessions, answer_session_ids

haystack_sessions entries: {"role": "user"/"assistant", "content": "...", "has_answer": bool}
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .base_adapter import BenchmarkAdapter, BenchmarkInstance, BenchmarkQuestion


def _download_dataset(data_dir: Path) -> Path:
    """Download LongMemEval from HuggingFace if not cached."""
    cache_path = data_dir / "longmemeval" / "longmemeval_s_cleaned.json"
    if cache_path.exists():
        return cache_path

    cache_path.parent.mkdir(parents=True, exist_ok=True)

    url = "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json"
    print(f"[longmemeval] downloading from {url} ...")

    # Use curl to avoid macOS Python SSL cert issues
    import subprocess
    result = subprocess.run(
        ["curl", "-fSL", "-o", str(cache_path), url],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Download failed: {result.stderr[:200]}")
    print(f"[longmemeval] saved to {cache_path} ({cache_path.stat().st_size} bytes)")
    return cache_path


def _session_hash(sessions: list[dict]) -> str:
    """Content hash for a haystack (for grouping questions with shared context)."""
    raw = json.dumps(sessions, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _sessions_to_feed_items(
    haystack_sessions: list[list[dict]],
    haystack_session_ids: list[str],
    haystack_dates: list[str],
) -> list[list[dict]]:
    """Convert LongMemEval haystack into sinain feed item sessions.

    haystack_sessions is a list of sessions, each a list of turn dicts:
    sessions[i][j] = {"role": "user"/"assistant", "content": "..."}

    Each session becomes a list of feed items with synthesized timestamps.
    User turns → source: "audio", assistant turns → source: "agent".
    """
    result: list[list[dict]] = []

    for i, session_turns in enumerate(haystack_sessions):
        if not session_turns:
            continue

        base_ts = haystack_dates[i] if i < len(haystack_dates) else "2025-01-01T10:00:00Z"
        base_dt = _parse_date(base_ts)

        items = []
        for j, turn in enumerate(session_turns):
            ts = (base_dt + timedelta(seconds=30 * j)).isoformat()
            source = "audio" if turn.get("role") == "user" else "agent"
            items.append({
                "source": source,
                "text": turn.get("content", ""),
                "ts": ts,
                "channel": "benchmark",
            })
        if items:
            result.append(items)

    return result


def _parse_date(s: str) -> datetime:
    """Best-effort date parsing.

    2026-05-27: LongMemEval `haystack_dates` use format "2023/04/23 (Sun) 08:57".
    Without this format in the list, every session fell through to the
    hardcoded 2025-01-01T10:00 default — collapsing 40 distinct dated sessions
    onto one timestamp. The integrator deduped on session timestamp, producing
    ~3 fact records from 40 sessions and uniform "I don't know" QA answers
    (subset n=18 returned 0.0%). One-line fix restores per-session timestamps.
    """
    for fmt in (
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d",
        "%m/%d/%Y",
        "%Y/%m/%d (%a) %H:%M",  # LongMemEval haystack_dates
    ):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            continue
    return datetime(2025, 1, 1, 10, 0, tzinfo=timezone.utc)


class LongMemEvalAdapter(BenchmarkAdapter):
    """Adapter for LongMemEval (ICLR 2025) benchmark."""

    @property
    def name(self) -> str:
        return "longmemeval"

    def load_dataset(self, data_dir: str) -> list[BenchmarkInstance]:
        """Download and parse LongMemEval, grouping questions by shared haystack."""
        path = _download_dataset(Path(data_dir))
        with open(path) as f:
            raw_items = json.load(f)

        # Group questions by haystack content hash
        groups: dict[str, dict] = {}
        for item in raw_items:
            h = _session_hash(item.get("haystack_sessions", []))
            if h not in groups:
                groups[h] = {
                    "haystack_sessions": item["haystack_sessions"],
                    "haystack_session_ids": item.get("haystack_session_ids", []),
                    "haystack_dates": item.get("haystack_dates", []),
                    "questions": [],
                }
            groups[h]["questions"].append(item)

        instances = []
        for h, group in groups.items():
            feed_sessions = _sessions_to_feed_items(
                group["haystack_sessions"],
                group["haystack_session_ids"],
                group["haystack_dates"],
            )

            questions = []
            for item in group["questions"]:
                questions.append(BenchmarkQuestion(
                    id=item["question_id"],
                    text=item["question"],
                    gold_answer=str(item["answer"]),
                    category=item.get("question_type", "unknown"),
                    evidence_session_ids=item.get("answer_session_ids", []),
                    metadata={
                        "question_date": item.get("question_date", ""),
                    },
                ))

            instances.append(BenchmarkInstance(
                id=f"lme-{h}",
                sessions=feed_sessions,
                questions=questions,
                raw_sessions=group["haystack_sessions"],
                metadata={
                    "haystack_hash": h,
                    "num_sessions": len(feed_sessions),
                    "num_turns": len(group["haystack_sessions"]),
                },
            ))

        print(f"[longmemeval] loaded {sum(len(i.questions) for i in instances)} questions "
              f"across {len(instances)} unique haystacks")
        return instances

    def format_full_context(self, instance: BenchmarkInstance) -> str:
        """Render the full conversation history for the baseline condition."""
        lines = []
        for session in instance.raw_sessions:
            if isinstance(session, list):
                for turn in session:
                    role = turn.get("role", "unknown").capitalize()
                    content = turn.get("content", "")
                    lines.append(f"{role}: {content}")
                lines.append("---")  # session separator
            elif isinstance(session, dict):
                role = session.get("role", "unknown").capitalize()
                content = session.get("content", "")
                lines.append(f"{role}: {content}")
        return "\n\n".join(lines)
