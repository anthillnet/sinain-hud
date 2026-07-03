"""T1 episode store — append-only, deterministic, source of truth.

An episode is a bounded window of observed activity (a conversation segment,
a work-session slice, a breakpoint snapshot). Episodes are NEVER produced by
an LLM and never mutated — compaction derives summaries/facts FROM them and
records provenance back. See DESIGN-MEMORY-V2.md §3.2.

v0 storage: a single episodes.jsonl per store (in-memory index on load).
The rotated-segment-file layout with offset index arrives with memoryd; the
record schema is the stable contract, the file layout is not.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path


@dataclass
class Episode:
    id: str
    context_id: str            # §3.4 context identity (bench: one per instance/session)
    t_start: str               # ISO timestamps (event time)
    t_end: str
    kind: str = "segment"      # session | segment | breakpoint | return
    source: str = "audio"      # audio | screen | agent
    layers: list[str] = field(default_factory=list)  # §3.9; [] = unclassified (owner-only)
    text: str = ""             # redacted raw content of the window
    summary: str = ""          # tier-1 compaction output ("" until compacted)
    entities: list[str] = field(default_factory=list)  # deterministic extraction
    meta: dict = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)


class EpisodeStore:
    """Append-only episode log. path=None keeps it purely in-memory (bench mode)."""

    def __init__(self, path: str | Path | None = None):
        self.path = Path(path) if path else None
        self.episodes: list[Episode] = []
        if self.path and self.path.exists():
            for line in self.path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                # Journal contract: each append is one line; a kill mid-write
                # leaves at most one partial trailing line — skip, never fail.
                try:
                    self.episodes.append(Episode(**json.loads(line)))
                except (json.JSONDecodeError, TypeError):
                    continue

    def append(self, ep: Episode) -> None:
        self.episodes.append(ep)
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(ep.to_json() + "\n")

    def by_time(self, since: str | None = None, until: str | None = None) -> list[Episode]:
        out = self.episodes
        if since:
            out = [e for e in out if e.t_end >= since]
        if until:
            out = [e for e in out if e.t_start <= until]
        return out

    def scoped(self, allowed_layers: set[str] | None) -> list[Episode]:
        """Persona-scope filter (§3.9): visible iff layers ∩ allowed ≠ ∅.

        allowed_layers=None means OWNER scope — sees everything, including
        unclassified (empty-set) episodes. Any restricted scope NEVER sees
        unclassified records (fail closed).
        """
        if allowed_layers is None:
            return list(self.episodes)
        return [e for e in self.episodes if set(e.layers) & allowed_layers]

    def __len__(self) -> int:
        return len(self.episodes)
