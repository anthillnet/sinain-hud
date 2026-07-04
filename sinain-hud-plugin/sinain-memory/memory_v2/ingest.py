"""Deterministic episode ingest — zero LLM, always correct on its own.

Feed-item sessions (the production FeedBuffer shape, also what benchmark
adapters emit) become segment episodes. Nothing here can fail for model
reasons; local mode and cloud mode produce IDENTICAL episodes.
"""

from __future__ import annotations

import hashlib
import re

from memory_v2.store import Episode, EpisodeStore

# ~2-minute conversational window at production transcription rates; also the
# summary-tree leaf size for tier-1 compaction.
SEGMENT_TURNS = 12

_SPEAKER_RE = re.compile(r"^\[([^\]]+)\]\s*")
# Deterministic entity candidates: capitalized multi-word spans and long
# capitalized tokens, minus sentence-initial noise. Recall-oriented — these
# seed lexical retrieval, they are NOT minted as KG entities (§3.4).
_CAP_SPAN_RE = re.compile(r"\b([A-ZА-ЯЁ][\w-]+(?:\s+[A-ZА-ЯЁ][\w-]+){0,2})\b")


def _extract_entities(text: str, max_n: int = 12) -> list[str]:
    seen: dict[str, int] = {}
    for m in _CAP_SPAN_RE.finditer(text):
        span = m.group(1).strip()
        if len(span) < 3:
            continue
        key = span.lower()
        seen[key] = seen.get(key, 0) + 1
    ranked = sorted(seen.items(), key=lambda kv: -kv[1])
    return [k for k, _ in ranked[:max_n]]


def ingest_sessions(
    sessions: list[list[dict]],
    *,
    context_id: str = "bench",
    layers: list[str] | None = None,
    store: EpisodeStore | None = None,
    segment_turns: int = SEGMENT_TURNS,
    first_index: int = 0,
) -> EpisodeStore:
    """Convert feed-item sessions into segment episodes.

    Each session (a list of {source, text, ts} items) becomes ceil(n/k)
    segment episodes plus one session-level episode carrying only metadata
    (t_start/t_end/entities) — the summary-tree node that tier-1 compaction
    later fills in.

    first_index offsets meta.session_index so incremental ingest into a
    long-lived store (one new session per app connection — the live-memory
    path) keeps indices unique across calls.
    """
    # `store or EpisodeStore()` would DISCARD an empty caller store — an
    # EpisodeStore defines __len__, so a fresh (0-episode) store is falsy.
    st = store if store is not None else EpisodeStore()
    for si, items in enumerate(sessions, start=first_index):
        if not items:
            continue
        sid = hashlib.sha256(
            f"{context_id}|{si}|{items[0].get('ts', '')}".encode()
        ).hexdigest()[:12]
        session_entities: dict[str, None] = {}
        for ci in range(0, len(items), segment_turns):
            chunk = items[ci:ci + segment_turns]
            text = "\n".join(str(i.get("text", "")) for i in chunk if i.get("text"))
            ents = _extract_entities(text)
            for e in ents:
                session_entities.setdefault(e)
            st.append(Episode(
                id=f"ep-{sid}-{ci // segment_turns:03d}",
                context_id=context_id,
                t_start=str(chunk[0].get("ts", "")),
                t_end=str(chunk[-1].get("ts", "")),
                kind="segment",
                source=str(chunk[0].get("source", "audio")),
                layers=list(layers or []),
                text=text,
                entities=ents,
                meta={"session_index": si, "n_items": len(chunk)},
            ))
        st.append(Episode(
            id=f"ep-{sid}-session",
            context_id=context_id,
            t_start=str(items[0].get("ts", "")),
            t_end=str(items[-1].get("ts", "")),
            kind="session",
            source=str(items[0].get("source", "audio")),
            layers=list(layers or []),
            text="",  # session node holds no raw text; segments do
            entities=list(session_entities)[:24],
            meta={"session_index": si, "n_items": len(items)},
        ))
    return st
