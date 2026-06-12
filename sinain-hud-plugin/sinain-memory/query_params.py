"""Shared query parameter schema for sinain-memory retrieval.

This is the canonical home for the parameter API exposed by query_facts_hybrid.
Both the Python implementation (graph_query.py) and the TypeScript MCP tool
schema (sinain-mcp-server/index.ts) should reference these allow-lists. The
TypeScript side can't import this directly, but a drift test compares the
TypeScript zod enums against the strings parsed from this file.

When you add a new value (e.g. precision_mode="ludicrous"), update:
  1. _PRECISION_MODES below
  2. the zod schema in sinain-mcp-server/index.ts
  3. the HTTP query-string parser in sinain-core/src/server.ts
  4. the docstring in graph_query.query_facts_hybrid

Caller profiles (recommended defaults per consumer) live in QUERY_PROFILES so
the eval harness, the MCP server, and any future caller can opt into a named
preset instead of memorizing six parameter combinations.
"""

from __future__ import annotations

PRECISION_MODES = frozenset({"fast", "balanced", "precise"})
TEMPORAL_MODES = frozenset({"current", "historical", "any"})
FORMATS = frozenset({"facts", "triples", "narrative", "structured"})

# Hop depth is an integer range, not an enum — kept here for completeness.
HOP_DEPTH_MIN = 0
HOP_DEPTH_MAX = 3

CONFIDENCE_FLOOR_MIN = 0.0
CONFIDENCE_FLOOR_MAX = 1.0


def validate_query_params(
    precision_mode: str,
    temporal_mode: str,
    confidence_floor: float,
    hop_depth: int,
    format: str,
) -> None:
    """Validate retrieval parameters; raise ValueError on bad input.

    Centralized so every entry point (Python API, CLI, HTTP handler, MCP tool)
    enforces the same constraints. Callers should validate at the boundary
    rather than rely on downstream defaults.
    """
    if precision_mode not in PRECISION_MODES:
        raise ValueError(f"precision_mode must be one of {PRECISION_MODES}, got {precision_mode!r}")
    if temporal_mode not in TEMPORAL_MODES:
        raise ValueError(f"temporal_mode must be one of {TEMPORAL_MODES}, got {temporal_mode!r}")
    if not CONFIDENCE_FLOOR_MIN <= confidence_floor <= CONFIDENCE_FLOOR_MAX:
        raise ValueError(
            f"confidence_floor must be in [{CONFIDENCE_FLOOR_MIN}, {CONFIDENCE_FLOOR_MAX}], "
            f"got {confidence_floor}"
        )
    if not HOP_DEPTH_MIN <= hop_depth <= HOP_DEPTH_MAX:
        raise ValueError(
            f"hop_depth must be in [{HOP_DEPTH_MIN}, {HOP_DEPTH_MAX}], got {hop_depth}"
        )
    if format not in FORMATS:
        raise ValueError(f"format must be one of {FORMATS}, got {format!r}")


# Named caller profiles — opt-in presets matched to consumer latency/precision
# budgets. Each profile is a kwargs dict that callers can splat into
# query_facts_hybrid:  query_facts_hybrid(db, q, **QUERY_PROFILES["agent-tick"])
#
# When you add a profile, add it to ALLOWED_PROFILE_NAMES too so the MCP tool
# can validate the input string.
QUERY_PROFILES: dict[str, dict] = {
    # sinain-core agent tick: hot path, sub-200ms target.
    # Skips bi-encoder rerank, drops low-confidence noise, no graph expansion.
    "agent-tick": {
        "precision_mode": "fast",
        "temporal_mode": "current",
        "confidence_floor": 0.5,
        "hop_depth": 0,
        "latency_budget_ms": 150,
        "format": "facts",
    },

    # OpenClaw / deep research escalation: latency-tolerant, precision-first.
    # Cross-encoder rerank + multi-hop spread + structured output with provenance.
    "escalation": {
        "precision_mode": "precise",
        "temporal_mode": "any",
        "confidence_floor": 0.3,
        "hop_depth": 2,
        "latency_budget_ms": 5000,
        "format": "structured",
    },

    # External MCP query — legacy balanced/1-hop config. NO LONGER the
    # production default (2026-05-28): query_facts_hybrid now defaults to
    # balanced + hop_depth=2 so ONE config serves both production and eval
    # (no bench-only profile to overfit against). This profile differs only
    # by hop_depth=1; kept as an explicit opt-in for a latency-bound caller
    # that wants to skip multi-hop expansion.
    "mcp-default": {
        "precision_mode": "balanced",
        "temporal_mode": "any",
        "confidence_floor": 0.0,
        "hop_depth": 1,
        "latency_budget_ms": None,
        "format": "facts",
    },

    # Overlay user browse: narrative briefs, moderate latency.
    "browse": {
        "precision_mode": "balanced",
        "temporal_mode": "any",
        "confidence_floor": 0.0,
        "hop_depth": 1,
        "latency_budget_ms": 1500,
        "format": "narrative",
    },

    # Eval harness: balanced + multi-hop. As of 2026-05-28 this is functionally
    # IDENTICAL to query_facts_hybrid's defaults — kept as an explicit alias so
    # `--profile eval` and a no-profile run produce the same config. The bench
    # measures exactly what production runs; do not let these drift apart again
    # (the divergence was the overfitting risk we removed). NB: dropped the
    # cross-encoder ("precise") here too — bench-confirmed net-negative.
    "eval": {
        "precision_mode": "balanced",
        "temporal_mode": "any",
        "confidence_floor": 0.0,
        "hop_depth": 2,
        "latency_budget_ms": None,
        "format": "facts",
    },
}

ALLOWED_PROFILE_NAMES = frozenset(QUERY_PROFILES.keys())


def resolve_profile(name: str) -> dict:
    """Return the kwargs dict for a named profile.

    Raises ValueError on unknown name so the MCP/eval entry points fail fast.
    """
    if name not in QUERY_PROFILES:
        raise ValueError(
            f"unknown profile {name!r}; valid: {sorted(ALLOWED_PROFILE_NAMES)}"
        )
    # Return a copy so callers can override fields without mutating the canonical profile.
    return dict(QUERY_PROFILES[name])
