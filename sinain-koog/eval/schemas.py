"""JSON Schema definitions for all sinain-koog script outputs.

Each schema corresponds to the JSON printed by output_json() in its respective
script.  Used by tick_evaluator.py for mechanical validation (Tier 1 eval).
"""

import json
from typing import Any


# ---------------------------------------------------------------------------
# signal_analyzer.py output
# ---------------------------------------------------------------------------

SIGNAL_ANALYZER_SCHEMA: dict = {
    "type": "object",
    "required": ["signals", "recommendedAction", "idle"],
    "properties": {
        "signals": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["description", "priority"],
                "properties": {
                    "description": {"type": "string"},
                    "priority": {"enum": ["high", "medium", "low"]},
                },
            },
        },
        "recommendedAction": {
            "oneOf": [
                {"type": "null"},
                {
                    "type": "object",
                    "required": ["action"],
                    "properties": {
                        "action": {"enum": ["sessions_spawn", "telegram_tip", "skip"]},
                        "task": {"oneOf": [{"type": "string"}, {"type": "null"}]},
                        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    },
                },
            ],
        },
        "idle": {"type": "boolean"},
    },
}

# ---------------------------------------------------------------------------
# feedback_analyzer.py output
# ---------------------------------------------------------------------------

FEEDBACK_ANALYZER_SCHEMA: dict = {
    "type": "object",
    "required": ["feedbackScores", "effectiveness", "curateDirective"],
    "properties": {
        "feedbackScores": {
            "type": "object",
            "required": ["avg"],
            "properties": {
                "avg": {"type": "number"},
                "high": {"type": "array", "items": {"type": "string"}},
                "low": {"type": "array", "items": {"type": "string"}},
            },
        },
        "effectiveness": {
            "type": "object",
            "required": ["outputs", "positive", "negative", "neutral", "rate"],
            "properties": {
                "outputs": {"type": "integer", "minimum": 0},
                "positive": {"type": "integer", "minimum": 0},
                "negative": {"type": "integer", "minimum": 0},
                "neutral": {"type": "integer", "minimum": 0},
                "rate": {"type": "number", "minimum": 0, "maximum": 1},
            },
        },
        "curateDirective": {
            "enum": ["aggressive_prune", "normal", "stability", "insufficient_data"],
        },
        "interpretation": {"type": "string"},
    },
}

# ---------------------------------------------------------------------------
# memory_miner.py output
# ---------------------------------------------------------------------------

MEMORY_MINER_SCHEMA: dict = {
    "type": "object",
    "required": ["findings", "newPatterns"],
    "properties": {
        "findings": {"type": "string"},
        "newPatterns": {"type": "array", "items": {"type": "string"}},
        "contradictions": {"type": "array", "items": {"type": "string"}},
        "preferences": {"type": "array", "items": {"type": "string"}},
        "minedSources": {"type": "array", "items": {"type": "string"}},
    },
}

# ---------------------------------------------------------------------------
# playbook_curator.py output
# ---------------------------------------------------------------------------

PLAYBOOK_CURATOR_SCHEMA: dict = {
    "type": "object",
    "required": ["changes", "playbookLines"],
    "properties": {
        "changes": {
            "type": "object",
            "required": ["added", "pruned", "promoted"],
            "properties": {
                "added": {"type": "array", "items": {"type": "string"}},
                "pruned": {"type": "array", "items": {"type": "string"}},
                "promoted": {"type": "array", "items": {"type": "string"}},
            },
        },
        "staleItemActions": {"type": "array", "items": {"type": "string"}},
        "playbookLines": {"type": "integer", "minimum": 0},
        "error": {"type": "string"},
    },
}

# ---------------------------------------------------------------------------
# insight_synthesizer.py output (non-skip case)
# ---------------------------------------------------------------------------

INSIGHT_SYNTHESIZER_SCHEMA: dict = {
    "type": "object",
    "required": [],
    "properties": {
        "skip": {"type": "boolean"},
        "suggestion": {"type": "string"},
        "insight": {"type": "string"},
        "totalChars": {"type": "integer", "minimum": 0},
        "skipReason": {"type": "string"},
    },
}

