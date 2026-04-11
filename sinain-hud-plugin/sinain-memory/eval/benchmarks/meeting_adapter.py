"""Meeting Memory adapter — loads QA pairs + ground-truth transcript.

Unlike LongMemEval, this adapter does NOT ingest. The real sinain pipeline
(start-local.sh) produces the knowledge-graph.db during a live capture run.
This adapter only loads QA pairs and provides the full-context baseline.

Data layout:
    eval/benchmarks/data/meeting/
        <name>.txt          — ground-truth transcript
        <name>_qa.json      — gold QA pairs
"""

from __future__ import annotations

import json
from pathlib import Path

from .base_adapter import BenchmarkAdapter, BenchmarkInstance, BenchmarkQuestion


class MeetingMemoryAdapter(BenchmarkAdapter):
    """Adapter for meeting memory benchmarks (real pipeline capture)."""

    @property
    def name(self) -> str:
        return "meeting"

    def load_dataset(self, data_dir: str) -> list[BenchmarkInstance]:
        """Load meeting QA pairs and transcripts from data/meeting/."""
        meeting_dir = Path(data_dir) / "meeting"
        if not meeting_dir.exists():
            raise FileNotFoundError(f"Meeting data not found: {meeting_dir}")

        instances = []
        for qa_path in sorted(meeting_dir.glob("*_qa.json")):
            # Derive transcript path: foo_qa.json → foo.txt
            stem = qa_path.stem.replace("_qa", "")
            transcript_path = qa_path.parent / f"{stem}.txt"
            if not transcript_path.exists():
                print(f"[meeting] warning: no transcript for {qa_path.name}, skipping")
                continue

            # Load QA pairs
            with open(qa_path) as f:
                raw_questions = json.load(f)

            questions = []
            for item in raw_questions:
                questions.append(BenchmarkQuestion(
                    id=item["id"],
                    text=item["question"],
                    gold_answer=item["gold_answer"],
                    category=item.get("category", "unknown"),
                    evidence_session_ids=item.get("evidence_timestamps", []),
                    metadata={
                        "evidence_timestamps": item.get("evidence_timestamps", []),
                    },
                ))

            # Load transcript
            transcript_text = transcript_path.read_text(encoding="utf-8")

            instances.append(BenchmarkInstance(
                id=f"meeting-{stem}",
                sessions=[],  # Not used — real pipeline does ingestion
                questions=questions,
                raw_sessions=[],
                metadata={
                    "transcript_path": str(transcript_path),
                    "raw_transcript": transcript_text,
                    "stem": stem,
                },
            ))

        total_q = sum(len(i.questions) for i in instances)
        print(f"[meeting] loaded {total_q} questions across {len(instances)} meetings")
        return instances

    def format_full_context(self, instance: BenchmarkInstance) -> str:
        """Return the raw transcript verbatim for the full-context baseline."""
        return instance.metadata.get("raw_transcript", "")
