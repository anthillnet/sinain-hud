#!/usr/bin/env python3
"""ASR-C — training-free post-ASR Named-Entity Correction (prototype).

Our measured #1 bottleneck is proper-noun mangling in transcription
("Citibank"→"City Bank", "JetBrains"→"Jad veins", "Mustafa"→"Jeff Rains"); a
ground-truth clean transcript lifts end-to-end QA +76%. Stock Whisper/gemini-
audio expose no real biasing API, so we correct AFTER transcription — a model-
agnostic post-pass that reuses assets we already have:

  * GAZETTEER  — known entity names from the KG (entity:* nodes) + on-screen OCR
    text (the spoken names are literally on screen in Slack/IDE/docs) + any
    hotword list. A structural edge a pure-audio ASR pipeline lacks.
  * PHONETIC MATCHER — the Double-Metaphone + RapidFuzz matcher from
    entity_canonicalizer.py (built for E1 KG canonicalization).

Two tiers (DeRAGEC ACL'25 2506.07510 / Apple RAG-NEC ICASSP'25 2409.06062):
  1. DETERMINISTIC phonetic correction — replaces a transcript span with a
     gazetteer entry when they are phonetically equivalent (Metaphone-equal +
     high fuzzy ratio) but textually different. Catches acoustically-close
     errors (City Bank→Citibank). Cheap, no LLM. Conservative guards mirror
     E1's (min length, prefix-variant guard, common-word stoplist).
  2. LLM denoising (opt-in) — for harder/hallucinated errors with no acoustic
     overlap (Jeff Rains→Mustafa), hand the transcript + phonetically-retrieved
     candidate entities to an LLM that corrects ONLY on strong contextual
     evidence (error-prevention-priority — avoid the known LLM over-correction
     failure mode, RLLM-CF 2505.24347).

Status: PROTOTYPE. Validate on the acme real-capture bench (vs the +76%
clean-transcript ceiling) before wiring into the live capture/distill path.
"""
from __future__ import annotations

import re
import sys

try:  # reuse E1's compact-form normalizer
    from entity_canonicalizer import _compact
except Exception:  # pragma: no cover - standalone fallback
    def _compact(s: str) -> str:
        return s.replace("-", "").replace(" ", "").replace("_", "").lower()

# Conservative thresholds (mirror E1; deliberately bias toward UNDER-correction —
# a missed fix is cheap, a wrong fix poisons the graph).
_MIN_COMPACT_LEN = 4
_RATIO_FLOOR = 82.0          # RapidFuzz ratio on compact forms
_MAX_NGRAM = 3               # entities up to 3 words ("city bank", "acme group")
_PREFIX_SUFFIX_GUARD = 3

# Common words that must never be "corrected" into an entity on their own.
# (Multi-word spans bypass this — "city bank" is allowed to become "citibank".)
_COMMON_WORDS = {
    "the", "and", "for", "with", "this", "that", "from", "have", "what", "when",
    "where", "they", "their", "there", "about", "would", "could", "should",
    "bank", "city", "name", "team", "time", "year", "work", "user", "people",
    "thing", "things", "great", "good", "okay", "yeah", "right", "well", "going",
}


def _metaphone(s: str) -> str:
    try:
        import jellyfish
        return jellyfish.metaphone(s)
    except Exception:
        return ""


def _ratio(a: str, b: str) -> float:
    try:
        from rapidfuzz import fuzz
        return float(fuzz.ratio(a, b))
    except Exception:
        # crude fallback
        from difflib import SequenceMatcher
        return SequenceMatcher(None, a, b).ratio() * 100.0


def _norm(s: str) -> str:
    """Compact + lowercase — the key used for metaphone, ratio, and equality.
    (entity_canonicalizer._compact is case-PRESERVING, so 'CityBank' vs
    'Citibank' would score a misleadingly-low fuzzy ratio without lowercasing.)"""
    return _compact(s).lower()


def _is_prefix_variant(a: str, b: str) -> bool:
    lo, hi = sorted((a, b), key=len)
    return bool(lo) and hi.startswith(lo) and 0 < len(hi) - len(lo) <= _PREFIX_SUFFIX_GUARD


