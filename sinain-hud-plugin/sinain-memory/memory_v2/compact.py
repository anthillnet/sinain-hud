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
# P2 extraction depth: dedicated experiences pass (enumeration-complete events
# per person). The measured failure mode it targets: recall questions that ask
# "what has X done / which places / what activities" fail on COVERAGE — the
# rubric-driven generic pass drops minor-but-attested experiences, and no
# read-side change can serve a fact that was never stored. Flag-gated while
# under measurement; the version suffix keys separate caches.
EVENTS_PASS = os.environ.get("SINAIN_V2_EVENTS_PASS", "0") == "1"
# e1 → e2: internal bench (real work meeting) showed e1 transcribing the
# session's own conduct as "experiences" (138 speech-act facts = 58% of the
# store → retrieval buried, 3.36 → 2.58). e2 = out-of-session criterion +
# English output + deterministic speech-act gate below.
EVENTS_V = os.environ.get("SINAIN_V2_EVENTS_V", "1")
PROMPT_VERSION = ("v3-clean-2s" if SEG_SUMMARIES else "v3-clean-1") + (
    f"-e{EVENTS_V}" if EVENTS_PASS else "")
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


_EVENTS_SYSTEM_E1 = """You are the experiences extraction pass of a memory system.
Input: one dated conversation session observed by an always-on assistant.
Output STRICT JSON, nothing else:
{"experiences": [{"who": "...", "what": "...", "date": "YYYY-MM-DD", "companions": ["..."]}]}

Goal: a COMPLETE enumeration of what each named person did, experienced,
attended, created, bought, read, watched, visited or went through, as the
session attests. Recall later asks "what has this person done / which places /
which titles / what activities" — every missed item is an unanswerable
question, so list EVERY distinct experience, including minor ones.

Rules:
- who: the person the experience belongs to — never pronouns. One entry per
  person per distinct experience; if Dana and her brother both attended a
  pottery class, emit an entry for each of them.
- what: one self-contained clause, specifics verbatim (titles, places, brands,
  amounts): "took a pottery class at a community studio", "finished reading
  The Copper Field", "adopted a beagle named Chip".
- date: the event date if stated or inferable, else the session date.
- companions: other NAMED people who shared the experience, if any.
- Attested only — no inference beyond the session, no world knowledge.
- EXCLUDE: the conversation itself (telling/asking/chatting is not an
  experience), the assistant's own actions, hypotheticals, plans not yet
  carried out, and generic statements with no specific referent.
"""

_EVENTS_SYSTEM_E2 = """You are the experiences extraction pass of a memory system.
Input: one dated conversation session observed by an always-on assistant.
Output STRICT JSON, nothing else:
{"experiences": [{"who": "...", "what": "...", "date": "YYYY-MM-DD", "companions": ["..."]}]}

Goal: a COMPLETE enumeration of the real-world experiences this session
REPORTS: what each named person did, attended, created, bought, read,
watched, visited or went through OUTSIDE this conversation. Recall later asks
"what has this person done / which places / which titles / what activities" —
every missed item is an unanswerable question, so list EVERY distinct
reported experience, including minor ones.

THE TEST: an experience exists independently of this session — the session
only reports it. If deleting the conversation would erase the event itself,
it is session conduct, NOT an experience. Never emit entries for what someone
said, asked, proposed, suggested, joked, thought, opined, agreed, explained,
demonstrated or decided WITHIN the session — those are the conversation.
When speech reports an underlying event, extract the event, not the speech:
"I recorded a demo video back in March while I was in Georgia" → {"who":
"<speaker>", "what": "recorded a demo video in Georgia", "date": "<March>"} —
never "recalled recording a video".

Rules:
- who: the person the experience belongs to — never pronouns. One entry per
  person per distinct experience; if Dana and her brother both attended a
  pottery class, emit an entry for each of them.
- what: one self-contained clause IN ENGLISH regardless of the conversation
  language; specifics verbatim (titles, places, brands, amounts): "took a
  pottery class at a community studio", "finished reading The Copper Field",
  "adopted a beagle named Chip".
- date: the event date if stated or inferable, else the session date.
- companions: other NAMED people who shared the experience, if any.
- Attested only — no inference beyond the session, no world knowledge.
- EXCLUDE: hypotheticals, plans not yet carried out, the assistant's own
  actions, and generic statements with no specific referent.
"""

