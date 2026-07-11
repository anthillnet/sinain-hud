"""Tiered compaction — understanding as a background job over T1 episodes.

DESIGN-MEMORY-V2.md: capture is deterministic; the LLM runs LATER, over
episodes, as budgeted compaction. This module implements:

  tier 1: per-session summary (short free text — small-LLM-safe)
  tier 2: typed-domain fact extraction with a durability rubric
  deterministic consolidation: exact dedup + bi-temporal slot supersession

Facts are a DERIVED INDEX: they carry episode/session provenance and are
always re-derivable, so a bad extraction batch is droppable, never permanent
store damage. Extraction failures fail open — episodes remain fully queryable.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path

_koog_dir = str(Path(__file__).resolve().parent.parent)
if _koog_dir not in sys.path:
    sys.path.insert(0, _koog_dir)

from memory_v2.store import EpisodeStore

# Per-segment English summaries: tried 2026-07-02, REGRESSED LoCoMo 74-78% →
# 64% (fact quality diluted by the extra output task; summary tokens also
# double-count in ranking) with no internal gain (2.86 → 2.69). Kept behind a
# flag for future local-mode experiments; default OFF restores the v1 prompt
# and its warm caches.
SEG_SUMMARIES = os.environ.get("SINAIN_V2_SEG_SUMMARIES", "0") == "1"
PROMPT_VERSION = "v3-clean-2s" if SEG_SUMMARIES else "v3-clean-1"
DEFAULT_MODEL = os.environ.get("SINAIN_V2_MODEL", "google/gemini-2.5-flash")

DOMAINS = ("people", "events", "preferences", "decisions", "endeavors")

_SEGMENTS_SCHEMA = ', "segments": {"0": "...", "1": "..."}' if SEG_SUMMARIES else ""
_SEGMENTS_RULES = ("""
segments: for EVERY [SEGMENT n], 1-2 English sentences covering its concrete
specifics — names, numbers, jokes, decisions, topics — not vague gist. If the
conversation is not in English, these summaries are the English index of it:
preserve translatable specifics.
""" if SEG_SUMMARIES else "")

_SYSTEM = f"""You are the memory compaction stage of an always-on assistant.
Input: one dated conversation session observed by the assistant{", split into numbered segments marked [SEGMENT n]" if SEG_SUMMARIES else ""}.
Output: STRICT JSON, nothing else:
{{"summary": "..."{_SEGMENTS_SCHEMA}, "facts": [{{"domain": "...", "subject": "...", "fact": "...", "date": "YYYY-MM-DD"}}]}}

summary: 1-2 sentences, what happened in this session (in English).
{_SEGMENTS_RULES}
facts: durable, attested knowledge only — what would still matter in a week.
Domains:
- people: identities, relationships, roles, life circumstances of named people
- events: dated experiences that happened to someone (trips, purchases,
  appointments, incidents, milestones) — include WHO and WHAT specifically
- preferences: stated likes/dislikes/tastes/habits of a named person
- decisions: choices, commitments, plans someone explicitly made
- endeavors: ongoing projects, jobs, studies, undertakings and their status

Rules:
- Each fact is atomic and self-contained: name the person (never pronouns),
  one claim per fact, specific nouns kept verbatim (brands, places, titles).
- date: the event date if stated or inferable, else the session date. Dates in
  structured form, never inside prose.
- Extract ONLY what the conversation attests. No inferences beyond it, no
  world knowledge, no speculation.
- SKIP: small talk, greetings, generic statements, the assistant's own words,
  transient chatter with no durable referent. Fewer good facts beat many weak
  ones — but do not drop specific dated events or named attributes.
- Write facts in English regardless of the conversation language.
"""


_PEOPLE_SYSTEM = """You are the people/relationship extraction pass of a memory system.
Input: one dated conversation session observed by an always-on assistant.
Output STRICT JSON, nothing else:
{"people": [{"name": "...", "aliases": ["..."],
             "attributes": [{"attribute": "...", "value": "...", "date": "YYYY-MM-DD"}],
             "relationships": [{"person": "...", "relation": "..."}]}]}

Rules:
- One entry per real person: every speaker and every named person discussed.
- attributes: identity-grade facts, as key-value pairs. Guiding taxonomy
  (open — emit any attribute the conversation attests):
  residence & origins; family & close relations (and what is known about
  them); education & career; health; significant possessions and how they
  were acquired or from whom; dated milestones; stated plans.
  Be specific; keep proper nouns verbatim; English values.
- Attribute facts reachable only through another person still belong to the
  named person: "Priya's brother lives in Toronto" yields Priya →
  {"attribute": "brother's residence", "value": "Toronto"} (and an entry for
  the brother himself if he is discussed as a person).
