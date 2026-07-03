"""memory_v2 — episodes-first memory engine (walking skeleton).

Design: docs/DESIGN-MEMORY-V2.md. Core inversion vs the current pipeline:
capture is deterministic and instant (T1 episodes, zero LLM on the write
path); understanding is deferred, budgeted background *compaction*; typed
semantic facts (T2) are a derived, always re-derivable index over episodes.

This package is the product code under test by eval/benchmarks (condition
"sinain-v2"). Current milestone: T1 episode store + deterministic ingest +
lexical hybrid retrieval — the layer that must work with ZERO LLM calls and
any local model. Compaction tiers (summary tree, typed domains) build on top.
"""

from memory_v2.store import Episode, EpisodeStore
from memory_v2.ingest import ingest_sessions
from memory_v2.retrieve import build_context_block, search_episodes, search_facts
from memory_v2.compact import Fact, CompactionResult, compact_store, consolidate

__all__ = [
    "Episode", "EpisodeStore",
    "ingest_sessions",
    "build_context_block", "search_episodes", "search_facts",
    "Fact", "CompactionResult", "compact_store", "consolidate",
]
