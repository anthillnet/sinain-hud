#!/usr/bin/env bash
set -euo pipefail

# ── Assemble the full Sinain.app: overlay shell + bundled backend (REAL) ─────
# SEED-001 Stage 4/6. Copies the staged backend (build/stage/Resources/*) into
# a freshly built overlay .app's Contents/Resources/, producing a single
# self-contained bundle. Does NOT sign — that's sign step (Stage 6).
#
# Prereqs:
#   tools/dmg/stage-backend.sh          → build/stage/Resources/
#   flutter build macos --release       → overlay .app
#
# Usage: tools/dmg/assemble-app.sh [overlay.app] [out.app]

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_APP="${1:-$REPO/overlay/build/macos/Build/Products/Release/sinain_hud.app}"
OUT_APP="${2:-$REPO/build/Sinain.app}"
STAGE_RES="$REPO/build/stage/Resources"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
fail() { printf "\033[0;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

[ -d "$SRC_APP" ] || fail "overlay app not found: $SRC_APP (run: flutter build macos --release)"
[ -d "$STAGE_RES" ] || fail "staged backend not found: $STAGE_RES (run: tools/dmg/stage-backend.sh)"

bold "Copying overlay shell → $OUT_APP"
rm -rf "$OUT_APP"
mkdir -p "$(dirname "$OUT_APP")"
cp -R "$SRC_APP" "$OUT_APP"

bold "Embedding bundled backend into Contents/Resources/"
# Copy EVERY staged top-level item (node, sinain-core, sck-capture, scripts,
# sinain-agent-runner, sinain-mcp-server, sense_client, sinain-memory, …). Iterating
# the stage dir rather than a hardcoded list so new staged components can't be
# silently dropped from the bundle.
staged_any=false
for path in "$STAGE_RES"/*; do
  [ -e "$path" ] || continue
  item="$(basename "$path")"
  rm -rf "$OUT_APP/Contents/Resources/$item"
  cp -R "$path" "$OUT_APP/Contents/Resources/$item"
  staged_any=true
done
$staged_any || fail "no staged items found in $STAGE_RES"
for required in node/bin/node sinain-core sck-capture scripts/launch-backend.sh; do
  [ -e "$OUT_APP/Contents/Resources/$required" ] || fail "bundle missing required item: $required"
done
chmod +x "$OUT_APP/Contents/Resources/scripts/launch-backend.sh"
chmod +x "$OUT_APP/Contents/Resources/node/bin/node"
chmod +x "$OUT_APP/Contents/Resources/sck-capture/sck-capture"

bold "Checking assembled bundle hygiene (warning only)"
if ! "$REPO/tools/dmg/check-binary-hygiene.sh" "$OUT_APP"; then
  printf "\033[0;33m⚠ Binary hygiene check reported violations; review before release.\033[0m\n" >&2
fi

bold "✓ Assembled $OUT_APP"
du -sh "$OUT_APP" 2>/dev/null | awk '{print "  size: "$1}'
