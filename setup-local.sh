#!/usr/bin/env bash
set -e

echo ""
echo -e "\033[33m  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m"
echo -e "\033[33m  This script is deprecated.\033[0m"
echo -e "\033[2m  Use: npx @geravant/sinain onboard\033[0m"
echo -e "\033[2m  Or:  npx @geravant/sinain onboard --advanced\033[0m"
echo -e "\033[33m  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m"
echo ""

SINAIN_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SINAIN_DIR/sinain-core/.env"
OC_DIR="$HOME/.openclaw"
OC_JSON="$OC_DIR/openclaw.json"
OC_PORT=18789

# ── Helpers ──────────────────────────────────────────────────────────────────
bold='\033[1m'; green='\033[0;32m'; yellow='\033[0;33m'; red='\033[0;31m'; reset='\033[0m'
ask()  { printf "${bold}%s${reset}\n  → " "$1"; read -r REPLY; }
ok()   { echo -e "  ${green}✓${reset} $*"; }
skip() { echo -e "  ${yellow}(already set — skipping)${reset}"; }
fail() { echo -e "  ${red}✗ $*${reset}"; exit 1; }
warn() { echo -e "  ${yellow}⚠ $*${reset}"; }

# Privacy guard — verify GitHub repos are private before configuring
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
echo -e "${bold}sinain × Local OpenClaw Setup${reset}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Step 1: OpenRouter API key ───────────────────────────────────────────────
echo -e "${bold}[1/6] OpenRouter API key${reset}"
echo "  Used for screen analysis and audio transcription."
echo "  Get one free at openrouter.ai"
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  skip; OR_KEY="$OPENROUTER_API_KEY"
else
  ask "Paste your OpenRouter API key:"
  OR_KEY="$REPLY"
fi
echo ""

# ── Step 2: Speech-to-text mode ──────────────────────────────────────────────
echo -e "${bold}[2/6] Audio transcription${reset}"
echo "  a) Cloud  — uses OpenRouter (free, no download needed)"
echo "  b) Local  — uses Whisper on your Mac (~1.5 GB model, fully private)"
if [ -n "${TRANSCRIPTION_BACKEND:-}" ]; then
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

# ── Step 3: Install & start OpenClaw gateway ─────────────────────────────────
echo -e "${bold}[3/6] Install & start OpenClaw gateway${reset}"

# Ensure openclaw CLI is available
if command -v openclaw >/dev/null 2>&1; then
  ok "openclaw CLI found: $(command -v openclaw)"
else
  echo "  Installing openclaw globally via npm..."
  npm install -g openclaw
  if ! command -v openclaw >/dev/null 2>&1; then
    fail "Failed to install openclaw. Check npm global path."
  fi
  ok "openclaw CLI installed"
fi

# Create state directory
mkdir -p "$OC_DIR"

# Patch openclaw.json: set gateway.mode=local and required config
python3 -c "
import json, os

path = os.path.expanduser('$OC_JSON')
cfg = {}
if os.path.exists(path):
    with open(path) as f:
        cfg = json.load(f)

# Ensure nested keys exist
cfg.setdefault('gateway', {})
cfg['gateway'].setdefault('auth', {})
cfg['gateway']['mode'] = 'local'
cfg['gateway']['auth'].setdefault('mode', 'token')

cfg.setdefault('agents', {})
cfg['agents'].setdefault('defaults', {})
cfg['agents']['defaults'].setdefault('sandbox', {})
cfg['agents']['defaults']['sandbox']['sessionToolsVisibility'] = 'all'
cfg['agents']['defaults'].setdefault('compaction', {})
cfg['agents']['defaults']['compaction']['mode'] = 'safeguard'

with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
"
ok "openclaw.json patched (gateway.mode=local)"

# Kill any existing gateway on this port
if lsof -i :"$OC_PORT" -t >/dev/null 2>&1; then
  warn "Port $OC_PORT in use — stopping existing gateway..."
  kill $(lsof -i :"$OC_PORT" -t) 2>/dev/null || true
  sleep 2
