"""Query rewriter — Layer 2 utility-intelligence model that pre-processes user
questions before they hit the retrieval pipeline.

Architecture role: this is the first of three planned "tiny-LLM utility models"
(per .planning/phases/diarization-levers/00-PLAN.md § Tiny-LLM Layer 2). It sits
in front of graph_query.query_facts_hybrid and rewrites raw user questions into
structured form so the retrieval pipeline sees better tokens.

Motivation — bench evidence:
    Recall@1 has been stuck at 10-25% across every Lever configuration. The
    right fact is in the graph; the retrieval pipeline can't find it from raw
    user phrasing because the question text doesn't match the distilled fact
    text token-for-token. A tiny LLM rewrites:

        "What is the CTO's professional background?"
    →   {
            "key_terms": ["CTO", "Mustafa", "background", "career", "experience"],
            "question_type": "entity-attribute",
            "expanded_synonyms": ["CTO", "Chief Technology Officer", "tech lead"],
            "suggested_profile": "eval"
        }

Model selection:
    Uses common.call_llm with script="query_rewriter" — koog-config.json's
    scripts.query_rewriter.model resolves to "fast" by default. In cloud mode
    that's gemini-2.5-flash-lite; in local-mode (SINAIN_FAST_MODEL=ollama/X)
    it's whatever local model is configured. The task is small enough that
    any 1B+ model handles it reliably; phi4-mini is plenty.

Cost: one extra LLM call per query (~$0.0001 cloud, free local). For an
interactive overlay this is negligible. Worth iterating with profiling.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

# Lazy import — common is at sinain-memory root.
_PARENT_DIR_ADDED = False


def _ensure_path() -> None:
    global _PARENT_DIR_ADDED
    if _PARENT_DIR_ADDED:
        return
    from pathlib import Path
    here = Path(__file__).resolve().parent
    if str(here) not in sys.path:
        sys.path.insert(0, str(here))
    _PARENT_DIR_ADDED = True


_REWRITE_SCHEMA = {
    "title": "QueryRewrite",
    "type": "object",
    "properties": {
        "key_terms": {
            "type": "array",
            "maxItems": 12,
            "items": {"type": "string", "minLength": 1, "maxLength": 40},
        },
        "question_type": {
            "type": "string",
            "enum": [
                "entity-attribute",
                "entity-relationship",
                "quantitative",
                "temporal",
                "attribution",
                "reasoning",
                "summary",
                "unknown",
            ],
        },
        "expanded_synonyms": {
            "type": "array",
            "maxItems": 12,
            "items": {"type": "string", "minLength": 1, "maxLength": 40},
        },
        "suggested_profile": {
            "type": "string",
            "enum": ["eval", "balanced", "browse", "agent-tick", "escalation"],
        },
    },
    "required": ["key_terms", "question_type", "expanded_synonyms", "suggested_profile"],
    "additionalProperties": False,
}


SYSTEM_PROMPT = """\
You are a query rewriter for a knowledge-graph retrieval system. The user asks a
question; you produce structured retrieval hints so the downstream pipeline can
find the right facts.

Output a JSON object with these fields:

1. key_terms: the specific named entities + concrete attributes in the question.
   Strip stop words and question phrasing ("What is", "How many", etc).
   Example: "What is the CTO's professional background?"
            → ["CTO", "background", "career", "experience"]

2. question_type: one of
   - entity-attribute: asking about a property of a specific entity
   - entity-relationship: asking how two entities relate
   - quantitative: asking about a number, count, duration, or amount
   - temporal: asking when something happened
   - attribution: asking who said/did something
   - reasoning: asking WHY (causal, motivational)
   - summary: asking for an overview
   - unknown: doesn't fit the above

3. expanded_synonyms: aliases for the key entities that might appear in the graph
   with different surface forms. Include role-titles and common-name variants.
   Example for "CTO": ["CTO", "Chief Technology Officer", "tech lead", "head of engineering"]
   Example for "Citibank": ["Citibank", "Citi", "City Bank"]
   Only expand when there's a clear synonym; do NOT invent unrelated terms.

4. suggested_profile: which retrieval profile fits this question type.
   - eval: precise + cross-encoder + multi-hop. Use for attribution, quantitative,
     entity-attribute questions where precision matters.
   - balanced: default. Use when unsure.
   - browse: narrative format for summary questions.
   - agent-tick: fast, low-precision for hot-path checks (rarely the right choice here).
   - escalation: precise + confidence floor for hardest questions.

Respond with ONLY the JSON object. Keep all terms ≤40 chars, lists ≤12 items."""


def rewrite_query(
    question: str,
    *,
    fallback: bool = True,
) -> dict[str, Any]:
    """Rewrite a user question into structured retrieval hints.

    On failure (LLM unavailable, network error, malformed output), returns a
    passthrough shape derived from the raw question — the caller can use it
    unconditionally without if-checks. Set fallback=False to raise instead.
    """
    _ensure_path()
    from common import call_llm  # noqa: E402
    from query_params import ALLOWED_PROFILE_NAMES  # noqa: E402

    try:
        raw = call_llm(
            system_prompt=SYSTEM_PROMPT,
            user_prompt=f"Question:\n{question}\n\nRespond with JSON.",
            script="query_rewriter",
            json_schema=_REWRITE_SCHEMA,
            temperature=0.0,
            max_tokens=400,
        )
        data = json.loads(raw)
    except Exception as e:
        if not fallback:
            raise
        return _passthrough(question)

    # Sanity-check the suggested_profile against the actual ALLOWED set.
    if data.get("suggested_profile") not in ALLOWED_PROFILE_NAMES:
        data["suggested_profile"] = "balanced"
    # Force list shapes if the model returned strings/None.
    for k in ("key_terms", "expanded_synonyms"):
        v = data.get(k)
        if isinstance(v, str):
            data[k] = [v]
        elif not isinstance(v, list):
            data[k] = []
    if not isinstance(data.get("question_type"), str):
        data["question_type"] = "unknown"
    return data


def _passthrough(question: str) -> dict[str, Any]:
    """Fallback rewrite from raw question — no LLM involved.

    Used when the rewriter LLM fails. Extracts keywords via the same regex
    the existing pipeline uses so the downstream behavior is preserved.
    """
    import re
    words = re.findall(r"[a-zA-Z][a-zA-Z0-9-]+", question)
    stop = {"the", "is", "in", "on", "for", "and", "or", "of", "to", "a", "an",
            "what", "when", "where", "who", "how", "why", "which", "does",
            "did", "do", "has", "have", "had", "was", "were", "are", "be"}
    keys = [w for w in words if w.lower() not in stop and len(w) > 2]
    return {
        "key_terms": keys[:12],
        "question_type": "unknown",
        "expanded_synonyms": [],
        "suggested_profile": "balanced",
    }


# Convenience: env-var gate so callers can opt in / out at runtime.
def is_enabled() -> bool:
    return os.environ.get("SINAIN_QUERY_REWRITER", "").lower() in ("1", "true", "yes")
