"""ig — Information-Geometry primitives library.

Factors the IG primitives (today scattered/duplicated across graph_query.py, intent_exemplars.py,
generic_background.py, knowledge_integrator.py) into one importable, unit-testable library. See
.planning/DESIGN-IG-primitives-library.md.

Design invariants:
- Pure geometry: primitives take VECTORS (or plain items), never call embed_client themselves.
- No store/IO coupling: call-sites own all store<->vector adaptation.
- Fail-safe-off: degenerate input returns a documented neutral default.
- Deterministic: no Date/random; stable tie-breaks.

This package is currently NEW code only — existing call-sites are NOT yet migrated (Phase 1 of the
design, gated on a clean store baseline). Importing `ig` has no effect on existing pipelines.
"""
