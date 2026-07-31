#!/usr/bin/env bash
set -euo pipefail

# ── Stamp overlay/pubspec.yaml from RELEASE_VERSIONS.json ────────────────────
# The unified release flow bumps RELEASE_VERSIONS.json only, so pubspec (the
# source of CFBundleShortVersionString on macOS and the file version on
# Windows) silently stayed at its last manual bump — QA found every DMG
# reporting 2.11.0 regardless of release. CI calls this before any
# `flutter build` in release-overlay.yml / release-app.yml; running it
# locally is harmless and idempotent.

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PUBSPEC="$REPO/overlay/pubspec.yaml"

VER="$(jq -r '.overlay' "$REPO/RELEASE_VERSIONS.json")"
case "$VER" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "✗ bad overlay version in RELEASE_VERSIONS.json: '$VER'" >&2; exit 1 ;;
esac

# Keep the +buildNumber suffix if present (defaults to +1).
BUILD="$(sed -nE 's/^version: *[0-9.]+\+([0-9]+).*/\1/p' "$PUBSPEC")"
sed -i.bak -E "s/^version: .*/version: ${VER}+${BUILD:-1}/" "$PUBSPEC"
rm -f "$PUBSPEC.bak"
echo "overlay/pubspec.yaml → version: ${VER}+${BUILD:-1}"
