"""ig.reduction — reduction-family sufficient-statistic scaffolds.

The meta-shape behind COUNT / DURATION / AGGREGATION / SUPERLATIVE (and, later, COMPARISON), found
to cover ~57% of LongMemEval in the 500-q survey: *retrieve a set of typed values → apply a
deterministic reducer → present the computed result*. Each shape is ONE operator over the same
member-extraction machinery; `_count_scaffold` (graph_query) is the `len` instance.

PURE: takes already-retrieved `items` (+ optional embeddings), never touches the store or the embed
service → unit-testable with synthetic data (see ig/tests). DETERMINISTIC-FILL-ONLY & FAIL-SAFE-OFF:
returns None whenever extraction is ambiguous — a wrong scaffold anchors the LLM on a hallucination,
which is worse than no scaffold. Conservatism rules are enforced per reducer (≥2 clean values,
single dominant unit, skip scaffold/raw-excerpt items).

This module is NEW and not yet wired into query_facts_hybrid — that one call-site edit (the only part
touching a bench-imported file) is deferred per the design. See
.planning/DESIGN-IG7-sufficient-statistic-framework.md §Reduction-scaffold API spec.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .linalg import cosine


@dataclass
class Reduction:
    op: str                       # count | sum | mean | argmax_max | argmax_min | recency_* | span_days
    value: str                    # the computed sufficient statistic, rendered as text
    members: list = field(default_factory=list)   # supporting inputs (audit + scaffold body)


# ── extraction utilities (deterministic) ───────────────────────────────────────────────────────
_NUM = re.compile(r"([€£$])?\s*(-?\d[\d,]*(?:\.\d+)?)\s*([%a-zA-Z]+)?")
_DATE = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
_UNIT_STOP = {"the", "a", "an", "of", "for", "in", "on", "at", "to", "and", "per", "is", "was", "i"}


def parse_number(text: str):
    """First salient number in `text` → (float, unit). unit is the currency symbol ('$'), else the
    trailing unit word lowercased ('hours', 'gb', 'miles'), else '' (bare number). None if no number."""
    if not text:
        return None
    m = _NUM.search(text)
    if not m:
        return None
    cur, num, suf = m.group(1), m.group(2), m.group(3)
    try:
        val = float(num.replace(",", ""))
    except ValueError:
        return None
    if cur:
        unit = cur
    elif suf and suf.lower() not in _UNIT_STOP:
        unit = suf.lower()
    else:
        unit = ""
    return val, unit


def parse_iso_date(text: str):
    """First YYYY-MM-DD in `text` (validated) → 'YYYY-MM-DD', else None."""
    if not text:
        return None
    m = _DATE.search(text)
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if not (1 <= mo <= 12 and 1 <= d <= 31):
        return None
    return f"{y:04d}-{mo:02d}-{d:02d}"


def _coerce(x):
    return x[0] if isinstance(x, list) else x


def _candidate_items(items):
    """Distilled items only (drop scaffolds and raw excerpts), value coerced to a string."""
    out = []
    for f in items or []:
        if f.get("kind") == "scaffold" or f.get("source") == "raw-excerpt":
            continue
        v = str(_coerce(f.get("value", ""))).strip()
        if v:
            out.append((v, f))
    return out


def _numbered(items):
    """[(text, value, unit)] for items whose text carries a number."""
    out = []
    for v, _f in _candidate_items(items):
        p = parse_number(v)
        if p is not None:
            out.append((v, p[0], p[1]))
    return out


def _dominant_unit(numbered):
    """Group by unit, return (unit, [(text,value)]) for the most populous group (ties → first seen).
    None if fewer than 2 values in the winning group (conservatism: don't reduce a singleton)."""
    if not numbered:
        return None
    groups: dict = {}
    for text, val, unit in numbered:
        groups.setdefault(unit, []).append((text, val))
    unit = max(groups, key=lambda u: len(groups[u]))
    if len(groups[unit]) < 2:
        return None
    return unit, groups[unit]


def _fmt_num(x: float) -> str:
    return str(int(x)) if abs(x - round(x)) < 1e-9 else f"{x:.2f}"


# ── reducers: items -> Reduction | None ─────────────────────────────────────────────────────────
def reduce_count(items, embs=None, dedup_cos: float = 0.78):
    """COUNT: cardinality of the deduplicated member set. Greedy semantic dedup over embeddings — a
    fact opens a new member iff cosine to every kept member < dedup_cos. Needs embeddings (no
    reliable dedup without them → None). `embs`: dict entity_id->vector OR list aligned to items."""
    if not items:
        return None
    def emb_for(i, f):
        if isinstance(embs, dict):
            return embs.get(f.get("entity_id", ""))
        if isinstance(embs, (list, tuple)):
            return embs[i] if i < len(embs) else None
        return None
    members = []  # (label, vec)
    for i, f in enumerate(items):
        if f.get("kind") == "scaffold" or f.get("source") == "raw-excerpt":
            continue
        e = emb_for(i, f)
        if e is None:
            continue
        if any(cosine(e, mv) >= dedup_cos for _, mv in members):
            continue
        members.append((str(_coerce(f.get("value", "")))[:70], e))
    if len(members) < 2:
        return None
    return Reduction("count", str(len(members)), [m for m, _ in members])


def reduce_sum(items):
    """AGGREGATION (sum) over the dominant single-unit numeric group."""
    g = _dominant_unit(_numbered(items))
    if g is None:
        return None
    unit, vals = g
    total = sum(v for _, v in vals)
    rendered = (unit + _fmt_num(total)) if unit in "€£$" else (_fmt_num(total) + (f" {unit}" if unit else ""))
    return Reduction("sum", rendered, [t for t, _ in vals])


def reduce_mean(items):
    """AGGREGATION (mean) over the dominant single-unit numeric group."""
    g = _dominant_unit(_numbered(items))
    if g is None:
        return None
    unit, vals = g
    avg = sum(v for _, v in vals) / len(vals)
    rendered = (unit + _fmt_num(avg)) if unit in "€£$" else (_fmt_num(avg) + (f" {unit}" if unit else ""))
    return Reduction("mean", rendered, [t for t, _ in vals])


def reduce_argmax(items, want: str = "max"):
    """SUPERLATIVE by extracted number: the item with the max (or min) numeric value."""
    nums = _numbered(items)
    if len(nums) < 2:
        return None
    pick = max(nums, key=lambda r: r[1]) if want == "max" else min(nums, key=lambda r: r[1])
    return Reduction(f"argmax_{want}", pick[0][:90], [f"{_fmt_num(v)}: {t[:50]}" for t, v, _ in nums])


def _dates(items):
    out = []
    for v, f in _candidate_items(items):
        oc = _coerce(f.get("occurred_at") or f.get("first_seen"))
        d = parse_iso_date(oc if isinstance(oc, str) else "") or parse_iso_date(v)
        if d:
            out.append((d, v))
    return out


def reduce_recency(items, want: str = "latest"):
    """SUPERLATIVE by date: the item with the latest (or earliest) occurred_at/date."""
    ds = _dates(items)
    if len(ds) < 2:
        return None
    pick = max(ds) if want == "latest" else min(ds)
    return Reduction(f"recency_{want}", pick[1][:90], [f"{d}: {t[:50]}" for d, t in sorted(ds)])


def reduce_span_days(items):
    """DURATION: elapsed days between the earliest and latest dated event, with the sorted timeline
    (so QA reads exact dates). Generalizes the #7 timeline scaffold into the reduction family."""
    ds = sorted(set(_dates(items)))
    if len(ds) < 2:
        return None
    from datetime import date
    a = date(*map(int, ds[0][0].split("-")))
    b = date(*map(int, ds[-1][0].split("-")))
    span = (b - a).days
    tl = "; ".join(f"{d}: {t[:60]}" for d, t in ds[:12])
    return Reduction("span_days", f"{span} days ({ds[0][0]} → {ds[-1][0]})", [tl])


# ── routing ─────────────────────────────────────────────────────────────────────────────────────
def detect_op(query: str):
    """Keyword router (the geometric is_*_query manifold is wired at the call-site later). Ordered:
    duration before count ('how many days' is duration); superlatives before aggregation."""
    if not query:
        return None
    s = query.lower()
    if re.search(r"how long|how many (?:days?|weeks?|months?|years?|hours?|minutes?|nights?)\b|how much time", s):
        return "span_days"
    if re.search(r"\bmost recent(?:ly)?\b|\blatest\b|\blast time\b", s):
        return "recency_latest"
    if re.search(r"\b(?:earliest|first time)\b|did i .*\bfirst\b", s):
        return "recency_earliest"
    if re.search(r"\b(?:most|highest|largest|biggest|greatest|maximum)\b", s):
        return "argmax_max"
    if re.search(r"\b(?:least|fewest|lowest|smallest|minimum)\b", s):
        return "argmax_min"
    if re.search(r"\b(?:average|on average)\b|\bper (?:day|week|month)\b", s):
        return "mean"
    if re.search(r"\b(?:total|altogether|combined|in total)\b|how much (?:money|did i spend|have i spent)", s):
        return "sum"
    if re.search(r"\bhow many\b|\bhow often\b|\bnumber of\b", s):
        return "count"
    return None


_REDUCERS = {
    "span_days": lambda items, embs: reduce_span_days(items),
    "recency_latest": lambda items, embs: reduce_recency(items, "latest"),
    "recency_earliest": lambda items, embs: reduce_recency(items, "earliest"),
    "argmax_max": lambda items, embs: reduce_argmax(items, "max"),
    "argmax_min": lambda items, embs: reduce_argmax(items, "min"),
    "mean": lambda items, embs: reduce_mean(items),
    "sum": lambda items, embs: reduce_sum(items),
    "count": lambda items, embs: reduce_count(items, embs),
}

_FRAMING = {
    "count": "Distinct items after deduplication ({n}): {body}. Count only those matching the question; the deduplicated total is {v}.",
    "sum": "Computed total from the retrieved values ({body}) = {v}. Use this exact sum.",
    "mean": "Computed average of the retrieved values ({body}) = {v}. Use this exact average.",
    "argmax_max": "Ranked by the stated quantity: {body}. The maximum is: {v}.",
    "argmax_min": "Ranked by the stated quantity: {body}. The minimum is: {v}.",
    "recency_latest": "Dated events (oldest→newest): {body}. The most recent is: {v}.",
    "recency_earliest": "Dated events (oldest→newest): {body}. The earliest is: {v}.",
    "span_days": "Dated event timeline (oldest→newest): {body}. Elapsed = {v}. Use these exact dates.",
}


def _format(r: Reduction):
    body = "; ".join(r.members) if r.op != "count" else "; ".join(f"{i+1}. {m}" for i, m in enumerate(r.members))
    text = _FRAMING[r.op].format(n=len(r.members), v=r.value, body=body[:1200])
    return {"entity_id": "scaffold:reduce", "kind": "scaffold", "op": r.op, "value": text}


def reduction_scaffold(query: str, items, embs=None):
    """Public entry. Route the query to a reduction operator, compute it deterministically over
    `items`, and return a kind=scaffold head-fact — or None (no op detected / extraction ambiguous /
    fail-safe). The caller prepends the returned dict to its results, behind its own env gate."""
    op = detect_op(query)
    if not op:
        return None
    try:
        r = _REDUCERS[op](items, embs)
    except Exception:
        return None
    if r is None:
        return None
    return _format(r)
