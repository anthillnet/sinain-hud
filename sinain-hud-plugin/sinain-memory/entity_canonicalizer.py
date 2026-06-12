#!/usr/bin/env python3
"""E1 — deterministic entity canonicalization (phonetic + fuzzy).

Catches entity-name variants that the write-time difflib dedup (0.90 ratio in
``knowledge_integrator._find_matching_entity``) MISSES — especially the noisy
spellings weak local distillers and ASR produce, e.g. "City Bank" → "Citibank"
or "Mustapha" → "Mustafa". These sit at edit-ratios ~0.80–0.88, below the 0.90
difflib floor, so they fragment the entity graph into near-duplicate nodes and
weaken entity-backref retrieval / hop expansion — the failure mode is worst for
local mode, which is the default privacy path.

Mechanism (DETERMINISTIC, no LLM, no gazetteer):
  1. Metaphone gate — both names must share a Metaphone code (jellyfish). This
     is the phonetic-equivalence signal ("citybank" / "citibank" → STBNK).
  2. RapidFuzz confirm — fuzz.ratio on the compact (de-hyphen/space) forms must
     clear a floor, so phonetic collisions on dissimilar spellings are rejected.
  3. Prefix/suffix guard — block when one name is the other plus a short
     alphanumeric suffix (german→germany, gemma→gemma4, llama variants). This
     GENERALIZES the hand-maintained _DEDUP_SKIP_PAIRS instead of enumerating it.

Intentionally NOT handled: hard ASR substitutions with no phonetic overlap
(e.g. "Jad veins" → "JetBrains", Metaphone JTFNS≠JTBRNS, ratio 0.59). Those
require a domain gazetteer / hotword list and are a separate concern — a generic
canonicalizer must under-merge rather than risk false positives (which keeps
LongMemEval neutral while still consolidating local-distiller fragmentation).
"""
from __future__ import annotations

# Below this compact length, Metaphone codes collide too easily to trust.
_MIN_LEN = 4
# RapidFuzz fuzz.ratio floor on compact forms. city-bank/citibank=87.5,
# mustafa/mustapha=80.0 are real variants we want; citibank/citi-group=47.1 and
# python/postgres=28.6 are correctly excluded.
_RATIO_FLOOR = 80.0
# Block "X" vs "X + <=N alnum chars" (germany, gemma4) — a distinct entity, not
# a misspelling.
_PREFIX_SUFFIX_GUARD = 3


def _compact(s: str) -> str:
    return s.replace("-", "").replace(" ", "").replace("_", "")


def _is_prefix_variant(a: str, b: str) -> bool:
    """True when one compact name is the other plus a short alnum suffix."""
    lo, hi = sorted((a, b), key=len)
    return bool(lo) and hi.startswith(lo) and 0 < len(hi) - len(lo) <= _PREFIX_SUFFIX_GUARD


def phonetic_fuzzy_match(
    name: str,
    candidates,
    skip_pairs=None,
) -> str | None:
    """Best phonetic+fuzzy canonical match for ``name`` among ``candidates``.

    ``candidates`` may be a dict ``{name: node_id}`` or any iterable of names.
    Returns the matched candidate NAME (caller maps it to a node id), or None.
    Names are expected pre-normalized (lowercase, hyphenated) by the caller's
    ``_normalize_entity``. Returns None (no-op) if jellyfish/rapidfuzz are
    unavailable, so callers degrade gracefully to their existing logic.
    """
    try:
        import jellyfish as jf
        from rapidfuzz import fuzz
    except ImportError:
        return None

    skip_pairs = skip_pairs or set()
    ca = _compact(name)
    if len(ca) < _MIN_LEN:
        return None
    code_a = jf.metaphone(ca)
    if not code_a:
        return None

    names = candidates.keys() if hasattr(candidates, "keys") else candidates
    best: str | None = None
    best_ratio = _RATIO_FLOOR
    for cand in names:
        if cand == name:
            continue
        if frozenset({name, cand}) in skip_pairs:
            continue
        cb = _compact(cand)
        if len(cb) < _MIN_LEN:
            continue
        if jf.metaphone(cb) != code_a:
            continue
        if _is_prefix_variant(ca, cb):
            continue
        r = fuzz.ratio(ca, cb)
        if r >= best_ratio:
            best_ratio = r
            best = cand
    return best


if __name__ == "__main__":
    # Self-test: calibrated against real entity-pair signals.
    SKIP = {frozenset({"german", "germany"}), frozenset({"llama", "ollama"})}
    should = [
        ("city-bank", {"citibank": "entity:citibank"}, "citibank"),
        ("mustapha", {"mustafa": "entity:mustafa"}, "mustafa"),
        ("react-native", {"react native": "x"}, "react native"),
    ]
    shouldnt = [
        ("german", {"germany": "x"}),       # prefix-suffix variant
        ("gemma", {"gemma4": "x"}),         # prefix-suffix variant
        ("citibank", {"citi-group": "x"}),  # metaphone differs
        ("python", {"postgres": "x"}),      # nothing in common
        ("alice", {"bob": "x"}),
    ]
    ok = True
    for name, cands, exp in should:
        got = phonetic_fuzzy_match(name, cands, SKIP)
        status = "OK" if got == exp else "FAIL"
        if got != exp:
            ok = False
        print(f"  [{status}] match {name!r} -> {got!r} (expected {exp!r})")
    for name, cands in shouldnt:
        got = phonetic_fuzzy_match(name, cands, SKIP)
        status = "OK" if got is None else "FAIL"
        if got is not None:
            ok = False
        print(f"  [{status}] no-match {name!r} -> {got!r} (expected None)")
    print("ALL PASS" if ok else "FAILURES ABOVE")
