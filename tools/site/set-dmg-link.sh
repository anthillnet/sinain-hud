#!/usr/bin/env bash
# Rewrite the landing page's DMG download CTA from RELEASE_VERSIONS.json.
# Run at deploy time by both firebase-hosting-merge.yml and release.yml's
# site job — the committed URL in docs/index.html is never authoritative.
# If the declared version's asset isn't published yet (release still
# building), fall back to the newest existing macos-v* release so the live
# link never 404s.
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO="anthillnet/sinain-hud"

ver="$(jq -r '.dmg' RELEASE_VERSIONS.json)"
url="https://github.com/$REPO/releases/download/macos-v$ver/Sinain.dmg"
if ! curl -sfIL -o /dev/null "$url"; then
  echo "macos-v$ver asset not published yet — falling back to newest existing release"
  ver="$(curl -sf "https://api.github.com/repos/$REPO/releases?per_page=30" \
    | jq -r '[.[] | select(.tag_name | startswith("macos-v"))][0].tag_name' \
    | sed 's/^macos-v//')"
  [ -n "$ver" ] && [ "$ver" != "null" ] || { echo "no macos-v release found; leaving link unchanged"; exit 0; }
fi

perl -pi -e "s|releases/download/macos-v[0-9][^/]*/Sinain\.dmg|releases/download/macos-v$ver/Sinain.dmg|g" docs/index.html
echo "download CTA → macos-v$ver"
grep -o 'releases/download/[^"]*' docs/index.html | head -1