_EVENTS_SYSTEM = _EVENTS_SYSTEM_E2 if EVENTS_V == "2" else _EVENTS_SYSTEM_E1

# Deterministic backstop for the out-of-session criterion (gates live in
# code, not in prompt hopes): an English events fact opening with a speech/
# cognition act is session conduct. Underlying events survive because e2
# instructs extracting them in event form ("recorded a demo video ...").
_SPEECH_ACT_RE = re.compile(
    r"^(?:(?:also |then |later )?(?:said|says|asked|asks|proposed|proposes|"
    r"suggested|suggests|mentioned|mentions|noted|notes|joked|jokes|thought|"
    r"thinks|opined|believes|believed|wondered|wonders|agreed|agrees|"
    r"disagreed|explained|explains|discussed|discusses|recalled|recalls|"
    r"remembered|remembers|expressed|expresses|stated|states|told|tells|"
    r"replied|replies|answered|answers|shared (?:that|his|her|their)|"
    r"talked|talks|spoke|speaks|commented|comments|complained|complains|"
    r"admitted|admits|confirmed|confirms|denied|denies|argued|argues|"
    r"pointed out|points out|wrote in (?:the )?chat|sent (?:a )?(?:link|message))\b)",
    re.IGNORECASE,
)


def _speech_act_gate(recs: list[dict]) -> tuple[list[dict], int]:
    kept = [r for r in recs
            if isinstance(r, dict)
            and not _SPEECH_ACT_RE.search(str(r.get("what", "")).strip())]
    return kept, len(recs) - len(kept)


def _salvage_json_list(raw: str, list_key: str) -> "list[dict] | None":
    """Recover a complete prefix of a max_tokens-truncated JSON array: cut at
    the last complete object and close the brackets. Enumeration outputs are
    order-independent, so a complete prefix is strictly better than nothing."""
    start = raw.find("{")
    if start < 0:
        return None
    cut = raw.rfind("},")
    if cut <= start:
        return None
    try:
        data = json.loads(raw[start:cut + 1] + "]}")
        if isinstance(data, dict) and isinstance(data.get(list_key), list):
            return data[list_key]
    except ValueError:
        pass
    return None


def _extract_events(session_text: str, session_date: str, model: str) -> list[dict]:
    """Dedicated experiences pass (P2 depth). Fail-open: []."""
    from common import call_llm
    user = f"Session date: {session_date or 'unknown'}\n\n## Session\n{session_text[:24000]}"
    for attempt in range(2):
        try:
            # 6000 tokens: enumeration over a long session is the one output
            # that legitimately runs long — a 3500 cap truncated real meetings.
            raw = call_llm(system_prompt=_EVENTS_SYSTEM, user_prompt=user, model=model,
                           max_tokens=6000, temperature=0.0, seed=211 + attempt)
            m = re.search(r"\{.*\}", raw, re.DOTALL)
            recs = None
            if m:
                try:
                    data = json.loads(m.group(0))
                    if isinstance(data, dict) and isinstance(data.get("experiences"), list):
                        recs = data["experiences"]
                except ValueError:
                    pass  # truncated at max_tokens — salvage the complete prefix
            if recs is None:
                recs = _salvage_json_list(raw, "experiences")
                if recs is not None:
                    print(f"[v2-compact] events pass: salvaged {len(recs)} entries "
                          "from truncated output", file=sys.stderr)
            if recs is not None:
                kept, rej = _speech_act_gate(recs)
                if rej:
                    print(f"[v2-compact] events pass: speech-act gate rejected "
                          f"{rej}/{len(recs)}", file=sys.stderr)
                return kept
        except Exception as e:
            if attempt == 1:
                print(f"[v2-compact] events pass failed (fail-open): {str(e)[:120]}",
                      file=sys.stderr)
    return []