# ────────────────────────────── gazetteer ──────────────────────────────

def build_gazetteer(
    db_path: str | None = None,
    extra_terms: list[str] | None = None,
    min_len: int = 3,
) -> list[str]:
    """Collect known entity names: KG entity:* node names + OCR/hotword terms.

    Returns a de-duplicated list preserving canonical casing of the first
    occurrence. Safe to call with db_path=None (extra_terms only).
    """
    seen: dict[str, str] = {}  # lower → canonical-cased

    def _add(name: str) -> None:
        if not isinstance(name, str):
            return
        name = name.strip()
        if len(name) < min_len:
            return
        key = name.lower()
        if key not in seen:
            seen[key] = name

    if db_path:
        try:
            from triplestore import TripleStore
            store = TripleStore(db_path)
            for eid, val in store.entities_with_attr("name"):
                if str(eid).startswith("entity:"):
                    _add(str(val))
            store.close()
        except Exception as e:  # pragma: no cover
            print(f"[asr_nec] gazetteer KG load failed (non-fatal): {e}", file=sys.stderr)

    for t in (extra_terms or []):
        _add(t)

    return list(seen.values())


def _phonetic_index(gazetteer: list[str]) -> dict[str, list[tuple[str, str]]]:
    """metaphone(compact(name)) → [(compact, canonical), ...]."""
    idx: dict[str, list[tuple[str, str]]] = {}
    for name in gazetteer:
        c = _norm(name)
        if len(c) < _MIN_COMPACT_LEN:
            continue
        code = _metaphone(c)
        if not code:
            continue
        idx.setdefault(code, []).append((c, name))
    return idx


# ─────────────────────── deterministic phonetic pass ───────────────────────

_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9]*")


def _best_gazetteer_match(
    span_text: str, idx: dict[str, list[tuple[str, str]]]
) -> tuple[str, float, str] | None:
    """Best canonical name for a transcript span → (canonical, score, tier) or None.

    Two acceptance modes, both conservative:
      * normalize — same compact form, different surface ("Team City"→"TeamCity",
        "intellij"→"IntelliJ"): same entity, just canonicalize the surface.
      * phonetic  — different compact, Metaphone-equal + ratio>=floor + not a
        prefix-variant ("City Bank"→"Citibank").
    """
    c = _norm(span_text)
    if len(c) < _MIN_COMPACT_LEN:
        return None
    code = _metaphone(c)
    if not code or code not in idx:
        return None
    best: tuple[str, float, str] | None = None
    for cand_compact, cand_name in idx[code]:
        if cand_compact == c:
            # identical compact: normalize surface to canonical iff it differs
            if span_text != cand_name:
                return (cand_name, 100.0, "normalize")
            return None  # already exactly canonical → nothing to do
        if _is_prefix_variant(c, cand_compact):
            continue
        r = _ratio(c, cand_compact)
        if r >= _RATIO_FLOOR and (best is None or r > best[1]):
            best = (cand_name, r, "phonetic")
    return best


def phonetic_correct(
    text: str, gazetteer: list[str]
) -> tuple[str, list[dict]]:
    """Deterministic phonetic NEC. Returns (corrected_text, corrections).

    Greedy left-to-right scan, longest n-gram (up to _MAX_NGRAM) first, so
    multi-word entities ("city bank") are matched before their unigrams.
    """
    if not text or not gazetteer:
        return text, []
    idx = _phonetic_index(gazetteer)
    if not idx:
        return text, []

    # token spans with char offsets, so we can rebuild text with replacements
    toks = [(m.group(0), m.start(), m.end()) for m in _TOKEN_RE.finditer(text)]
    corrections: list[dict] = []
    out: list[str] = []
    last_char = 0
    i = 0
    while i < len(toks):
        matched = False
        for n in range(min(_MAX_NGRAM, len(toks) - i), 0, -1):
            words = [toks[i + k][0] for k in range(n)]
            span_text = " ".join(words)
            # single common word → skip (only multi-word spans may rewrite a
            # common token, e.g. "city bank")
            if n == 1 and words[0].lower() in _COMMON_WORDS:
                continue
            hit = _best_gazetteer_match(span_text, idx)
            if hit is None:
                continue
            canonical, score, tier = hit
            start = toks[i][1]
            end = toks[i + n - 1][2]
            out.append(text[last_char:start])
            out.append(canonical)
            last_char = end
            corrections.append({
                "from": text[start:end], "to": canonical,
                "ratio": round(score, 1), "tier": tier,
            })
            i += n
            matched = True
            break
        if not matched:
            i += 1
    out.append(text[last_char:])
    return "".join(out), corrections


