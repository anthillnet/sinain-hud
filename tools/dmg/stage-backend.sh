#!/usr/bin/env bash
set -euo pipefail

# ── Stage the self-contained backend into a bundle Resources layout (REAL) ───
# SEED-001 Phase 2, Stage 3. Assembles bundled Node + compiled sinain-core +
# prod node_modules + sck-capture into build/stage/Resources/, then writes the
# launch script the overlay .app will spawn. arm64-only (SPEC §9 Q6 default).
# sense_client (Python/OCR) is deferred from the MVP DMG (SPEC §3 / Q3).
#
# Verifies nothing — run tools/dmg/verify-backend.sh after, or this script's
# tail self-check. Produces no .app and does no signing (that's Stage 6).

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STAGE="$REPO/build/stage"
RES="$STAGE/Resources"
NODE_BIN="$(command -v node)"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
fail() { printf "\033[0;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

[ -n "$NODE_BIN" ] || fail "node not found on PATH"
[ -f "$REPO/sinain-core/dist/index.js" ] || fail "sinain-core not built — run: (cd sinain-core && npm run build)"
[ -f "$REPO/tools/sck-capture/sck-capture" ] || fail "sck-capture not built — run: tools/sck-capture/build.sh"

bold "Cleaning stage → $STAGE"
rm -rf "$STAGE"
mkdir -p "$RES/node/bin" "$RES/sinain-core" "$RES/sck-capture" "$RES/scripts"

bold "1 · Bundling Node runtime ($(node --version), arm64)"
cp "$NODE_BIN" "$RES/node/bin/node"

bold "2 · Staging compiled sinain-core + production deps"
cp -R "$REPO/sinain-core/dist" "$RES/sinain-core/dist"
cp "$REPO/sinain-core/package.json" "$RES/sinain-core/package.json"
[ -f "$REPO/sinain-core/package-lock.json" ] && cp "$REPO/sinain-core/package-lock.json" "$RES/sinain-core/"
# Production-only install using the BUNDLED node, into the staged core.
( cd "$RES/sinain-core" && "$RES/node/bin/node" "$(command -v npm)" install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) \
  || fail "prod npm install failed in stage"

bold "3 · Staging sck-capture (arm64)"
cp "$REPO/tools/sck-capture/sck-capture" "$RES/sck-capture/sck-capture"
chmod +x "$RES/sck-capture/sck-capture"

bold "4 · Writing launch-backend.sh"
cat > "$RES/scripts/launch-backend.sh" <<'LAUNCH'
#!/usr/bin/env bash
# Bundled-backend launcher — spawned by the overlay .app on startup.
# Resolves paths relative to this bundle so nothing depends on the user's PATH.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"          # …/Resources/scripts
RES="$(cd "$HERE/.." && pwd)"                   # …/Resources
NODE="$RES/node/bin/node"
CORE="$RES/sinain-core"

# sinain-core resolves the sck-capture binary from ~/.sinain/sck-capture first
# (capture-spawner-macos.ts), so symlink the bundled binary there on launch.
mkdir -p "$HOME/.sinain/sck-capture" "$HOME/.sinain/capture"
ln -sf "$RES/sck-capture/sck-capture" "$HOME/.sinain/sck-capture/sck-capture"

# User config lives at ~/.sinain/.env (written by the first-run wizard).
export NODE_ENV=production
cd "$CORE"
exec "$NODE" dist/index.js
LAUNCH
chmod +x "$RES/scripts/launch-backend.sh"

bold "✓ Staged backend → $RES"
du -sh "$RES" 2>/dev/null | awk '{print "  size: "$1}'