def _extract_people(session_text: str, session_date: str, model: str) -> list[dict]:
    """Dedicated per-domain pass (Synthius pattern). Fail-open: []."""
    from common import call_llm
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
    from common import call_llm
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

    # 3. Same-date near-duplicate merge (only needed once multiple extraction
    #    passes can word one claim two ways): keep the more detailed text,
    #    union provenance. Deterministic; keeps depth passes from double-
    #    storing a claim and diluting retrieval with its own echo. Test is
    #    CONTAINMENT, not Jaccard — the duplication signature is one wording
    #    nearly containing the other ("went hiking at Blue Ridge" ⊂ "... with
    #    her brother"); two distinct same-day events share far fewer tokens.
    def _containment(x: str, y: str) -> float:
        tx, ty = set(_norm(x).split()), set(_norm(y).split())
        if len(tx) < 3 or len(ty) < 3:
            return 0.0
        return len(tx & ty) / min(len(tx), len(ty))

    drop: set[str] = set()
    if EVENTS_PASS:
        for group in groups.values():
            for i, a in enumerate(group):
                if a.id in drop:
                    continue
                for b in group[i + 1:]:
                    if b.id in drop or a.valid_at != b.valid_at:
                        continue
                    if _containment(a.fact, b.fact) > 0.85:
                        keep, lose = (a, b) if len(a.fact) >= len(b.fact) else (b, a)
                        keep.episode_ids = sorted(set(keep.episode_ids) | set(lose.episode_ids))
                        drop.add(lose.id)
                        if lose is a:
                            break
    return [f for f in by_id.values() if f.id not in drop]


LINK_VERSION = "link-1"  # cache key for raw LLM rows; validation is post-cache


def _content_tokens(text: str) -> set:
    from memory_v2.retrieve import _tokens
    return {t for t in _tokens(text) if len(t) >= 3}


def _is_bridge(out_text: str, src_texts: list) -> bool:
    """Composition-validity gate (the v1-linker lesson, measured at n=200):
    a REAL resolution (a) bridges tokens from two different sources that no
    single source contains together — 'moved' from S1 + 'Sweden' from S2 —
    and (b) is not materially longer than its longest source (a resolution
    substitutes a referent; a concatenated list is the union of its sources
    and fails this). Both deterministic."""
    ot = _content_tokens(out_text)
    sts = [_content_tokens(t) for t in src_texts if t]
    if len(sts) < 2 or not ot:
        return False
    if len(ot) > max(len(st) for st in sts) + 1:
        return False  # concatenation, not composition
    for i in range(len(sts)):
        for j in range(len(sts)):
            if i == j:
                continue
            uniq_i = (ot & sts[i]) - sts[j]
            uniq_j = (ot & sts[j]) - sts[i]
            if not uniq_i or not uniq_j:
                continue
            # novel pairing: no single source holds a token from each side
            for a in uniq_i:
                for b in uniq_j:
                    if not any(a in st and b in st for st in sts):
                        return True
    return False


