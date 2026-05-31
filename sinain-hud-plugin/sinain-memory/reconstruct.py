#!/usr/bin/env python3
"""reconstruct.py — T1-RECON: whole-graph entity-centric consolidation stage.

Runs AFTER all sessions are distilled+integrated (so it sees facts ACROSS sessions —
the count questions need cross-session aggregation, e.g. 5 model kits spread over 5
sessions). Read-only over the store; returns a small synthetic digest of consolidated
facts that the caller feeds back through the PROVEN knowledge_integrator path (no direct
store writes here → cannot corrupt the graph).

Two consolidation kinds (only when the existing facts support them — never invents):
  1. ENUMERATION  — distinct instances of one kind the user owns/did/visited → ONE fact
     listing the deduped members + total count (excludes different-category items, e.g.
     a 'meal kit' is not a 'model kit'). Fixes count questions (gpt4_59c863d7, 0a995998).
  2. CURRENT-STATE — an entity attribute that changed over time → ONE fact stating the
     LATEST value as current. Fixes knowledge-update questions (830ce83f, d7c942c3).

Gated by SINAIN_RECON=1 in ingest.py (default OFF). FAIL-OPEN: any error → empty digest
(the run is then a no-op, never a regression). Added to ingest._PIPELINE_VERSION_FILES so
toggling it invalidates the store cache.
"""
from __future__ import annotations

import json
import re
import sys

_SCHEMA = {
    "type": "object",
    "properties": {
        "consolidated": {
            "type": "array",
            "maxItems": 12,
            "items": {"type": "string"},
        }
    },
    "required": ["consolidated"],
    "additionalProperties": False,
}

_SYSTEM = (
    "You consolidate already-extracted memory facts into a few high-value CURRENT-STATE "
    "summary facts. You NEVER invent information — every consolidated fact must be fully "
    "supported by the input facts.\n"
    "Task — CURRENT-STATE: for EACH distinct person or entity named in the facts (the user "
    "AND named others such as friends, family, colleagues — e.g. 'Rachel', 'Mom'), if any "
    "attribute (location/residence, job, relationship, status, possession) is stated or "
    "changes over time, output ONE sentence stating the LATEST value and naming that person "
    "or entity explicitly (e.g. 'Rachel currently lives in the suburbs'; 'The user currently "
    "works as a senior software engineer'). When a person MOVED or RELOCATED, the destination "
    "of the most recent move is their current location — state it even if only one fact "
    "mentions the move. Prefer the most recent fact when facts conflict.\n"
    "Each consolidated fact is ONE self-contained sentence. Do NOT produce counts or "
    "enumerations of collections (those are handled elsewhere and are error-prone). If no "
    "current-state fact is clearly supported, return an empty list. Output at most 10."
)

_MAX_INPUT_FACTS = 1500  # see ALL facts (stores hold ~1000); flash has huge context.


def _fact_texts(db_path: str) -> list[str]:
    """Read all distilled fact values from the store (read-only)."""
    sys.path.insert(0, ".")
    from triplestore import TripleStore
    st = TripleStore(db_path)
    out: list[str] = []
    try:
        for eid, _name in st.entities_with_attr("value"):
            attrs = st.entity(eid)
            if not attrs:
                continue
            # skip raw verbatim excerpts + already-consolidated facts
            kind = attrs.get("kind", [""])
            kind = kind[0] if isinstance(kind, list) else kind
            if kind == "verbatim":
                continue
            v = attrs.get("value", [""])
            v = v[0] if isinstance(v, list) else v
            if v and isinstance(v, str) and len(v) > 8:
                out.append(v.strip())
    finally:
        try:
            st.close()
        except Exception:
            pass
    # de-dup identical strings, keep order
    seen, uniq = set(), []
    for v in out:
        if v not in seen:
            seen.add(v)
            uniq.append(v)
    return uniq


def _parse_json(text: str) -> dict:
    text = (text or "").strip()
    try:
        return json.loads(text)
    except Exception:
        pass
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1))
        except Exception:
            pass
    m = re.search(r"(\{.*\})", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1))
        except Exception:
            pass
    return {}


def build_consolidated_digest(db_path: str) -> dict:
    """Read the store, ask one LLM call for enumeration + current-state consolidations,
    and return a synthetic digest for the integrator. Fail-open: {} -> caller skips."""
    try:
        facts = _fact_texts(db_path)
        if len(facts) < 5:
            return {"facts": [], "isEmpty": True}
        facts = facts[:_MAX_INPUT_FACTS]
        numbered = "\n".join(f"{i+1}. {t}" for i, t in enumerate(facts))
        from common import call_llm
        raw = call_llm(
            _SYSTEM,
            "Input facts:\n" + numbered,
            max_tokens=1500,
            json_schema=_SCHEMA,
            temperature=0.0,
            seed=42,
        )
        data = _parse_json(raw)
        items = data.get("consolidated") or []
        out = []
        for s in items:
            if isinstance(s, str) and len(s.strip()) > 8:
                # tag origin in the text-free way: integrator stores it as a normal fact;
                # high confidence so it ranks well, kind=recon for traceability.
                out.append({"text": s.strip()})
        if not out:
            return {"facts": [], "isEmpty": True}
        return {
            "whatHappened": "Cross-session consolidation (T1-RECON).",
            "facts": out,
            "decisions": [],
            "entities": [],
            "patterns": [],
            "preferences": [],
            "isEmpty": False,
            "_recon": True,
        }
    except Exception as e:  # FAIL-OPEN — never break ingestion
        sys.stderr.write(f"[reconstruct] skipped (fail-open): {str(e)[:160]}\n")
        return {"facts": [], "isEmpty": True}


if __name__ == "__main__":
    # Manual probe: python3 reconstruct.py <store.db>
    d = build_consolidated_digest(sys.argv[1])
    print(json.dumps(d, indent=2, ensure_ascii=False))