- relationships: explicit relations between NAMED people (friend, partner,
  mother, grandmother, colleague, classmate...).
- aliases: nicknames/short forms actually used in the session.
- Attested only. Skip people mentioned only in passing with zero attributes.
"""


def _extract_people(session_text: str, session_date: str, model: str) -> list[dict]:
    """Dedicated per-domain pass (Synthius pattern). Fail-open: []."""
    from memory_v2.llm import call_llm
    user = f"Session date: {session_date or 'unknown'}\n\n## Session\n{session_text[:24000]}"
    for attempt in range(2):
        try:
            raw = call_llm(system_prompt=_PEOPLE_SYSTEM, user_prompt=user, model=model,
                           max_tokens=3000, temperature=0.0, seed=137 + attempt)
            m = re.search(r"\{.*\}", raw, re.DOTALL)
            if m:
                data = json.loads(m.group(0))
                if isinstance(data, dict) and isinstance(data.get("people"), list):
                    return data["people"]
        except Exception as e:
            if attempt == 1:
                print(f"[v2-compact] people pass failed (fail-open): {str(e)[:120]}",
                      file=sys.stderr)
    return []


def resolve_aliases(person_records: list[dict]) -> dict[str, str]:
    """Deterministic cross-session entity resolution → alias→canonical map.

    Conservative merges only: exact lowercase match, LLM-attested aliases, and
    single-token first-name ⊂ full-name containment. No fuzzy matching — a
    wrong merge poisons every downstream subject-join.
    """
    canon: dict[str, str] = {}   # lower name/alias → canonical display name
    counts: dict[str, int] = {}
    for rec in person_records:
        name = str(rec.get("name", "")).strip()
        if not name:
            continue
        counts[name] = counts.get(name, 0) + 1
        canon.setdefault(name.lower(), name)
        for al in rec.get("aliases") or []:
            al = str(al).strip()
            if al and len(al) > 1:
                canon.setdefault(al.lower(), name)
    # First-name containment: "priya" → "Priya Sharma" when unambiguous.
    fulls = [n for n in {v for v in canon.values()} if " " in n]
    for short_l in list(canon):
        if " " in short_l:
            continue
        matches = {f for f in fulls if f.lower().split()[0] == short_l}
        if len(matches) == 1:
            canon[short_l] = next(iter(matches))
    return canon


@dataclass
class Fact:
    id: str
    domain: str
    subject: str
    fact: str
    valid_at: str = ""          # structured event date (YYYY-MM-DD)
    invalid_at: str = ""        # bi-temporal: set when superseded, never deleted
    superseded_by: str = ""
    layers: list[str] = field(default_factory=list)
    episode_ids: list[str] = field(default_factory=list)  # provenance (T1)
    meta: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class CompactionResult:
    facts: list[Fact] = field(default_factory=list)
    summaries: dict[int, str] = field(default_factory=dict)  # session_index → summary
    seg_summaries: dict[str, str] = field(default_factory=dict)  # episode_id → summary
    aliases: dict[str, str] = field(default_factory=dict)  # lower alias → canonical name
    stats: dict = field(default_factory=dict)


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower()).strip(" .")


def _fact_id(domain: str, subject: str, fact: str) -> str:
    return "f-" + hashlib.sha256(f"{domain}|{_norm(subject)}|{_norm(fact)}".encode()).hexdigest()[:12]


def _jaccard(a: str, b: str) -> float:
    ta, tb = set(_norm(a).split()), set(_norm(b).split())
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def _extract_session(session_text: str, session_date: str, model: str) -> dict:
    """One tier-1+2 LLM call per session. Fail-open: {} on any failure."""
    from memory_v2.llm import call_llm
    user = f"Session date: {session_date or 'unknown'}\n\n## Session\n{session_text[:24000]}"
    for attempt in range(2):
        try:
            raw = call_llm(
                system_prompt=_SYSTEM, user_prompt=user, model=model,
                max_tokens=3500, temperature=0.0, seed=42 + attempt,
            )
            m = re.search(r"\{.*\}", raw, re.DOTALL)
            if not m:
                continue
            data = json.loads(m.group(0))
            if isinstance(data, dict) and isinstance(data.get("facts"), list):
                return data
        except Exception as e:
            if attempt == 1:
                print(f"[v2-compact] session extraction failed (fail-open): {str(e)[:120]}",
                      file=sys.stderr)
    return {}


# Deterministic narration gate (enrichment-replay r1 finding): the junk that
# survives the LLM rubric has one signature — a generic subject + activity
# verb ("The user was browsing Gmail", "activity: editing X in Zed", "User ran
# the command ..."). That is presence data (T1 episodes), never a fact.
# Structural REJECT applied to fresh AND cached compaction output — the mem0
# lesson: gates live in code, not in prompt hopes.
try:  # canonical gate lives in sinain-memory/durability.py (shared with the
    # legacy integrator); fall back to the local copy when memory_v2 is used
    # standalone without the parent dir on sys.path.
    from durability import NARRATION_RE as _NARRATION_RE
except ImportError:
    _NARRATION_RE = re.compile(
        r"^(?:activity:|the (?:user|agent)\b.*?\b(?:was|is|were|began|continued|ran the command)\b"
        r".*?\b(?:brows|view|edit|review|read|work|watch|scroll|check|open|navigat|typ|us)"
        r"|(?:user|the user) (?:browsed|viewed|edited|reviewed|read|watched|scrolled|checked|opened|navigated|ran|executed))",
        re.IGNORECASE,
    )


def narration_gate(facts: list[Fact]) -> tuple[list[Fact], int]:
    kept = [f for f in facts
            if not _NARRATION_RE.search(f"{f.subject}: {f.fact}")
            and not _NARRATION_RE.search(f.fact)]
    return kept, len(facts) - len(kept)


def consolidate(facts: list[Fact]) -> list[Fact]:
    """Deterministic consolidation — code, not LLM (per Synthius/graphiti).

    1. Exact dedup on (domain, subject, normalized fact) — merges provenance.
    2. Slot supersession within (domain, subject): near-duplicate claims
       (Jaccard > 0.6) with different dates → the later-dated fact supersedes;
       the earlier gets invalid_at set (bi-temporal — history kept, never
       deleted). Dedup never crosses domains (§3.3: per-domain consolidation).
    """
    by_id: dict[str, Fact] = {}
    for f in facts:
        if f.id in by_id:
            keep = by_id[f.id]
            keep.episode_ids = sorted(set(keep.episode_ids) | set(f.episode_ids))
        else:
            by_id[f.id] = f

    from collections import defaultdict
    groups: dict[tuple[str, str], list[Fact]] = defaultdict(list)
    for f in by_id.values():
        groups[(f.domain, _norm(f.subject))].append(f)

    for group in groups.values():
        group.sort(key=lambda f: f.valid_at or "")
        for i, older in enumerate(group):
            if older.invalid_at:
                continue
            for newer in group[i + 1:]:
                if newer.invalid_at or not newer.valid_at or not older.valid_at:
                    continue
                if newer.valid_at > older.valid_at and _jaccard(older.fact, newer.fact) > 0.6:
                    older.invalid_at = newer.valid_at
                    older.superseded_by = newer.id
                    break
    return list(by_id.values())


def compact_store(
    store: EpisodeStore,
    *,
    model: str = DEFAULT_MODEL,
    cache_dir: str | Path | None = None,
    cache_key_extra: str = "",
) -> CompactionResult:
    """Run tiered compaction over a store's episodes, session by session.

    Cache: keyed on episode content + prompt version + model, so bench re-runs
    are free. Cache lives OUTSIDE the store — facts are derived, episodes are
    truth.
    """
    sessions: dict[int, list] = {}
    for ep in store.episodes:
        if ep.kind == "segment" and ep.text:
            sessions.setdefault(ep.meta.get("session_index", 0), []).append(ep)

    cache_path = None
    if cache_dir:
        blob = json.dumps(
            [[ep.id, ep.text] for eps in sessions.values() for ep in eps],
            sort_keys=True, ensure_ascii=False,
        )
        key = hashlib.sha256(
            f"{blob}|{PROMPT_VERSION}|{model}|{cache_key_extra}".encode()
        ).hexdigest()[:16]
        cache_path = Path(cache_dir) / f"compact-{key}.json"
        if cache_path.exists():
            data = json.loads(cache_path.read_text(encoding="utf-8"))
            _cached = [Fact(**f) for f in data["facts"]]
            _cached, _rej = narration_gate(_cached)
            res = CompactionResult(
                facts=_cached,
                summaries={int(k): v for k, v in data["summaries"].items()},
                seg_summaries=data.get("seg_summaries", {}),
                aliases=data.get("aliases", {}),
                stats=data.get("stats", {}),
            )
            print(f"[v2-compact] cache hit: {len(res.facts)} facts "
                  f"({cache_path.name})")
            _apply_summaries(store, res.summaries, res.seg_summaries)
            return res

    raw_facts: list[Fact] = []
    person_records: list[dict] = []
    summaries: dict[int, str] = {}
    seg_summaries: dict[str, str] = {}  # episode_id → English segment summary
    n_calls = 0
    for si in sorted(sessions):
        eps = sessions[si]
        if SEG_SUMMARIES:
            text = "\n".join(f"[SEGMENT {j}]\n{ep.text}" for j, ep in enumerate(eps))
        else:
            text = "\n".join(ep.text for ep in eps)
        date = (eps[0].t_start or "")[:10]
        data = _extract_session(text, date, model)
        n_calls += 1
        if not data:
            continue
        if isinstance(data.get("summary"), str):
            summaries[si] = data["summary"].strip()
        segs = data.get("segments")
        if isinstance(segs, dict):
            for j, ep in enumerate(eps):
                s = segs.get(str(j))
                if isinstance(s, str) and s.strip():
                    seg_summaries[ep.id] = s.strip()
        ep_ids = [ep.id for ep in eps]
        layers = sorted({l for ep in eps for l in ep.layers})
        # Pass 2: dedicated people/relationship extraction (deeper than the
        # generic pass — identity attributes, relations, possessive chains).
        for rec in _extract_people(text, date, model):
            name = str(rec.get("name", "")).strip()
            if not name:
                continue
            person_records.append(rec)
            for at in rec.get("attributes") or []:
                attr = str(at.get("attribute", "")).strip()
                val = str(at.get("value", "")).strip()
                if not attr or not val:
                    continue
                raw_facts.append(Fact(
                    id=_fact_id("people", name, f"{attr}: {val}"),
                    domain="people", subject=name, fact=f"{attr}: {val}",
                    valid_at=str(at.get("date", "") or date)[:10],
                    layers=layers, episode_ids=ep_ids,
                    meta={"session_index": si, "pass": "people"},
                ))
            for rel in rec.get("relationships") or []:
                other = str(rel.get("person", "")).strip()
                relation = str(rel.get("relation", "")).strip()
                if not other or not relation:
                    continue
                raw_facts.append(Fact(
                    id=_fact_id("people", name, f"{relation}: {other}"),
                    domain="people", subject=name, fact=f"{relation}: {other}",
                    valid_at=date, layers=layers, episode_ids=ep_ids,
                    meta={"session_index": si, "pass": "people"},
                ))
        for rf in data.get("facts", []):
            if not isinstance(rf, dict):
                continue
            domain = str(rf.get("domain", "")).strip().lower()
            subject = str(rf.get("subject", "")).strip()
            fact_text = str(rf.get("fact", "")).strip()
            if domain not in DOMAINS or not subject or len(fact_text) < 8:
                continue  # structural REJECT — schema gate, not model trust
            raw_facts.append(Fact(
                id=_fact_id(domain, subject, fact_text),
                domain=domain, subject=subject, fact=fact_text,
                valid_at=str(rf.get("date", "") or date)[:10],
                layers=layers, episode_ids=ep_ids,
                meta={"session_index": si},
            ))

    # Cross-session entity resolution: canonicalize EVERY fact subject (all
    # domains) through the alias map so dedup, supersession, subject-joins and
    # person profiles all see one name per person.
    aliases = resolve_aliases(person_records)
    for f in raw_facts:
        c = aliases.get(f.subject.strip().lower())
        if c:
            f.subject = c
            f.id = _fact_id(f.domain, c, f.fact)
    facts = consolidate(raw_facts)
    facts, _narr_rejected = narration_gate(facts)
    res = CompactionResult(
        facts=facts, summaries=summaries, seg_summaries=seg_summaries,
        aliases=aliases,
        stats={"sessions": len(sessions), "llm_calls": n_calls * 2,  # generic + people pass per session
               "raw_facts": len(raw_facts), "facts": len(facts),
               "superseded": sum(1 for f in facts if f.invalid_at),
               "narration_rejected": _narr_rejected},
    )
    print(f"[v2-compact] {res.stats}")

    if cache_path:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps({
            "facts": [f.to_dict() for f in facts],
            "summaries": summaries,
            "seg_summaries": seg_summaries,
            "aliases": aliases,
            "stats": res.stats,
        }, ensure_ascii=False), encoding="utf-8")

    _apply_summaries(store, res.summaries, res.seg_summaries)
    return res


def _apply_summaries(store: EpisodeStore, summaries: dict[int, str],
                     seg_summaries: dict[str, str] | None = None) -> None:
    """Attach tier-1 summaries to session AND segment episodes.

    Segment summaries are always English (see _SYSTEM): they are the
    cross-lingual index — retrieval tokenizes ep.summary alongside ep.text, so
    an English query can rank a Russian segment via its English summary."""
    seg_summaries = seg_summaries or {}
    for ep in store.episodes:
        if ep.kind == "session":
            s = summaries.get(ep.meta.get("session_index", -1))
            if s:
                ep.summary = s
        elif ep.kind == "segment":
            s = seg_summaries.get(ep.id)
            if s:
                ep.summary = s
