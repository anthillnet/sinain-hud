#!/usr/bin/env bash
set -euo pipefail

# ── Sign, package, notarize the full Sinain.app → notarized DMG (REAL) ───────
# SEED-001 Stage 6. Signs every nested Mach-O (Node with JIT entitlements, all
# native .node/dylibs + sck-capture with hardened runtime), then the frameworks,
# then the app with the non-sandboxed packaged entitlements. Builds a DMG,
# notarizes via the stored notarytool profile, staples, and verifies Gatekeeper.
#
# Prereqs:
#   tools/dmg/assemble-app.sh           → build/Sinain.app
#   Developer ID Application cert in Keychain
#   notarytool profile stored (see tools/dmg/local-overlay-dmg.sh header)
#
# Usage: tools/dmg/build-full-dmg.sh [Sinain.app] [notary-profile]

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
APP="${1:-$REPO/build/Sinain.app}"
NOTARY_PROFILE="${2:-sinain-notary}"
IDENTITY="${SIGN_IDENTITY:-Developer ID Application}"
APP_ENT="$REPO/overlay/macos/Runner/ReleaseDMG.entitlements"
NODE_ENT="$REPO/overlay/macos/Runner/Node.entitlements"
DMG="$REPO/build/Sinain.dmg"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
fail() { printf "\033[0;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

[ -d "$APP" ] || fail "app not found: $APP (run tools/dmg/assemble-app.sh)"
[ -f "$APP_ENT" ] || fail "missing $APP_ENT"
[ -f "$NODE_ENT" ] || fail "missing $NODE_ENT"

sign_runtime() { codesign --force --timestamp --options runtime --sign "$IDENTITY" "$1"; }

bold "1/7 · Signing native binaries (.node, dylibs, esbuild, sck-capture) — hardened runtime"
# Every Mach-O under Resources except the node binary (signed separately).
find "$APP/Contents/Resources" -type f \( -name "*.node" -o -name "*.dylib" -o -name "esbuild" -o -name "sck-capture" \) -print0 \
  | while IFS= read -r -d '' f; do
      file "$f" 2>/dev/null | grep -q "Mach-O" && sign_runtime "$f"
    done
# Catch any other executable Mach-O under Resources (excluding node).
find "$APP/Contents/Resources" -type f -perm +111 ! -path "*/node/bin/node" -print0 \
  | while IFS= read -r -d '' f; do
      if file "$f" 2>/dev/null | grep -q "Mach-O"; then sign_runtime "$f" 2>/dev/null || true; fi
    done

bold "2/7 · Signing bundled Node with JIT entitlements"
codesign --force --timestamp --options runtime \
  --entitlements "$NODE_ENT" --sign "$IDENTITY" "$APP/Contents/Resources/node/bin/node"

bold "3/7 · Signing embedded frameworks"
if [ -d "$APP/Contents/Frameworks" ]; then
  for fw in "$APP/Contents/Frameworks"/*.framework; do
    [ -e "$fw" ] && sign_runtime "$fw"
  done
fi

bold "4/7 · Signing the app bundle (non-sandboxed packaged entitlements)"
codesign --force --timestamp --options runtime \
  --entitlements "$APP_ENT" --sign "$IDENTITY" "$APP"

bold "    verifying signature integrity"
codesign --verify --deep --strict --verbose=2 "$APP" || fail "codesign --verify failed"

bold "5/7 · Building DMG"
rm -f "$DMG"
STAGING="$(mktemp -d)"
cp -R "$APP" "$STAGING/"
ln -s /Applications "$STAGING/Applications"
hdiutil create -volname "Sinain" -srcfolder "$STAGING" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGING"
codesign --force --timestamp --sign "$IDENTITY" "$DMG"

bold "6/7 · Notarizing (uploads to Apple — can take several minutes for a large bundle)"
# NOTARY_KEYCHAIN (optional): point notarytool at a specific keychain holding
# the stored credential profile. Unset locally (uses the login keychain, where
# `notarytool store-credentials sinain-notary` wrote it); set by CI to the
# ephemeral signing keychain. The :+ form omits the flag entirely when unset,
# so local behavior is unchanged.
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" \
  ${NOTARY_KEYCHAIN:+--keychain "$NOTARY_KEYCHAIN"} --wait
xcrun stapler staple "$DMG"

bold "7/7 · Verifying Gatekeeper"
spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG" || true
xcrun stapler validate "$DMG"

bold "✓ Done → $DMG"
ls -lh "$DMG" | awk '{print "  "$5"  "$NF}'
