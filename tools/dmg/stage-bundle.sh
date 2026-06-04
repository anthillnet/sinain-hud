#!/usr/bin/env bash
set -euo pipefail

# ── SEED-001 Phase 2: assemble Sinain.app/Contents/Resources (SCAFFOLD) ──────
# Collects every build output into the .app bundle layout (docs/dmg-distribution-spec.md §3).
# Run AFTER: flutter build macos, npm run build (sinain-core), PyInstaller
# (sense_client), build-sck-universal.sh, prewarm-embedding.sh.
#
# Intended steps (NOT YET IMPLEMENTED):
#   APP="build/Sinain.app"
#   RES="$APP/Contents/Resources"
#   1. Copy Flutter overlay build → $APP (base bundle from flutter build macos).
#   2. Copy sinain-core/dist + prod node_modules → $RES/sinain-core/.
#   3. Stage bundled Node 22 runtime → $RES/node/.
#   4. Copy PyInstaller sense_client dist → $RES/sense_client/.
#   5. Copy universal sck-capture → $RES/sck-capture.
#   6. Copy pre-warmed embedding model → $RES/embedding-model/.
#   7. Write app-internal launch script → $RES/scripts/ (start.sh equivalent).
#   8. Embed Sparkle.framework → $APP/Contents/Frameworks/.
#   9. Patch Info.plist (bundle id, version, SUFeedURL).
#
# Signing + notarization happen in .github/workflows/release-app.yml (Phase 3),
# NOT here.

echo "tools/dmg/stage-bundle.sh is a scaffold stub — not yet implemented." >&2
echo "See docs/dmg-distribution-spec.md §3 (Bundle Layout) and §4 (sign/notarize)." >&2
exit 64
