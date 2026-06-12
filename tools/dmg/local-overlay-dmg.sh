#!/usr/bin/env bash
set -euo pipefail

# ── Local overlay DMG builder (SEED-001 Phase 3 — REAL, not a stub) ──────────
# Signs an already-built Flutter overlay .app with Developer ID + hardened
# runtime, packages it into a DMG, notarizes, staples, and verifies Gatekeeper.
# This produces the OVERLAY app only — not the full bundled product (sinain-core
# + sense_client + sck-capture), which needs Phase 2 bundling. It exists to
# validate the cert/notarize/Gatekeeper chain end-to-end on a real artifact.
#
# Prereqs (one-time):
#   - Developer ID Application cert in your login Keychain
#   - notarytool credential profile stored:
#       xcrun notarytool store-credentials "sinain-notary" \
#         --apple-id "<you@apple.id>" --team-id "<TEAMID>" --password "<app-specific-pw>"
#   - flutter build macos --release   (run before this script)
#
# Usage: tools/dmg/local-overlay-dmg.sh [path-to.app] [notary-profile]

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="${1:-$REPO_ROOT/overlay/build/macos/Build/Products/Release/sinain_hud.app}"
NOTARY_PROFILE="${2:-sinain-notary}"
IDENTITY="${SIGN_IDENTITY:-Developer ID Application}"
ENTITLEMENTS="$REPO_ROOT/overlay/macos/Runner/Release.entitlements"
OUT_DIR="$REPO_ROOT/build"
DMG="$OUT_DIR/Sinain-Overlay.dmg"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
fail() { printf "\033[0;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

[ -d "$APP" ] || fail "app not found: $APP (run: flutter build macos --release)"
[ -f "$ENTITLEMENTS" ] || fail "entitlements not found: $ENTITLEMENTS"
mkdir -p "$OUT_DIR"

bold "1/6 · Signing nested code (inside-out) with hardened runtime"
# Sign every nested dylib / framework / helper first, then the app last.
find "$APP/Contents" \( -name "*.dylib" -o -name "*.framework" -o -name "*.so" \) -print0 2>/dev/null \
  | while IFS= read -r -d '' item; do
      codesign --force --timestamp --options runtime \
        --sign "$IDENTITY" "$item" 2>/dev/null || true
    done

bold "2/6 · Signing the app bundle"
codesign --force --deep --timestamp --options runtime \
  --entitlements "$ENTITLEMENTS" \
  --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP" || fail "codesign verify failed"

bold "3/6 · Building DMG (hdiutil)"
rm -f "$DMG"
STAGING="$(mktemp -d)"
cp -R "$APP" "$STAGING/"
ln -s /Applications "$STAGING/Applications"
hdiutil create -volname "Sinain" -srcfolder "$STAGING" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGING"

bold "4/6 · Signing the DMG"
codesign --force --timestamp --sign "$IDENTITY" "$DMG"

bold "5/6 · Notarizing (this uploads to Apple — may take a few minutes)"
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$DMG"

bold "6/6 · Verifying Gatekeeper assessment"
spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG" || true
xcrun stapler validate "$DMG"

bold "✓ Done → $DMG"
