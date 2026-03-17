#!/usr/bin/env bash
set -e

SINAIN_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SINAIN_DIR/sinain-core/.env"

# ── Helpers ──────────────────────────────────────────────────────────────────
bold='\033[1m'; green='\033[0;32m'; yellow='\033[0;33m'; red='\033[0;31m'; reset='\033[0m'
ask()  { printf "${bold}%s${reset}\n  → " "$1"; read -r REPLY; }
ok()   { echo -e "  ${green}✓${reset} $*"; }
skip() { echo -e "  ${yellow}(already set — skipping)${reset}"; }
fail() { echo -e "  ${red}✗ $*${reset}"; }

# Privacy guard — MUST be defined before any git operations below
check_repo_privacy() {
  local url="$1" owner_repo status is_private
  if [[ "$url" != *"github.com"* ]]; then
    echo "  ⚠ Non-GitHub repo — cannot auto-verify privacy."
    printf "  Type 'yes, it is private' to confirm: "
    read -r confirm
    if [[ "$confirm" != "yes, it is private" ]]; then
      fail "Aborted — cannot confirm repo privacy."
      exit 1
    fi
    return
  fi
  owner_repo=$(echo "$url" | sed -E 's|https://github.com/||;s|git@github.com:||;s|\.git$||')
  status=$(curl -s -o /dev/null -w "%{http_code}" "https://api.github.com/repos/$owner_repo")
  if [ "$status" = "200" ]; then
    is_private=$(curl -s "https://api.github.com/repos/$owner_repo" | \
      python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('private', False))")
    if [ "$is_private" = "True" ]; then
      ok "Repo is private"
    else
      fail "SECURITY ERROR: github.com/$owner_repo is PUBLIC."
      echo "    Fix: github.com/$owner_repo/settings → Change visibility → Private"
      exit 1
    fi
  elif [ "$status" = "404" ]; then
    ok "Repo is private (not publicly visible)"
  else
    fail "Cannot verify repo privacy (HTTP $status). Aborting for safety."
    exit 1
  fi
}

# Load current .env if it exists (for idempotency — skip already-set values)
[ -f "$ENV_FILE" ] && source "$ENV_FILE" 2>/dev/null || true

echo ""
echo -e "${bold}sinain × NemoClaw Setup${reset}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Step 1: OpenRouter API key ───────────────────────────────────────────────
echo -e "${bold}[1/5] OpenRouter API key${reset}"
echo "  Used for screen analysis and audio transcription."
echo "  Get one free at openrouter.ai"
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  skip; OR_KEY="$OPENROUTER_API_KEY"
else
  ask "Paste your OpenRouter API key:"
  OR_KEY="$REPLY"
fi
echo ""

# ── Step 2: Speech-to-text mode ─────────────────────────────────────────────
echo -e "${bold}[2/5] Audio transcription${reset}"
echo "  a) Cloud  — uses OpenRouter (free, no download needed)"
echo "  b) Local  — uses Whisper on your Mac (~1.5 GB model, fully private)"
if [ -n "${LOCAL_WHISPER_MODEL:-}" ] || [ -n "${TRANSCRIPTION_BACKEND:-}" ]; then
  skip; STT_MODE="existing"
else
  ask "Choose (a/b, default: a):"
  STT_MODE="${REPLY:-a}"
fi

if [ "$STT_MODE" = "b" ]; then
  echo "  Running local STT setup..."
  bash "$SINAIN_DIR/setup-local-stt.sh"
  STT_VARS="TRANSCRIPTION_BACKEND=local"
elif [ "$STT_MODE" != "existing" ]; then
  STT_VARS="TRANSCRIPTION_BACKEND=openrouter"
else
  STT_VARS=""
fi
echo ""

