#!/usr/bin/env bash
set -euo pipefail

# ── SEED-001 Phase 2: universal sck-capture build (SCAFFOLD / STUB) ──────────
# Produces a single fat binary (arm64 + x86_64) from tools/sck-capture so the
# DMG runs on both Apple Silicon and Intel Macs. See docs/dmg-distribution-spec.md §3.
#
# Intended steps (NOT YET IMPLEMENTED):
#   1. swift build -c release --arch arm64   (in tools/sck-capture)
#   2. swift build -c release --arch x86_64
#   3. lipo -create <arm64-bin> <x86_64-bin> -output dist/sck-capture
#   4. lipo -info dist/sck-capture   # verify "arm64 x86_64"
#
# Open question Q6: do we actually ship universal, or arm64-only? Resolve before
# implementing — arm64-only halves build time and bundle size.

echo "tools/dmg/build-sck-universal.sh is a scaffold stub — not yet implemented." >&2
echo "See docs/dmg-distribution-spec.md §3 (Bundle Layout) and §9 Q6." >&2
exit 64  # EX_USAGE — signals "intentionally not runnable yet"