def link_facts(facts: list[Fact], *, model: str = DEFAULT_MODEL,
               cache_dir: "str | Path | None" = None) -> list[Fact]:
    """Reference-chain resolution WITHIN one subject's fact sheet (multi-hop
    at write time — Synthius: do the inference once at compaction, not per
    question). "Moved from her home country 4 years ago" + "home country:
    Sweden" -> "moved from Sweden 4 years ago", provenance = both source
    facts. HARD guards (the adversarial win must not regress): one subject
    per call — cross-person joins are impossible by construction; >=2 cited
    sources; no outside knowledge; deterministic subject check on output.
    Own cache stage — does not invalidate the extraction cache."""
    # DEFAULT OFF (measured 2026-07-03, n=200): the linker emitted keyword-
    # dense RESTATEMENTS rather than true chain resolutions; they outranked
    # and displaced the atomic facts multi-hop needed (20/40 -> 14/40,
    # overall 68 -> 65). Before re-enabling, add a composition-validity gate:
    # the output must contain content tokens from BOTH sources that never
    # co-occur in either source alone (a real bridge test, not source-count).
    if os.environ.get("SINAIN_V2_LINK", "0") == "0":
        return []
    from collections import defaultdict
    groups: dict[str, list[Fact]] = defaultdict(list)
    for f in facts:
        if not f.invalid_at:
            groups[_norm(f.subject)].append(f)
    # Largest sheets first — reference chains live where facts accumulate.
    cand = sorted((g for g in groups.values() if len(g) >= 4),
                  key=len, reverse=True)[:6]
    out: list[Fact] = []
    for group in cand:
        subject = group[0].subject
        lines = [f"{i+1}. [{f.valid_at}] ({f.domain}) {f.fact}"
                 for i, f in enumerate(group[:40])]
        key = hashlib.sha256(("\n".join(lines) + f"|{LINK_VERSION}|{model}")
                             .encode()).hexdigest()[:16]
        cpath = Path(cache_dir) / f"link-{key}.json" if cache_dir else None
        if cpath and cpath.exists():
            rows = json.loads(cpath.read_text(encoding="utf-8"))
        else:
            from common import call_llm
            try:
                raw = call_llm(
                    system_prompt=(
                        "You resolve reference chains within ONE person's fact "
                        "sheet. Emit facts that COMBINE two or more listed facts "
                        "to state something no single fact states alone — e.g. "
                        "'moved from her home country 4 years ago' + 'home "
                        "country: Sweden' -> 'moved from Sweden 4 years ago'.\n"
                        'STRICT JSON: {"facts": [{"fact": "...", "domain": '
                        '"people|events|preferences|decisions|endeavors", '
                        '"date": "YYYY-MM-DD", "sources": [1, 4]}]}\n'
                        "Rules: the missing piece MUST be explicit in another "
                        "listed fact; cite >=2 sources; NEVER use outside "
                        "knowledge; NEVER attribute another person's fact to "
                        "this person; empty list when nothing resolves."),
                    user_prompt=f"Person: {subject}\n\n" + "\n".join(lines),
                    model=model, max_tokens=1200, temperature=0.0, seed=42)
                m = re.search(r"\{.*\}", raw, re.DOTALL)
                rows = (json.loads(m.group(0)).get("facts") if m else []) or []
            except Exception as e:
                print(f"[v2-link] {subject}: failed (fail-open): {str(e)[:80]}",
                      file=sys.stderr)
                rows = []
            if cpath:
                cpath.parent.mkdir(parents=True, exist_ok=True)
                cpath.write_text(json.dumps(rows, ensure_ascii=False),
                                 encoding="utf-8")
        for r in rows:
            if not isinstance(r, dict):
                continue
            text = str(r.get("fact", "")).strip()
            srcs = [i for i in (r.get("sources") or []) if isinstance(i, int)
                    and 1 <= i <= len(group)]
            dom = str(r.get("domain", "")).strip().lower()
            if len(text) < 8 or len(srcs) < 2:
                continue  # structural gate: composition requires >=2 sources
            if not _is_bridge(text, [group[i - 1].fact for i in srcs]):
                continue  # bridge-token gate: restatement/list-merge, not a resolution
            if dom not in DOMAINS:
                dom = "events"
            src_facts = [group[i - 1] for i in srcs]
            out.append(Fact(
                id=_fact_id(dom, subject, text),
                domain=dom, subject=subject, fact=text,
                valid_at=str(r.get("date", "") or src_facts[0].valid_at)[:10],
                layers=sorted({l for sf in src_facts for l in sf.layers}),
                episode_ids=sorted({e for sf in src_facts for e in sf.episode_ids}),
                meta={"pass": "link", "sources": [sf.id for sf in src_facts]},
            ))
    if out:
        print(f"[v2-link] resolved {len(out)} chained facts "
              f"across {len(cand)} subjects")
    return out


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
            res.facts = res.facts + link_facts(res.facts, model=model,
                                               cache_dir=cache_dir)
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
        # Pass 3 (P2 depth): enumeration-complete experiences. Same schema
        # gates as everything else — code decides admission, not the model.
        if EVENTS_PASS:
            for rec in _extract_events(text, date, model):
                if not isinstance(rec, dict):
                    continue
                who = str(rec.get("who", "")).strip()
                what = str(rec.get("what", "")).strip()
                if not who or len(what) < 8:
                    continue
                comps = [str(c).strip() for c in (rec.get("companions") or [])
                         if str(c).strip() and str(c).strip().lower() != who.lower()]
                ftext = what + (f" (with {', '.join(comps)})" if comps else "")
                raw_facts.append(Fact(
                    id=_fact_id("events", who, ftext),
                    domain="events", subject=who, fact=ftext,
                    valid_at=str(rec.get("date", "") or date)[:10],
                    layers=layers, episode_ids=ep_ids,
                    meta={"session_index": si, "pass": "events"},
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
        stats={"sessions": len(sessions),
               "llm_calls": n_calls * (3 if EVENTS_PASS else 2),  # generic + people (+ events) per session
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
    res.facts = res.facts + link_facts(res.facts, model=model, cache_dir=cache_dir)
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
