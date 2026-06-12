"""Base adapter and data classes for benchmark evaluation."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class BenchmarkQuestion:
    id: str
    text: str
    gold_answer: str
    category: str  # single-session, multi-session, temporal, etc.
    evidence_session_ids: list[str] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)


@dataclass
class BenchmarkInstance:
    """A set of conversations + questions that share the same context."""
    id: str
    sessions: list[list[dict]]  # list of sessions, each a list of feed items {source, text, ts}
    questions: list[BenchmarkQuestion] = field(default_factory=list)
    raw_sessions: list[dict] = field(default_factory=list)  # original benchmark format (for full-context condition)
    metadata: dict = field(default_factory=dict)


class BenchmarkAdapter(ABC):
    """Abstract adapter: converts a published benchmark into sinain's format."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Benchmark name (e.g. 'longmemeval', 'locomo')."""

    @abstractmethod
    def load_dataset(self, data_dir: str) -> list[BenchmarkInstance]:
        """Download (if needed) and parse the benchmark dataset."""

    @abstractmethod
    def format_full_context(self, instance: BenchmarkInstance) -> str:
        """Render the full conversation history as a text string for the baseline condition."""