# ─────────────────────── optional LLM denoising tier ───────────────────────

# LLM-tier candidate retrieval floor. MEASURED CEILING (2026-05-29): text-only
# correction can safely recover only the METAPHONE-EQUAL class. Low-acoustic-
# overlap mangles are unrecoverable post-hoc AND string-similarity misleads —
# "Jeff Rains"→jetbrains scores 77.8 (WRONG, should be Mustafa) while the
# correct "Jad veins"→jetbrains scores only 58.8, so NO ratio threshold
# separates them. We therefore restrict LLM candidates to metaphone-equal OR
# very-high ratio (>=88); genuinely-destroyed names need ASR-A base-model
# biasing (operates on the audio), not a text post-pass. The per-span candidate
# constraint still holds (a span can only map to its OWN candidate or KEEP).
_LLM_CAND_RATIO = 88.0
_LLM_CAND_K = 6

_NEC_SYSTEM = (
    "You fix speech-to-text errors in PROPER NOUNS. For each SUSPECT SPAN you are "
    "given a short list of CANDIDATE entities it might be a misrecognition of. "
    "For each span, choose EITHER one candidate from its own list (only if context "
    "makes it clearly that entity) OR \"KEEP\" to leave it unchanged. You may NOT "
    "invent replacements outside the given candidate list. When unsure, choose "
    "KEEP. Reply ONLY as compact JSON: {\"span text\": \"chosen candidate or KEEP\"}."
)


def _llm_candidates(span: str, gaz_norm: list[tuple[str, str]]) -> list[str]:
    """Loose phonetic neighbors of a span (Metaphone-equal OR ratio>=floor),
    top-K by ratio. Empty if the span has no plausible entity neighbor — such
    spans are NEVER sent to the LLM (so unrecoverable mangles stay untouched)."""
    c = _norm(span)
    if len(c) < _MIN_COMPACT_LEN:
        return []
    code = _metaphone(c)
    scored: list[tuple[float, str]] = []
    for cand_norm, cand_name in gaz_norm:
        if cand_norm == c:
            continue
        r = _ratio(c, cand_norm)
        if (code and _metaphone(cand_norm) == code) or r >= _LLM_CAND_RATIO:
            scored.append((r, cand_name))
    scored.sort(key=lambda x: -x[0])
    return [n for _, n in scored[:_LLM_CAND_K]]


def _suspect_spans(text: str, gaz_norm: list[tuple[str, str]]) -> dict[str, list[str]]:
    """Proper-noun-ish 1-2 word spans NOT already canonical, each with its loose
    phonetic candidate list. Only spans WITH candidates are returned."""
    toks = [(m.group(0), m.start(), m.end()) for m in _TOKEN_RE.finditer(text)]
    gaz_exact = {n for n, _ in gaz_norm}
    out: dict[str, list[str]] = {}
    for i in range(len(toks)):
        for n in (2, 1):
            if i + n > len(toks):
                continue
            words = [toks[i + k][0] for k in range(n)]
            if n == 1 and words[0].lower() in _COMMON_WORDS:
                continue
            # proper-noun-ish: at least one capitalized token (cheap heuristic)
            if not any(w[:1].isupper() for w in words):
                continue
            span = " ".join(words)
            if _norm(span) in gaz_exact:  # already a known entity
                continue
            if span in out:
                continue
            cands = _llm_candidates(span, gaz_norm)
            if cands:
                out[span] = cands
    return out


