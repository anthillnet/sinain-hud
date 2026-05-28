"""Subsystem-ablation stubs (EVAL-01).

Each stub replaces ONE pipeline subsystem with a deterministic alternative
to isolate that subsystem's contribution to LongMemEval-S accuracy variance.

Dispatch:
    SINAIN_ABLATE = none | distiller | integrator | retrieval | schema
    SINAIN_ABLATE_MODE = passthrough | oracle

Read by:
    eval/benchmarks/ingest.py (L177 distiller, L197 integrator, _content_hash cache salt)
    eval/benchmarks/query.py (L77 retrieval)

D-03 (2026-05-26): schema_stub.py is reserved + raises NotImplementedError.
Schema ablation deferred to Phase 5 if bench identifies schema as dominant
variance source.
"""
