"""Schema ablation stub — DEFERRED per locked decision D-03 (2026-05-26).

Rationale: Schema is the most invasive ablation (write + read paths both swap;
no pluggable storage interface exists in triplestore.py today). Phase 1 ships
distiller + integrator + retrieval stubs which prove the env-var dispatch
pattern. If bench data identifies schema as the dominant variance source in
Phase 5's surgical rebuild loop, the stub is implemented then.

Env-var route still exists: SINAIN_ABLATE=schema is recognized by the
dispatcher but calling apply_schema_stub raises NotImplementedError loudly.
"""
from __future__ import annotations


def apply_schema_stub(*args, **kwargs):
    raise NotImplementedError(
        "Schema ablation deferred — Phase 5 if bench identifies schema as "
        "dominant variance source. See locked decision D-03 (2026-05-26)."
    )