# ---------------------------------------------------------------------------
# module_manager.py extract output
# ---------------------------------------------------------------------------

MODULE_EXTRACT_SCHEMA: dict = {
    "type": "object",
    "required": ["extracted", "domain", "status"],
    "properties": {
        "extracted": {"type": "string"},
        "domain": {"type": "string"},
        "patternsEstablished": {"type": "integer", "minimum": 0},
        "patternsEmerging": {"type": "integer", "minimum": 0},
        "vocabularyTerms": {"type": "integer", "minimum": 0},
        "modulePath": {"type": "string"},
        "status": {"enum": ["suspended", "active"]},
        "activateWith": {"type": "string"},
    },
}


# ---------------------------------------------------------------------------
# Registry: script name → schema
# ---------------------------------------------------------------------------

SCHEMA_REGISTRY: dict[str, dict] = {
    "signal_analyzer": SIGNAL_ANALYZER_SCHEMA,
    "feedback_analyzer": FEEDBACK_ANALYZER_SCHEMA,
    "memory_miner": MEMORY_MINER_SCHEMA,
    "playbook_curator": PLAYBOOK_CURATOR_SCHEMA,
    "insight_synthesizer": INSIGHT_SYNTHESIZER_SCHEMA,
    "module_extract": MODULE_EXTRACT_SCHEMA,
}


# ---------------------------------------------------------------------------
# Lightweight JSON Schema validator (no external dependency)
# ---------------------------------------------------------------------------

def validate(instance: Any, schema: dict) -> list[str]:
    """Validate *instance* against a JSON Schema subset.

    Returns a list of error strings (empty = valid).  Supports:
    type, required, properties, items, enum, oneOf, minimum, maximum.
    """
    errors: list[str] = []
    _validate(instance, schema, "", errors)
    return errors


def _validate(instance: Any, schema: dict, path: str, errors: list[str]) -> None:
    # --- oneOf ---
    if "oneOf" in schema:
        matches = 0
        for sub in schema["oneOf"]:
            sub_errors: list[str] = []
            _validate(instance, sub, path, sub_errors)
            if not sub_errors:
                matches += 1
        if matches == 0:
            errors.append(f"{path or '.'}: does not match any oneOf variant")
        return

    # --- enum ---
    if "enum" in schema:
        if instance not in schema["enum"]:
            errors.append(f"{path or '.'}: {instance!r} not in {schema['enum']}")
        return

    # --- type ---
    expected_type = schema.get("type")
    if expected_type:
        ok = _type_check(instance, expected_type)
        if not ok:
            errors.append(f"{path or '.'}: expected {expected_type}, got {type(instance).__name__}")
            return

    # --- required ---
    if "required" in schema and isinstance(instance, dict):
        for key in schema["required"]:
            if key not in instance:
                errors.append(f"{path}.{key}: required field missing")

    # --- properties ---
    if "properties" in schema and isinstance(instance, dict):
        for key, sub_schema in schema["properties"].items():
            if key in instance:
                _validate(instance[key], sub_schema, f"{path}.{key}", errors)

    # --- items ---
    if "items" in schema and isinstance(instance, list):
        for i, item in enumerate(instance):
            _validate(item, schema["items"], f"{path}[{i}]", errors)

    # --- minimum / maximum ---
    if isinstance(instance, (int, float)):
        if "minimum" in schema and instance < schema["minimum"]:
            errors.append(f"{path or '.'}: {instance} < minimum {schema['minimum']}")
        if "maximum" in schema and instance > schema["maximum"]:
            errors.append(f"{path or '.'}: {instance} > maximum {schema['maximum']}")


def _type_check(instance: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(instance, dict)
    if expected == "array":
        return isinstance(instance, list)
    if expected == "string":
        return isinstance(instance, str)
    if expected == "number":
        return isinstance(instance, (int, float))
    if expected == "integer":
        return isinstance(instance, int) and not isinstance(instance, bool)
    if expected == "boolean":
        return isinstance(instance, bool)
    if expected == "null":
        return instance is None
    return True
