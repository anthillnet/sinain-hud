#!/usr/bin/env python3
"""Coreference resolution — Stage A of discourse reconstruction.

Resolves pronouns (he/she/it/they/I/...) to the named entity they refer to,
ACROSS turns, BEFORE distillation. This is a deterministic pipeline stage (not
a distiller-prompt instruction) so it works identically regardless of the
distiller model — important because local models are the default (privacy mode)
and may ignore complex prompt instructions. See
.planning/phases/discourse-reconstruction/00-PLAN.md § E3 (Stage A).

Mechanism: fastcoref (f-coref, a small distilled coref model) clusters
coreferent spans across the whole transcript; we replace each PRONOUN span with
its cluster's representative named mention. Conservative by design — only
pronoun spans are rewritten (full noun phrases are left alone), and the whole
thing falls back to the original text if fastcoref is missing or errors.

Opt-in via SINAIN_COREF=1 (so the bench can A/B it cleanly). NOTE: when this is
enabled in an ingest path, add coreference.py to ingest._PIPELINE_VERSION_FILES
so the store cache invalidates on coref-logic changes.
"""

from __future__ import annotations

import os
import sys

# First/second/third-person pronouns we will rewrite when coref links them to a
# named antecedent. Possessives + reflexives included. Matched case-insensitively
# against the exact mention span text.
_PRONOUNS = {
    "he", "him", "his", "himself",
    "she", "her", "hers", "herself",
    "it", "its", "itself",
    "they", "them", "their", "theirs", "themselves",
    "i", "me", "my", "mine", "myself",
    "we", "us", "our", "ours", "ourselves",
    "you", "your", "yours", "yourself", "yourselves",
}

_model = None


def _get_model():
    global _model
    if _model is None:
        import logging
        logging.getLogger("fastcoref").setLevel(logging.ERROR)
        # Compat shim: transformers >=5.x's _finalize_model_loading calls
        # `model.all_tied_weights_keys.keys()`, but fastcoref's older
        # FCorefModel never sets that attribute. Provide an empty dict on the
        # class so loading succeeds. (Env's transformers is 5.9 per the
        # 2026-05-25 force-upgrade.) Harmless if upstream later defines it.
        try:
            from fastcoref.coref_models.modeling_fcoref import FCorefModel
            if not hasattr(FCorefModel, "all_tied_weights_keys"):
                FCorefModel.all_tied_weights_keys = {}
        except Exception:
            pass
        from fastcoref import FCoref
        # CPU keeps us off the GPU that local Ollama distillation uses.
        _model = FCoref(device="cpu")
    return _model


def _representative(mentions: list[tuple[int, int, str]]) -> str | None:
    """Pick a cluster's canonical mention: prefer a proper-noun-looking,
    non-pronoun mention; among those, the longest. Returns None if the cluster
    is all pronouns (nothing concrete to resolve to)."""
    concrete = [m for m in mentions if m[2].lower().strip() not in _PRONOUNS]
    if not concrete:
        return None

    def score(m: tuple[int, int, str]) -> tuple[int, int]:
        t = m[2].strip()
        proper = 1 if (t[:1].isupper() and t.lower() not in _PRONOUNS) else 0
        return (proper, len(t))

    concrete.sort(key=score, reverse=True)
    return concrete[0][2].strip()


def resolve_coref(text: str) -> str:
    """Rewrite pronoun spans in `text` with their coref cluster's representative
    named mention. Returns text unchanged on any failure."""
    if not text or not text.strip():
        return text
    try:
        model = _get_model()
        preds = model.predict(texts=[text])
        clusters = preds[0].get_clusters(as_strings=False)  # [[(start,end),...],...]
    except Exception as e:  # missing dep, model download fail, runtime error
        print(f"[coref] disabled (non-fatal): {e}", file=sys.stderr)
        return text

    repls: list[tuple[int, int, str]] = []
    for cluster in clusters:
        mentions = [(s, e, text[s:e]) for (s, e) in cluster]
        rep = _representative(mentions)
        if not rep:
            continue
        for (s, e, t) in mentions:
            if t.lower().strip() in _PRONOUNS and t.strip() != rep:
                repls.append((s, e, rep))

    if not repls:
        return text
    # Apply right-to-left so earlier offsets stay valid.
    repls.sort(key=lambda r: r[0], reverse=True)
    out = text
    for (s, e, rep) in repls:
        out = out[:s] + rep + out[e:]
    return out


def resolve_items(items: list[dict]) -> list[dict]:
    """Resolve coreference across the concatenated transcript of feed items,
    rewriting each item's `text`. Cross-turn references resolve because the
    whole transcript is processed as one document. No-op unless SINAIN_COREF is
    truthy; safe fallback to the original items on any mismatch/error.

    Mentions are noun phrases that never span a newline, so joining items with
    '\\n' and splitting the resolved doc back by '\\n' preserves the 1:1 item
    mapping (replacements only change span contents, not newline count)."""
    # Default-ON (2026-06-02): cross-turn pronoun resolution is a deterministic
    # production-robustness stage (validated: "He migrated" -> "Sam migrated"),
    # now that E1 entity-canonicalization is on. Set SINAIN_COREF=0 to disable.
    if os.environ.get("SINAIN_COREF", "1").lower() not in ("1", "true", "yes"):
        return items
    if not items:
        return items
    try:
        texts = [(it.get("text", "") or "") for it in items]
        doc = "\n".join(texts)
        resolved = resolve_coref(doc)
        parts = resolved.split("\n")
        if len(parts) != len(items):
            print(
                f"[coref] line-count mismatch ({len(parts)} vs {len(items)}); "
                "falling back to unresolved items",
                file=sys.stderr,
            )
            return items
        out = []
        for it, t in zip(items, parts):
            ni = dict(it)
            ni["text"] = t
            out.append(ni)
        return out
    except Exception as e:
        print(f"[coref] resolve_items failed (non-fatal): {e}", file=sys.stderr)
        return items


if __name__ == "__main__":
    demo = (
        "Sam joined the payments team last year.\n"
        "He migrated the billing service to the new queue.\n"
        "The queue has cut latency, and he says it is far more reliable now."
    )
    os.environ["SINAIN_COREF"] = "1"
    print("--- before ---")
    print(demo)
    print("--- after ---")
    print(resolve_coref(demo))