def llm_nec(
    text: str,
    gazetteer: list[str],
    model: str | None = None,
    max_tokens: int = 400,
) -> str:
    """Candidate-CONSTRAINED LLM correction (DeRAGEC pattern) for hard cases the
    deterministic tier misses (e.g. 'Jad veins'→'JetBrains'). The LLM may only
    map a suspect span to one of ITS phonetic candidates or KEEP — it cannot
    invent or cross-map, which blocks the over-correction we observed. Opt-in;
    one LLM call. Returns corrected text (or original on failure / no suspects).
    """
    if not text or not gazetteer:
        return text
    gaz_norm = [(_norm(g), g) for g in gazetteer if len(_norm(g)) >= _MIN_COMPACT_LEN]
    suspects = _suspect_spans(text, gaz_norm)
    if not suspects:
        return text
    try:
        import json
        from common import call_llm
        block = "\n".join(
            f'- "{s}": candidates = {cands}' for s, cands in suspects.items()
        )
        user = f"## Suspect spans (each with its allowed candidates)\n{block}\n\n## Transcript\n{text}"
        raw = call_llm(
            _NEC_SYSTEM, user, model=model or "google/gemini-2.5-flash",
            max_tokens=max_tokens, temperature=0.0, seed=42, json_mode=True,
        ).strip()
        mapping = json.loads(raw)
    except Exception as e:  # pragma: no cover
        print(f"[asr_nec] llm_nec failed (non-fatal): {e}", file=sys.stderr)
        return text

    corrected = text
    for span, choice in mapping.items():
        if span not in suspects:
            continue  # LLM hallucinated a span → ignore
        if choice == "KEEP" or choice not in suspects[span]:
            continue  # enforce: only a candidate of THIS span is applied
        corrected = re.sub(r"\b" + re.escape(span) + r"\b", choice, corrected)
    return corrected


def nec_correct(
    text: str,
    gazetteer: list[str],
    *,
    use_llm: bool = False,
    model: str | None = None,
) -> tuple[str, list[dict]]:
    """Full pass: deterministic phonetic correction, then (optional) LLM
    denoising over the SAME gazetteer for residual hard cases."""
    corrected, corrections = phonetic_correct(text, gazetteer)
    if use_llm:
        corrected = llm_nec(corrected, gazetteer, model=model)
    return corrected, corrections


if __name__ == "__main__":
    # Self-test: deterministic tier on real-style ASR mangles.
    gaz = ["Citibank", "JetBrains", "IntelliJ", "TeamCity", "Mustafa", "Acme Group"]
    cases = [
        ("We met with City Bank about the deal.", "Citibank"),       # phonetic hit
        ("He has used IntelliJ for ten years.", None),                # already correct → no change
        ("I went to the bank yesterday.", None),                      # common word → must NOT change
        ("Deploy it on Team City tonight.", "TeamCity"),              # 2-gram hit
    ]
    print("=== deterministic phonetic NEC ===")
    ok = True
    for text, expect in cases:
        out, corr = phonetic_correct(text, gaz)
        changed = [c["to"] for c in corr]
        if expect is None:
            good = (out == text)
        else:
            good = (expect in changed)
        ok &= good
        print(f"  [{'OK' if good else 'FAIL'}] {text!r}\n        -> {out!r}  {corr}")
    print("ALL PASS" if ok else "FAILURES ABOVE")
    print(
        "\nCEILING (measured): text-only NEC reliably recovers only the "
        "metaphone-equal class (City Bank->Citibank). Low-overlap mangles "
        "('Jad veins'->JetBrains 58.8, 'Jeff Rains'->Mustafa) are NOT safely "
        "recoverable post-hoc — string similarity misleads (Jeff Rains scores "
        "77.8 to JetBrains, the WRONG entity). Those need ASR-A base-model "
        "biasing on the audio. The LLM tier is restricted to metaphone-equal "
        "disambiguation to avoid over-correction."
    )