fi

# Start gateway as background process
echo "  Starting openclaw gateway on port $OC_PORT..."
openclaw gateway --bind loopback --port "$OC_PORT" --force &
GW_PID=$!
disown "$GW_PID"
ok "Gateway started (PID $GW_PID)"

# Wait for healthy (timeout 60s)
echo "  Waiting for gateway to become healthy..."
HEALTHY=false
for i in $(seq 1 60); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$OC_PORT/healthz" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    HEALTHY=true
    break
  fi
  sleep 1
done

if [ "$HEALTHY" = true ]; then
  ok "Gateway is healthy"
else
  warn "Gateway not yet healthy after 60s — continuing anyway"
fi

# Install sinain plugin
echo "  Installing sinain plugin..."
openclaw plugin install @geravant/sinain
ok "sinain plugin installed"

# Extract auth token from openclaw.json (gateway may have regenerated it)
TOKEN=""
if [ -f "$OC_JSON" ]; then
  TOKEN=$(python3 -c "
import json, sys
try:
    d = json.load(open('$OC_JSON'))
    t = d.get('gateway',{}).get('auth',{}).get('token','')
    if t:
        print(t)
except Exception as e:
    print(f'Error: {e}', file=sys.stderr)
" 2>/dev/null || true)
fi

if [ -z "$TOKEN" ]; then
  warn "Could not extract auth token from openclaw.json"
  ask "Paste your gateway auth token (from ~/.openclaw/openclaw.json):"
  TOKEN="$REPLY"
fi
ok "Auth token configured"
echo ""

# ── Step 4: Verify Anthropic auth ────────────────────────────────────────────
echo -e "${bold}[4/6] Verify Anthropic auth (for the agent)${reset}"
echo "  The OpenClaw agent needs an Anthropic API key."
echo "  This is stored in auth-profiles.json, NOT in sinain-core/.env."

AUTH_PROFILES="$OC_DIR/agents/main/agent/auth-profiles.json"

if [ -f "$AUTH_PROFILES" ]; then
  HAS_KEY=$(python3 -c "
import json
try:
    d = json.load(open('$AUTH_PROFILES'))
    profiles = d if isinstance(d, list) else d.get('profiles', [])
    for p in profiles:
        if p.get('provider') == 'anthropic' and p.get('apiKey'):
            print('yes')
            break
except:
    pass
" 2>/dev/null || true)
  if [ "$HAS_KEY" = "yes" ]; then
    ok "Anthropic auth-profiles.json found with API key"
  else
    warn "auth-profiles.json exists but no Anthropic key detected"
    echo "  Configure it with: openclaw config"
    echo "  Or manually edit: $AUTH_PROFILES"
  fi
else
  warn "No auth-profiles.json found"
  echo "  The agent won't work without an Anthropic API key."
  echo "  Configure it with: openclaw config"
  echo "  Or create $AUTH_PROFILES manually with:"
  echo '  {"profiles":[{"provider":"anthropic","apiKey":"sk-ant-..."}]}'
fi
echo ""

# ── Step 5: Knowledge snapshot backup repo (optional) ────────────────────────
echo -e "${bold}[5/6] Knowledge snapshot backup repo (optional)${reset}"
echo "  A private GitHub repo to backup knowledge snapshots (playbook, modules, eval data)."
echo "  Create one at github.com/new (must be PRIVATE). Paste the SSH or HTTPS clone URL."
echo "  Leave blank to skip (snapshots stay local only)."
SNAPSHOT_DIR="$HOME/.sinain/knowledge-snapshots"
if [ -n "${SINAIN_SNAPSHOT_REPO:-}" ]; then
  skip; SNAPSHOT_REPO="$SINAIN_SNAPSHOT_REPO"
else
  ask "Snapshot repo URL (or Enter to skip):"
  SNAPSHOT_REPO="$REPLY"
fi

if [ -n "$SNAPSHOT_REPO" ]; then
  echo "  Verifying repo privacy..."
  check_repo_privacy "$SNAPSHOT_REPO"

  mkdir -p "$SNAPSHOT_DIR"
  if [ ! -d "$SNAPSHOT_DIR/.git" ]; then
    git -C "$SNAPSHOT_DIR" init --quiet
    git -C "$SNAPSHOT_DIR" config user.name "sinain-knowledge"
    git -C "$SNAPSHOT_DIR" config user.email "sinain@local"
  fi

  # Set remote (add or update)
  if git -C "$SNAPSHOT_DIR" remote get-url origin >/dev/null 2>&1; then
    git -C "$SNAPSHOT_DIR" remote set-url origin "$SNAPSHOT_REPO"
  else
    git -C "$SNAPSHOT_DIR" remote add origin "$SNAPSHOT_REPO"
  fi

  # Pull existing snapshots if remote has content
  if git -C "$SNAPSHOT_DIR" fetch origin 2>/dev/null; then
    if git -C "$SNAPSHOT_DIR" rev-parse origin/main >/dev/null 2>&1; then
      git -C "$SNAPSHOT_DIR" checkout -B main origin/main --quiet
      ok "Snapshot repo restored from remote"
    else
      ok "Snapshot repo configured (empty remote)"
    fi
  else
    ok "Snapshot repo configured (remote not reachable yet)"
  fi
fi
echo ""

# ── Step 6: Restore knowledge snapshot (optional) ────────────────────────────
echo -e "${bold}[6/6] Restore knowledge snapshot (optional)${reset}"
SNAPSHOT_DIR="$HOME/.sinain/knowledge-snapshots"

if [ -d "$SNAPSHOT_DIR/.git" ]; then
  SNAP_COUNT=$(git -C "$SNAPSHOT_DIR" rev-list --count HEAD 2>/dev/null || echo "0")
  echo "  Found knowledge snapshot repo ($SNAP_COUNT snapshots)."
  ask "Restore latest snapshot to OpenClaw workspace? (Y/n)"
  if [ "${REPLY:-Y}" != "n" ] && [ "${REPLY:-Y}" != "N" ]; then
    echo "  Restoring snapshot..."
    npx tsx "$SINAIN_DIR/sinain-hud-plugin/sinain-knowledge/deploy/cli.ts" \
      snapshot restore HEAD --workspace "$OC_DIR/workspace"
    ok "Knowledge snapshot restored"
  else
    echo "  Skipped."
  fi
else
  echo "  No snapshot repo found at $SNAPSHOT_DIR — skipping."
fi
echo ""

# ── Write .env ───────────────────────────────────────────────────────────────
# Strip lines we're about to rewrite; preserve everything else
if [ -f "$ENV_FILE" ]; then
  grep -vE "^(OPENROUTER_API_KEY|TRANSCRIPTION_BACKEND|OPENCLAW_|SINAIN_SNAPSHOT_REPO)" \
    "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
fi

{
  echo ""
  echo "# ── Written by setup-local.sh ──────────────────────────────────"
  echo "OPENROUTER_API_KEY=${OR_KEY}"
  if [ -n "$STT_VARS" ]; then echo "${STT_VARS}"; fi
  echo "OPENCLAW_WS_URL=ws://localhost:${OC_PORT}"
  echo "OPENCLAW_HTTP_URL=http://localhost:${OC_PORT}/hooks/agent"
  echo "OPENCLAW_WS_TOKEN=${TOKEN}"
  echo "OPENCLAW_HTTP_TOKEN=${TOKEN}"
  echo "OPENCLAW_SESSION_KEY=agent:main:sinain"
  if [ -n "$SNAPSHOT_REPO" ]; then echo "SINAIN_SNAPSHOT_REPO=${SNAPSHOT_REPO}"; fi
} >> "$ENV_FILE"

ok "Configuration saved to sinain-core/.env"
echo ""
echo -e "${bold}Starting sinain...${reset}"
echo ""

exec "$SINAIN_DIR/start.sh"
