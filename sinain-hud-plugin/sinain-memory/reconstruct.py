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
    "mentions the move.\n"
    "Each input fact is prefixed with its date as [YYYY-MM-DD] and the facts are ordered "
    "OLDEST→NEWEST. When two facts about the same entity+attribute conflict (e.g. two different "
    "residences for Rachel), the one with the LATER date is the current truth — use it and "
    "discard the earlier value, regardless of how many times the earlier value is repeated. "
    "Recency by date OVERRIDES frequency.\n"
    "Each consolidated fact is ONE self-contained sentence. Do NOT produce counts or "
    "enumerations of collections (those are handled elsewhere and are error-prone). If no "
    "current-state fact is clearly supported, return an empty list. Output at most 10."
)

_MAX_INPUT_FACTS = 1500  # see ALL facts (stores hold ~1000); flash has huge context.


def _fact_texts(db_path: str) -> list[str]:
    """Read all distilled fact values from the store (read-only), CHRONOLOGICALLY
    ORDERED and date-prefixed.

    Knowledge-update questions ("where did Rachel move to?") fail when the
    consolidator can't tell which of two conflicting facts is newer and defaults
    to the more-repeated (stale) value — e.g. it kept "Rachel lives in Chicago"
    over the more-recent "moved to the suburbs". Prefixing each fact with its
    `first_seen` date and feeding them oldest→newest lets the consolidator pick
    the LATEST value per (entity, attribute) by recency, not salience.
    """
    sys.path.insert(0, ".")
    from triplestore import TripleStore
    st = TripleStore(db_path)
    rows: list[tuple[str, str]] = []  # (first_seen, value)
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
            if not (v and isinstance(v, str) and len(v) > 8):
                continue
            fs = attrs.get("first_seen", [""])
            fs = fs[0] if isinstance(fs, list) else fs
            rows.append((str(fs or ""), v.strip()))
    finally:
        try:
            st.close()
        except Exception:
            pass
    # Sort oldest→newest so the LLM sees temporal order (empty dates sort first).
    rows.sort(key=lambda r: r[0])
    # de-dup identical values, keep (earliest) order; prefix with date.
    seen, uniq = set(), []
    for fs, v in rows:
        if v in seen:
            continue
        seen.add(v)
        uniq.append(f"[{fs[:10]}] {v}" if fs else v)
    return uniq


_STATE_PATTERNS = re.compile(
    r"\b(moved (?:back )?(?:to|into)|relocat\w+ to|now lives? (?:in|at)|"
    r"just moved|recently moved|moved away|moved out|switched to|"
    r"started (?:working|a new job)|now works? (?:at|as)|got a new (?:job|place|apartment))\b",
    re.IGNORECASE,
)


def _raw_state_mentions(db_path: str, limit: int = 30) -> list[str]:
    """Surface state-change sentences (relocations, job changes) from RAW chunks.

    Distillation gaps put the gold answer for knowledge-update questions ONLY in
    raw — e.g. 'Rachel actually just moved back to the suburbs again' is in the
    transcript but was never distilled into a Rachel-residence fact, so the
    consolidator (facts-only) keeps the stale 'Chicago'. We pull the salient
    state-change sentences from raw and feed them alongside the facts so the
    consolidator can state the CURRENT value. Content-agnostic (verb patterns,
    not question/entity-specific). Bounded to avoid attention dilution.
    """
    try:
        from raw_store import _sidecar_path
        sidecar = _sidecar_path(db_path)
    except Exception:
        return []
    if not sidecar.exists():
        return []
    out: list[str] = []
    seen: set[str] = set()
    try:
        for line in sidecar.open():
            try:
                rec = json.loads(line)
            except Exception:
                continue
            for sent in re.split(r"(?<=[.!?])\s+", rec.get("text", "")):
                s = sent.strip()
                if 12 < len(s) < 240 and _STATE_PATTERNS.search(s):
                    key = s.lower()
                    if key not in seen:
                        seen.add(key)
                        out.append(s)
                        if len(out) >= limit:
                            return out
    except Exception:
        pass
    return out


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
        # Raw state-change sentences the distiller dropped (distillation gaps put
        # knowledge-update gold ONLY in raw, e.g. 'Rachel moved to the suburbs').
        raw_mentions = _raw_state_mentions(db_path)
        raw_block = ""
        if raw_mentions:
            raw_block = (
                "\n\nAdditional VERBATIM transcript sentences (raw source — these may "
                "contain the LATEST state the numbered facts above missed; treat them as "
                "the most recent evidence when they state a move/change):\n"
                + "\n".join(f"R{i+1}. {s}" for i, s in enumerate(raw_mentions))
            )
        from common import call_llm
        raw = call_llm(
            _SYSTEM,
            "Input facts:\n" + numbered + raw_block,
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
                out.append({"text": s.strip(), "kind": "recon"})
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
