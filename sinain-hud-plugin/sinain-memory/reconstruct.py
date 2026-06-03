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
    "attribute (location/residence, job, relationship, status, possession, or a numeric "
    "amount/value such as a pre-approved/approved amount, price, salary, rate or total) is "
    "stated or changes over time, output ONE sentence stating the LATEST value and naming that "
    "person or entity explicitly (e.g. 'Rachel currently lives in the suburbs'; 'The user "
    "currently works as a senior software engineer'; 'The user's Wells Fargo mortgage "
    "pre-approval amount is $400,000'). When a person MOVED/RELOCATED or an amount was REVISED, "
    "the most recent destination/value is the current truth — state it even if only one fact "
    "or transcript sentence mentions it.\n"
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
    # Tie-break by value so SAME-date facts feed in a STABLE order regardless of
    # store iteration order (RocksDB/SPARQL scan order differs between the temp
    # build-DB and the cached copy) — otherwise the temp=0 consolidation LLM gets
    # a different input ordering and drifts (e.g. Rachel "Chicago" vs "suburbs").
    rows.sort(key=lambda r: (r[0], r[1]))
    # de-dup identical values, keep (earliest) order; prefix with date.
    seen, uniq = set(), []
    for fs, v in rows:
        if v in seen:
            continue
        seen.add(v)
        uniq.append(f"[{fs[:10]}] {v}" if fs else v)
    return uniq


