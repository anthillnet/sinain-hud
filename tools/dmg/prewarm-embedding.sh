#!/usr/bin/env bash
set -euo pipefail

# ── SEED-001 Phase 2: pre-warm embedding model into the bundle (SCAFFOLD) ────
# sinain-core loads all-MiniLM-L6-v2 (384d) at startup for semantic dedup +
# retrieval. To avoid a first-run network fetch, bake the weights into the
# bundle at build time. See docs/dmg-distribution-spec.md §3.
#
# Intended steps (NOT YET IMPLEMENTED):
#   1. Resolve the model cache dir sinain-core's embedding service expects.
#   2. Download/copy all-MiniLM-L6-v2 weights into tools/dmg/staging/embedding-model/.
#   3. stage-bundle.sh copies that into Contents/Resources/embedding-model/.
#   4. At runtime, point the embedding service at the bundled path.

echo "tools/dmg/prewarm-embedding.sh is a scaffold stub — not yet implemented." >&2
echo "See docs/dmg-distribution-spec.md §3 (Bundle Layout)." >&2
exit 64
