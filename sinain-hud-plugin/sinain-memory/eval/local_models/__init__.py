"""Phase A — Local-model evaluation harness.

This package benches candidate local models for the v2 memory architecture
(L2 vision + L3 extraction). See docs/memory-v2-local-first.md § "Phase A"
and .planning/phases/12-memory-redesign/00-PLAN.md for scope and methodology.

Public benchmark scores land in `results/`. Private scores land in
`.planning/eval-internal/` (gitignored — see BLOCKING CONSTRAINT 1 in the
phase plan).
"""
