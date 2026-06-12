"""Distiller ablation stub. Replaces session_distiller.py LLM call with a
deterministic transform.

Modes:
    passthrough: one fact per transcript chunk, raw verbatim. Zero LLM cost.
                 Tests: "what if the distiller was a no-op (perfect echo)?"
    oracle:      passthrough PLUS gold_facts injected (if provided).
                 Tests: "what's the accuracy ceiling if the distiller magically
                 extracted exactly the answer needed?"
"""
from __future__ import annotations
from typing import Any


def build_stub_digest(
    transcript: list[dict],
    mode: str = "passthrough",
    gold_facts: list[dict] | None = None,
) -> dict:
    """Build a stub digest matching session_distiller.py output shape.

    Returns a JSON-serializable dict with the same top-level keys session_distiller
    produces: whatHappened, facts, entities, decisions, patterns.
    """
    facts: list[dict] = []
    for idx, item in enumerate(transcript or []):
        role = item.get("role", "unknown")
        content = item.get("content", "")
        if not content:
            continue
        facts.append({
            "entity": f"session-{idx}",
            "attribute": "raw_content",
            "value": str(content),
            "confidence": 1.0,
            "source_role": role,
        })

    if mode == "oracle" and gold_facts:
        for gf in gold_facts:
            facts.append({
                "entity": gf.get("entity", "gold-answer"),
                "attribute": gf.get("attribute", "value"),
                "value": gf.get("value", ""),
                "confidence": 1.0,
                "source": "oracle",
            })

    return {
        "whatHappened": "stub digest (ablation mode)",
        "facts": facts,
        "entities": [],
        "decisions": [],
        "patterns": [],
    }