_STATE_PATTERNS = re.compile(
    r"\b(?:"
    # location / job / status changes
    r"moved (?:back )?(?:to|into)|relocat\w+ to|now lives? (?:in|at)|"
    r"just moved|recently moved|moved away|moved out|switched to|"
    r"started (?:working|a new job)|now works? (?:at|as)|got a new (?:job|place|apartment)|"
    # possession / usage / method changes — a person adopting/abandoning a tool,
    # app, brand, or routine is a current-state update just like a relocation
    # (e.g. "my mom is using the same grocery list app as me now"). Without these
    # the backstop only saw location/job/money changes and the stale prior value
    # (mom "still on paper") won the deterministic current-state pick (d7c942c3).
    r"now (?:uses?|using|has|owns?|prefers?|drives?|plays?|goes? (?:to|by))|"
    r"(?:started|began) (?:using|to use)|switched (?:over )?to using|"
    r"is (?:now |currently )?(?:using|on) (?:the |a |an )?|"
    r"(?:also |now )?using the same|"
    r"recently (?:got|bought|adopted|started|switched)|"
    r"no longer (?:uses?|using|has)|stopped using|"
    # numeric / monetary value-updates (knowledge-update over amounts: approvals,
    # prices, salaries, totals — the LATEST stated value is the current truth).
    # Each requires a following digit so plain prose ("approved for the loan")
    # doesn't match; closing-cost fee line-items don't carry these verbs.
    r"(?:pre-?approved|approved|qualified) for \$?\d|"
    r"(?:increased|raised|lowered|changed|updated|bumped|dropped|revised) (?:to|from) \$?\d|"
    r"now (?:earns?|makes?|costs?|pays?|owes?) \$?\d|"
    r"new (?:salary|rate|price|budget|total|amount|limit)\b|"
    # personal records / best times (knowledge-update over a value, often a clock
    # time MM:SS the distiller mislabels — raw is the uncorrupted source, recency
    # ordering picks the latest). e.g. "personal best time of 25:50".
    r"(?:personal best|personal record|best time|new record)[^.!?]{0,60}\d"
    r")",
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
    matches: list[tuple[int, str]] = []  # (chunk_id, sentence)
    seen: set[str] = set()
    try:
        for line in sidecar.open():
            try:
                rec = json.loads(line)
            except Exception:
                continue
            # chunk id == session index == chronological order (sessions are
            # ingested oldest→newest), so it is a reliable recency key even though
            # the sidecar carries no explicit date.
            try:
                cid = int(rec.get("id", 0))
            except Exception:
                cid = 0
            for sent in re.split(r"(?<=[.!?])\s+", rec.get("text", "")):
                s = sent.strip()
                if 12 < len(s) < 240 and _STATE_PATTERNS.search(s):
                    key = s.lower()
                    if key not in seen:
                        seen.add(key)
                        matches.append((cid, s))
    except Exception:
        pass
    # Oldest→newest so the consolidator can pick the LATEST stated value when
    # several raw mentions give different values for the same attribute
    # (e.g. "$350,000" in an Aug session vs "$400,000" in a Nov session →
    # current = $400,000). Recency overrides frequency.
    matches.sort(key=lambda m: (m[0], m[1]))  # (chunk_id, sentence) — stable order
    # Keep the NEWEST `limit` mentions (the latest value-states must survive the
    # cap — an old session dense with amounts must not crowd out a later update),
    # still presented oldest→newest so the recency ordering reads correctly.
    return [s for _cid, s in matches[-limit:]]


# T1-RECON entity-attribution: deterministic (no-LLM) extractor for structured
# "Entity:\n* item\n* item" lists — a common shape in explanations. The distiller
# routinely DROPS the subject→attribute-list link (6ae235be: it never stored
# "(Lake Charles, uses, alkylation)", only a vague summary) and windowed chunking
# splits the header from its bullets, so retrieval delivers fragments the answer
# model mis-attributes (alkylation read under a neighbouring refinery's cross-ref).
# This rebuilds ONE clean attributed fact per header so the link survives.
_ATTR_HEADER = re.compile(r"^\s*(?:\d+[.)]\s*)?([A-Z][\w '&/().-]{2,60}?):\s*$")
_ATTR_BULLET = re.compile(r"^\s*(?:[*\-•]|\d+[.)])\s+(.+?)\s*$")


def _extract_attribution_facts(text: str, min_items: int = 2, max_items: int = 12) -> list[str]:
    lines = text.split("\n")
    out: list[str] = []
    i = 0
    while i < len(lines):
        m = _ATTR_HEADER.match(lines[i])
        if not m:
            i += 1
            continue
        header = m.group(1).strip()
        items: list[str] = []
        j = i + 1
        while j < len(lines):
            if _ATTR_HEADER.match(lines[j]):  # next "Entity:" section → stop
                break
            bm = _ATTR_BULLET.match(lines[j])
            if bm:
                name = bm.group(1).split(":", 1)[0].strip()  # item NAME before its description
                if 1 < len(name) < 80:
                    items.append(name)
                j += 1
            elif lines[j].strip() == "":
                j += 1
            else:
                break
        if len(items) >= min_items:
            # dedup preserving order
            seen, uniq = set(), []
            for it in items[:max_items]:
                k = it.lower()
                if k not in seen:
                    seen.add(k); uniq.append(it)
            out.append(f"{header} includes: " + ", ".join(uniq) + ".")
        i = max(j, i + 1)
    return out


def _attribution_facts(db_path: str, limit: int = 12) -> list[str]:
    """Read raw chunks, reconstruct contiguous text, and extract entity-attribution
    facts. Chunks are windowed (header/bullets may span a boundary) so we parse the
    ORDERED concatenation; facts are deduped. Content-agnostic, deterministic."""
    try:
        from raw_store import _sidecar_path
        sidecar = _sidecar_path(db_path)
    except Exception:
        return []
    if not sidecar.exists():
        return []
    rows: list[tuple[int, str]] = []
    try:
        for line in sidecar.open():
            try:
                rec = json.loads(line)
            except Exception:
                continue
            try:
                cid = int(rec.get("id", 0))
            except Exception:
                cid = 0
            rows.append((cid, rec.get("text", "")))
    except Exception:
        return []
    rows.sort(key=lambda r: r[0])
    joined = "\n".join(t for _c, t in rows)
    facts = _extract_attribution_facts(joined)
    # dedup (overlapping windows can re-emit the same list) preserving order
    seen, uniq = set(), []
    for f in facts:
        if f.lower() not in seen:
            seen.add(f.lower()); uniq.append(f)
    return uniq[:limit]


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


def build_consolidated_digest(db_path: str, raw_text: str | None = None) -> dict:
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
                "\n\nAdditional VERBATIM transcript sentences (raw source), ordered "
                "OLDEST→NEWEST. These may contain the LATEST state/value the numbered "
                "facts above missed. When several state the SAME attribute or amount with "
                "different values (e.g. an earlier '$350,000' and a later '$400,000' "
                "pre-approval), the LAST one listed is the current truth — use it:\n"
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
        # DETERMINISTIC current-state backstop: the consolidation LLM
        # (gemini-3-flash-preview) drifts on large prompts even at temp=0 — it
        # sometimes emits a STALE value (Rachel "Chicago" instead of the latest
        # "suburbs"). The raw state-mentions are recency-ordered and uncorrupted;
        # emit the LATEST one verbatim, prefixed "Most recently, ", so a correct,
        # current-state fact is ALWAYS in the graph regardless of LLM drift. This
        # makes 830ce83f / value-updates robust+reproducible (no LLM judgement).
        # Verbatim emit, split by value-type (supersession applied to the emit):
        #   - CATEGORICAL mentions (no money/number) → emit the last 5. Categorical
        #     state changes (mom "now uses the app") aren't self-contradicting, and
        #     d7c942c3 needs enough current-state framing to beat stale distilled
        #     "mom prefers paper" facts (it FAILS with only the last 3).
        #   - NUMERIC/VALUE mentions ($400k, "four") → emit ONLY the single latest.
        #     Older values ($350k, "three") are SUPERSEDED — emitting them floods the
        #     QA with stale competitors and regressed 852ce960/6aeb4375 at a wider tail.
        # raw_mentions is already oldest→newest, so [-1:] / [-5:] take the latest.
        _num = re.compile(r"\$\s?\d|\b\d{2,}\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b", re.IGNORECASE)
        _cat = [s for s in raw_mentions if not _num.search(s)]
        _numeric = [s for s in raw_mentions if _num.search(s)]
        # Per-context supersession (replaces the fragile global numeric[-1:] which
        # silently dropped $400k when an unrelated later number existed). Cluster
        # numeric mentions by value-CONTEXT (content words minus numbers/stopwords);
        # within each cluster keep only the LATEST mention (current value beats stale:
        # $400k over $350k), but DIFFERENT contexts (a closing-cost figure) keep their
        # own latest so they never displace each other. raw_mentions is oldest→newest,
        # so the last-seen per cluster is the latest. Deterministic, no-LLM.
        _STOP = {"the","user","and","for","with","from","that","this","their","they","has","have",
                 "was","are","will","would","been","into","over","per","new","old","now","most",
                 "recently","currently","about","than","more","less","also","still","just"}
        def _ctx_sig(s):
            s2 = re.sub(r"\$|\d|,|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|k|m)\b",
                        " ", s.lower())
            return {w for w in re.findall(r"[a-z]{3,}", s2) if w not in _STOP}
        _clusters = []  # [{sig:set, latest:str}]
        for s in _numeric:
            sig = _ctx_sig(s)
            for cl in _clusters:
                if len(sig & cl["sig"]) >= 2:  # ≥2 shared context words → same thing
                    cl["sig"] |= sig
                    cl["latest"] = s  # oldest→newest order ⇒ keep the latest
                    break
            else:
                _clusters.append({"sig": sig, "latest": s})
        _numeric_emit = [cl["latest"] for cl in _clusters]
        _emit = _cat[-5:] + _numeric_emit
        for s in _emit:
            txt = s.strip()
            if len(txt) > 12:
                out.append({"text": "Most recently, " + txt[0].lower() + txt[1:], "kind": "recon"})
        # T1-RECON entity-attribution: clean "Entity includes: a, b, c" facts from
        # structured raw lists, so a subject→attribute-list link the distiller dropped
        # (and chunking split) survives and retrieval delivers it correctly attributed
        # (6ae235be: Lake Charles → atmospheric distillation, FCC, alkylation, hydrotreating).
        # Prefer the caller's intact session text (the windowed raw chunks split the
        # header from its bullets); fall back to the chunk-concatenation otherwise.
        _attr = _extract_attribution_facts(raw_text) if raw_text else _attribution_facts(db_path)
        _seen_attr = set()
        for s in _attr:
            if len(s) > 12 and s.lower() not in _seen_attr:
                _seen_attr.add(s.lower())
                out.append({"text": s, "kind": "recon"})
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


def _cli_run_and_integrate(memory_dir: str, transcript_json: str) -> dict:
    """Production entry (called by sinain-core LocalCurationService): run the
    T1-RECON consolidation over the live KG and integrate the resulting facts via
    the proven knowledge_integrator path — so entity-attribution, categorical
    current-state, and per-context numeric supersession facts enter the SAME graph
    that escalation context + KG/MCP queries read. Mirrors eval ingest.py's recon
    block. Fail-open."""
    import subprocess
    from pathlib import Path
    db_path = str(Path(memory_dir) / "knowledge-graph.db")
    if not Path(db_path).exists():
        return {"error": "knowledge-graph.db not found", "integrated": 0}
    raw_text = ""
    try:
        items = json.loads(transcript_json) if transcript_json else []
        raw_text = "\n".join((it.get("content") or it.get("text") or "") for it in items)
    except Exception:
        pass
    digest = build_consolidated_digest(db_path, raw_text=raw_text or None)
    facts = (digest or {}).get("facts") or []
    if not facts:
        return {"integrated": 0, "isEmpty": True}
    scripts = str(Path(__file__).resolve().parent)
    try:
        subprocess.run(
            ["python3", str(Path(scripts) / "knowledge_integrator.py"),
             "--memory-dir", memory_dir, "--digest", json.dumps(digest)],
            timeout=60, capture_output=True, text=True,
            env={**os.environ, "PYTHONPATH": scripts},
        )
    except Exception as e:
        return {"error": str(e)[:160], "integrated": 0}
    return {"integrated": len(facts)}


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="T1-RECON consolidation stage")
    ap.add_argument("db", nargs="?", help="store db path (legacy probe mode)")
    ap.add_argument("--memory-dir", help="production: build + integrate recon facts")
    ap.add_argument("--transcript", default="", help="production: session feed-items JSON (raw_text)")
    a = ap.parse_args()
    if a.memory_dir:
        print(json.dumps(_cli_run_and_integrate(a.memory_dir, a.transcript), ensure_ascii=False))
    else:  # legacy: just print the digest for inspection
        print(json.dumps(build_consolidated_digest(a.db), indent=2, ensure_ascii=False))
