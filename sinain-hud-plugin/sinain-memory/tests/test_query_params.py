"""Tests for the query_params module and the Python↔TypeScript drift detector.

Covers:
- Constants match what query_facts_hybrid validates
- validate_query_params raises on bad input, accepts good input
- QUERY_PROFILES contain expected fields and types
- resolve_profile returns a copy (callers can mutate safely)
- Drift test: TypeScript types.ts enums match the Python constants
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

import query_params
from graph_query import (
    _FORMATS as gq_formats,
    _PRECISION_MODES as gq_precision,
    _TEMPORAL_MODES as gq_temporal,
)


REPO_ROOT = Path(__file__).resolve().parents[3]
TYPES_TS = REPO_ROOT / "sinain-core" / "src" / "types.ts"


class TestConstants:
    def test_precision_modes_match_graph_query(self):
        assert query_params.PRECISION_MODES == gq_precision

    def test_temporal_modes_match_graph_query(self):
        assert query_params.TEMPORAL_MODES == gq_temporal

    def test_formats_match_graph_query(self):
        assert query_params.FORMATS == gq_formats


class TestValidation:
    def test_accepts_good_input(self):
        query_params.validate_query_params("fast", "current", 0.5, 1, "facts")

    def test_rejects_bad_precision(self):
        with pytest.raises(ValueError, match="precision_mode"):
            query_params.validate_query_params("turbo", "any", 0.0, 1, "facts")

    def test_rejects_bad_temporal(self):
        with pytest.raises(ValueError, match="temporal_mode"):
            query_params.validate_query_params("balanced", "yesterday", 0.0, 1, "facts")

    def test_rejects_out_of_range_confidence(self):
        with pytest.raises(ValueError, match="confidence_floor"):
            query_params.validate_query_params("balanced", "any", 2.0, 1, "facts")

    def test_rejects_out_of_range_hop_depth(self):
        with pytest.raises(ValueError, match="hop_depth"):
            query_params.validate_query_params("balanced", "any", 0.0, 99, "facts")

    def test_rejects_bad_format(self):
        with pytest.raises(ValueError, match="format"):
            query_params.validate_query_params("balanced", "any", 0.0, 1, "yaml")


class TestProfiles:
    def test_all_profiles_have_required_fields(self):
        required = {
            "precision_mode", "temporal_mode", "confidence_floor",
            "hop_depth", "latency_budget_ms", "format",
        }
        for name, kwargs in query_params.QUERY_PROFILES.items():
            missing = required - kwargs.keys()
            assert not missing, f"profile {name!r} missing fields: {missing}"

    def test_all_profile_values_validate(self):
        for name, kwargs in query_params.QUERY_PROFILES.items():
            try:
                query_params.validate_query_params(
                    kwargs["precision_mode"],
                    kwargs["temporal_mode"],
                    kwargs["confidence_floor"],
                    kwargs["hop_depth"],
                    kwargs["format"],
                )
            except ValueError as e:
                pytest.fail(f"profile {name!r} fails validation: {e}")

    def test_resolve_profile_returns_copy(self):
        a = query_params.resolve_profile("agent-tick")
        a["precision_mode"] = "mutated"
        b = query_params.resolve_profile("agent-tick")
        assert b["precision_mode"] != "mutated", "resolve_profile must return a copy"

    def test_resolve_profile_unknown_raises(self):
        with pytest.raises(ValueError, match="unknown profile"):
            query_params.resolve_profile("nonexistent")

    def test_agent_tick_is_fast_path(self):
        p = query_params.resolve_profile("agent-tick")
        assert p["precision_mode"] == "fast"
        assert p["hop_depth"] == 0
        assert p["latency_budget_ms"] is not None and p["latency_budget_ms"] <= 500

    def test_escalation_is_deep_path(self):
        p = query_params.resolve_profile("escalation")
        assert p["precision_mode"] == "precise"
        assert p["hop_depth"] >= 2
        assert p["format"] == "structured"


class TestTypeScriptDrift:
    """Verify the TypeScript schema declarations stay in sync with Python.

    Parses sinain-core/src/types.ts and extracts the string-literal enums for
    PrecisionMode, TemporalMode, ResultFormat, QueryProfile. Fails loudly if
    they diverge from the Python constants — drift becomes a test failure
    rather than a runtime mystery in MCP traffic.
    """

    def _extract_ts_enum(self, content: str, type_name: str) -> set[str]:
        # Match: export type PrecisionMode = "a" | "b" | "c";
        pattern = re.compile(
            rf'export\s+type\s+{type_name}\s*=\s*([^;]+);',
            re.MULTILINE,
        )
        m = pattern.search(content)
        assert m, f"could not find type {type_name} in types.ts"
        values = re.findall(r'"([^"]+)"', m.group(1))
        return set(values)

    def test_types_ts_exists(self):
        assert TYPES_TS.exists(), f"expected types.ts at {TYPES_TS}"

    def test_precision_mode_matches(self):
        content = TYPES_TS.read_text()
        ts = self._extract_ts_enum(content, "PrecisionMode")
        assert ts == set(query_params.PRECISION_MODES), (
            f"PrecisionMode drift: TS={ts}, Python={set(query_params.PRECISION_MODES)}"
        )

    def test_temporal_mode_matches(self):
        content = TYPES_TS.read_text()
        ts = self._extract_ts_enum(content, "TemporalMode")
        assert ts == set(query_params.TEMPORAL_MODES), (
            f"TemporalMode drift: TS={ts}, Python={set(query_params.TEMPORAL_MODES)}"
        )

    def test_result_format_matches(self):
        content = TYPES_TS.read_text()
        ts = self._extract_ts_enum(content, "ResultFormat")
        assert ts == set(query_params.FORMATS), (
            f"ResultFormat drift: TS={ts}, Python={set(query_params.FORMATS)}"
        )

    def test_query_profile_matches(self):
        content = TYPES_TS.read_text()
        ts = self._extract_ts_enum(content, "QueryProfile")
        assert ts == set(query_params.ALLOWED_PROFILE_NAMES), (
            f"QueryProfile drift: TS={ts}, Python={set(query_params.ALLOWED_PROFILE_NAMES)}"
        )
