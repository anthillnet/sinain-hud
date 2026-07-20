#!/usr/bin/env bash
set -uo pipefail

# Scan an assembled app (or an already-mounted DMG) for embedded credentials
# and unexpected HTTPS destinations. Add temporary release-specific hosts with
# SINAIN_HYGIENE_ALLOW_HOSTS=host1,host2; keep permanent additions below.
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET="${1:-$REPO/overlay/build/macos/Build/Products/Release/sinain_hud.app}"

if [ ! -d "$TARGET" ]; then
  echo "binary hygiene: target must be an .app bundle or mounted DMG directory: $TARGET" >&2
  exit 2
fi

ALLOW_HOSTS=(
  openrouter.ai          # configured cloud inference
  api.cerebras.ai        # optional burst inference
  api.openai.com         # optional OpenAI-compatible provider
  api.anthropic.com      # optional agent-account usage display
  api.github.com         # update checks and setup release discovery
  github.com             # release/model downloads and source metadata
  raw.githubusercontent.com # repository-hosted assets
  sinain.com             # product/download page
  auth.sinain.com        # account and device linking (Auth0-backed)
  mcp.sinain.com         # ChatGPT connector relay
  localhost              # local core, Ollama, and development endpoints
  127.0.0.1              # local core, Ollama, and development endpoints
  registry.npmjs.org     # bundled npm lockfile/package-manager metadata
  npmjs.com              # bundled npm metadata
  www.npmjs.com          # bundled npm metadata
  pub.dev                # Flutter package metadata
  storage.googleapis.com # pub.dev/Flutter CDN artifacts
  huggingface.co         # optional local Whisper model download
  cdn.auth0.com           # Auth0 browser assets
  api.telegram.org        # optional OpenClaw Telegram notification adapter
  ollama.com              # optional local-model setup download
  cdn.jsdelivr.net        # bundled web UI assets
  existential.audio       # npm package metadata
  feross.org              # npm package funding metadata
  opencollective.com      # npm package funding metadata
  www.patreon.com         # npm package funding metadata
  img.shields.io          # bundled README badges
  docs.flutter.dev        # bundled README documentation
  nodejs.org              # bundled README/setup documentation
  www.python.org          # bundled README/setup documentation
  support.apple.com       # bundled README platform documentation
  schema.org              # local RDF namespace, not an outbound call
  sinain.app              # local RDF namespace, not an outbound call
)
if [ -n "${SINAIN_HYGIENE_ALLOW_HOSTS:-}" ]; then
  IFS=',' read -r -a EXTRA_HOSTS <<< "$SINAIN_HYGIENE_ALLOW_HOSTS"
  ALLOW_HOSTS+=("${EXTRA_HOSTS[@]}")
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
dump="$tmp/strings.txt"

while IFS= read -r -d '' file; do
  printf '\nFILE:%s\n' "$file" >> "$dump"
  strings -a "$file" >> "$dump" 2>/dev/null || rg -a -o '.{1,500}' "$file" >> "$dump" 2>/dev/null || true
done < <(find "$TARGET" -type f -print0)

violations=0
check_secret() {
  local label="$1" pattern="$2"
  local matches
  matches="$(rg -n -o "$pattern" "$dump" 2>/dev/null || true)"
  if [ -n "$matches" ]; then
    echo "ERROR: possible embedded $label:" >&2
    printf '%s\n' "$matches" >&2
    violations=$((violations + 1))
  fi
}

check_secret "Cerebras key" 'csk-[A-Za-z0-9]+'
check_secret "API key" '(^|[^A-Za-z0-9])sk-[A-Za-z0-9]{8,}'
check_secret "OpenRouter environment value" 'OPENROUTER_API_KEY=[A-Za-z0-9_+=/-]{8,}'
check_secret "AWS access key" 'AKIA[0-9A-Z]{16}'

hosts="$tmp/hosts.txt"
rg -o 'https://[A-Za-z0-9._:-]+' "$dump" 2>/dev/null \
  | sed -E 's#https://##; s/:.*$//; s/[.]+$//' \
  | tr '[:upper:]' '[:lower:]' | sort -u > "$hosts" || true

unknown="$tmp/unknown-hosts.txt"
: > "$unknown"
while IFS= read -r host; do
  [ -n "$host" ] || continue
  allowed=false
  for entry in "${ALLOW_HOSTS[@]}"; do
    [ -n "$entry" ] || continue
    if [ "$host" = "$entry" ] || [[ "$host" == *."$entry" ]]; then allowed=true; break; fi
  done
  $allowed || printf '%s\n' "$host" >> "$unknown"
done < "$hosts"

if [ -s "$unknown" ]; then
  echo "ERROR: HTTPS hosts not in the binary hygiene allowlist:" >&2
  sed 's/^/  - /' "$unknown" >&2
  violations=$((violations + 1))
fi

if [ "$violations" -ne 0 ]; then
  echo "binary hygiene: FAILED ($violations violation group(s)); review matches or update the documented allowlist" >&2
  exit 1
fi
echo "binary hygiene: OK — no credential patterns or unlisted HTTPS hosts found in $TARGET"