# ── Step 3: NemoClaw URL ─────────────────────────────────────────────────────
echo -e "${bold}[3/5] NemoClaw URL${reset}"
echo "  In your Brev dashboard:"
echo "    → Expose Port(s) → enter 18789 → TCP → note the IP shown"
echo "  Then enter the URL here (e.g. ws://35.238.211.113:18789)"
if [ -n "${OPENCLAW_WS_URL:-}" ]; then
  skip; RAW_URL="$OPENCLAW_WS_URL"
else
  ask "Paste your NemoClaw URL:"
  RAW_URL="$REPLY"
fi

# Normalise to both http and ws variants
# If user entered a bare IP/hostname (no scheme), prepend ws:// and default port 18789
_raw="${RAW_URL%/}"
if [[ "$_raw" != *"://"* ]]; then
  # bare IP or hostname — check if port is already included
  if [[ "$_raw" != *":"* ]]; then
    _raw="${_raw}:18789"
  fi
  _raw="ws://${_raw}"
fi
HTTP_URL="$_raw"
HTTP_URL="${HTTP_URL/wss:\/\//https://}"
HTTP_URL="${HTTP_URL/ws:\/\//http://}"
WS_URL="${HTTP_URL/https:\/\//wss://}"
WS_URL="${WS_URL/http:\/\//ws://}"
echo ""

# ── Step 4: NemoClaw auth token ──────────────────────────────────────────────
echo -e "${bold}[4/5] NemoClaw auth token${reset}"
echo "  Printed by \`npx sinain\` in the Code-Server terminal."
echo "  Also visible in your Brev dashboard under 'Gateway Token'."
if [ -n "${OPENCLAW_WS_TOKEN:-}" ]; then
  skip; TOKEN="$OPENCLAW_WS_TOKEN"
else
  ask "Paste your auth token:"
  TOKEN="$REPLY"
fi
echo ""

# ── Step 5: Memory backup repo (optional) ────────────────────────────────────
echo -e "${bold}[5/5] Memory backup repo (recommended)${reset}"
echo "  A private GitHub repo keeps your playbook and memory portable across Brev instances."
echo "  Create one at github.com/new (must be private). Paste the SSH or HTTPS clone URL."
echo "  Leave blank to skip (memory stays on this instance only)."
if [ -n "${SINAIN_BACKUP_REPO:-}" ]; then
  skip; BACKUP_REPO="$SINAIN_BACKUP_REPO"
else
  ask "Git backup repo URL (or Enter to skip):"
  BACKUP_REPO="$REPLY"
fi

if [ -n "$BACKUP_REPO" ]; then
  echo "  Verifying repo privacy..."
  check_repo_privacy "$BACKUP_REPO"
fi
echo ""

# ── Write .env ───────────────────────────────────────────────────────────────
# Strip lines we're about to rewrite; preserve everything else
if [ -f "$ENV_FILE" ]; then
  grep -vE "^(OPENROUTER_API_KEY|TRANSCRIPTION_BACKEND|LOCAL_WHISPER_MODEL|OPENCLAW_|SINAIN_BACKUP_REPO)" \
    "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
fi

{
  echo ""
  echo "# ── Written by setup-nemoclaw.sh ────────────────────────────────"
  echo "OPENROUTER_API_KEY=${OR_KEY}"
  if [ -n "$STT_VARS" ]; then echo "${STT_VARS}"; fi
  echo "OPENCLAW_WS_URL=${WS_URL}"
  echo "OPENCLAW_HTTP_URL=${HTTP_URL}/hooks/agent"
  echo "OPENCLAW_WS_TOKEN=${TOKEN}"
  echo "OPENCLAW_HTTP_TOKEN=${TOKEN}"
  echo "OPENCLAW_SESSION_KEY=agent:main:sinain"
  if [ -n "$BACKUP_REPO" ]; then echo "SINAIN_BACKUP_REPO=${BACKUP_REPO}"; fi
} >> "$ENV_FILE"

ok "Configuration saved to sinain-core/.env"
echo ""
echo -e "${bold}Starting sinain...${reset}"
echo ""

exec "$SINAIN_DIR/start.sh"
