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
OC_PORT=18789

# ── Helpers ──────────────────────────────────────────────────────────────────
bold='\033[1m'; green='\033[0;32m'; yellow='\033[0;33m'; red='\033[0;31m'; reset='\033[0m'
ask()  { printf "${bold}%s${reset}\n  → " "$1"; read -r REPLY; }
ok()   { echo -e "  ${green}✓${reset} $*"; }
skip() { echo -e "  ${yellow}(already set — skipping)${reset}"; }
fail() { echo -e "  ${red}✗ $*${reset}"; exit 1; }
warn() { echo -e "  ${yellow}⚠ $*${reset}"; }

# Privacy guard (reused from setup-nemoclaw.sh)
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
echo -e "${bold}sinain × Remote Server Setup${reset}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Step 1: OpenRouter API key ───────────────────────────────────────────────
echo -e "${bold}[1/7] OpenRouter API key${reset}"
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
echo -e "${bold}[2/7] Audio transcription${reset}"
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

# ── Step 3: Server SSH connection ────────────────────────────────────────────
echo -e "${bold}[3/7] Server SSH connection${reset}"
echo "  Enter your server's SSH address and key."
echo "  The server should be a Linux box with root or sudo access."

if [ -n "${SINAIN_SSH_HOST:-}" ]; then
  skip; SSH_HOST="$SINAIN_SSH_HOST"
else
  ask "Server SSH connection (e.g. root@YOUR-SERVER-IP):"
  SSH_HOST="$REPLY"
fi

if [ -n "${SINAIN_SSH_KEY:-}" ]; then
  SSH_KEY="$SINAIN_SSH_KEY"
else
  ask "SSH key path (default: ~/.ssh/id_ed25519):"
  SSH_KEY="${REPLY:-$HOME/.ssh/id_ed25519}"
fi

echo "  Testing SSH connection..."
if ssh -i "$SSH_KEY" -o ConnectTimeout=10 -o BatchMode=yes "$SSH_HOST" "echo ok" >/dev/null 2>&1; then
  ok "SSH connection verified"
else
  fail "Cannot connect to $SSH_HOST with key $SSH_KEY"
fi

# Extract server IP from SSH_HOST (strip user@ prefix)
SERVER_IP="${SSH_HOST#*@}"
echo ""

# Helper for running commands on the server
remote() {
  ssh -i "$SSH_KEY" -o ConnectTimeout=30 "$SSH_HOST" "$@"
}

# ── Step 4: Server setup via SSH ─────────────────────────────────────────────
echo -e "${bold}[4/7] Server setup via SSH${reset}"

# 4a. Check/install Node.js 22+
echo "  Checking Node.js..."
NODE_VER=$(remote 'node --version 2>/dev/null || echo "none"')
if [ "$NODE_VER" = "none" ]; then
  echo "  Installing Node.js 22..."
  remote 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs' >/dev/null 2>&1
  NODE_VER=$(remote 'node --version')
  ok "Node.js installed: $NODE_VER"
else
  ok "Node.js found: $NODE_VER"
fi

# 4b. Check/install openclaw CLI
echo "  Checking openclaw CLI..."
if remote 'command -v openclaw' >/dev/null 2>&1; then
  ok "openclaw CLI found"
else
  echo "  Installing openclaw globally..."
  remote 'npm install -g openclaw' >/dev/null 2>&1
  ok "openclaw CLI installed"
fi

# 4c. Run sinain plugin installer
echo "  Running sinain plugin installer..."
remote 'npx @geravant/sinain' 2>&1 | while IFS= read -r line; do echo "    $line"; done
ok "sinain plugin installed"

# 4d. Remove stale Docker workspace path if present (migration safety net)
echo "  Checking for stale Docker paths..."
remote 'python3 -c "
import json, os
path = os.path.expanduser(\"~/.openclaw/openclaw.json\")
if not os.path.exists(path): exit()
cfg = json.load(open(path))
ws = cfg.get(\"agents\",{}).get(\"defaults\",{}).get(\"workspace\",\"\")
changed = False
if \"/home/node/\" in ws:
    del cfg[\"agents\"][\"defaults\"][\"workspace\"]
    changed = True
    print(\"Removed stale Docker workspace path\")
if not changed:
    print(\"No stale paths found\")
json.dump(cfg, open(path, \"w\"), indent=2)
"'

# 4e. Ensure gateway.bind = "lan" in openclaw.json
remote 'python3 -c "
import json, os
path = os.path.expanduser(\"~/.openclaw/openclaw.json\")
cfg = json.load(open(path))
cfg.setdefault(\"gateway\",{})[\"bind\"] = \"lan\"
json.dump(cfg, open(path, \"w\"), indent=2)
"'
ok "gateway.bind set to lan"

# 4f. Create systemd service
echo "  Setting up systemd service..."
remote 'cat > /etc/systemd/system/openclaw-gateway.service << EOF
[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root
ExecStart=/usr/bin/env openclaw gateway --bind lan --port 18789
Restart=always
RestartSec=10
Environment=HOME=/root

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable openclaw-gateway >/dev/null 2>&1'

# Start or restart the service
if remote 'systemctl is-active --quiet openclaw-gateway'; then
  remote 'systemctl restart openclaw-gateway'
  ok "systemd service restarted"
else
  remote 'systemctl start openclaw-gateway'
  ok "systemd service created and started"
fi

# 4g. Open firewall (ufw if available)
if remote 'command -v ufw' >/dev/null 2>&1; then
  remote 'ufw allow 18789/tcp >/dev/null 2>&1 || true'
  ok "Firewall port 18789 opened"
fi

# 4h. Wait for gateway to become healthy
echo "  Waiting for gateway to become healthy..."
HEALTHY=false
for i in $(seq 1 60); do
  HTTP_CODE=$(remote "curl -s -o /dev/null -w '%{http_code}' http://localhost:$OC_PORT/healthz 2>/dev/null" || echo "000")
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
  warn "Check logs: ssh $SSH_HOST journalctl -u openclaw-gateway -f"
fi

# 4i. Extract auth token
TOKEN=$(remote 'python3 -c "
import json, os
d = json.load(open(os.path.expanduser(\"~/.openclaw/openclaw.json\")))
print(d.get(\"gateway\",{}).get(\"auth\",{}).get(\"token\",\"\"))
"' 2>/dev/null || true)

if [ -z "$TOKEN" ]; then
  warn "Could not extract auth token from server"
  ask "Paste your gateway auth token (from server's ~/.openclaw/openclaw.json):"
  TOKEN="$REPLY"
fi
ok "Auth token extracted"
echo ""

# ── Step 5: Verify Anthropic auth on server ──────────────────────────────────
echo -e "${bold}[5/7] Verify Anthropic auth (for the server agent)${reset}"
echo "  The OpenClaw agent on the server needs an Anthropic API key."
echo "  This is stored in auth-profiles.json on the server, NOT in sinain-core/.env."

HAS_KEY=$(remote 'python3 -c "
import json, os
path = os.path.expanduser(\"~/.openclaw/agents/main/agent/auth-profiles.json\")
try:
    d = json.load(open(path))
    profiles = d if isinstance(d, list) else d.get(\"profiles\", [])
    for p in profiles:
        if p.get(\"provider\") == \"anthropic\" and p.get(\"apiKey\"):
            print(\"yes\")
            break
except:
    pass
"' 2>/dev/null || true)

if [ "$HAS_KEY" = "yes" ]; then
  ok "Anthropic auth-profiles.json found with API key"
else
  warn "No Anthropic API key found on server"
  echo "  The agent won't work without one. Configure it on the server with:"
  echo "    ssh $SSH_HOST openclaw config"
  echo "  Or manually create ~/.openclaw/agents/main/agent/auth-profiles.json:"
  echo '    {"profiles":[{"provider":"anthropic","apiKey":"sk-ant-..."}]}'
fi
echo ""

# ── Step 6: Memory backup repo (optional) ────────────────────────────────────
echo -e "${bold}[6/7] Memory backup repo (optional)${reset}"
echo "  A private GitHub repo seeds the agent's workspace with existing memory."
echo "  Create one at github.com/new (must be private). Paste the SSH or HTTPS clone URL."
echo "  Leave blank to skip."
if [ -n "${SINAIN_BACKUP_REPO:-}" ]; then
  skip; BACKUP_REPO="$SINAIN_BACKUP_REPO"
else
  ask "Git backup repo URL (or Enter to skip):"
  BACKUP_REPO="$REPLY"
fi

if [ -n "$BACKUP_REPO" ]; then
  echo "  Verifying repo privacy..."
  check_repo_privacy "$BACKUP_REPO"

  # Check if workspace already has a git repo
  HAS_GIT=$(remote 'test -d ~/.openclaw/workspace/.git && echo yes || echo no')
  if [ "$HAS_GIT" = "yes" ]; then
    remote "cd ~/.openclaw/workspace && git remote set-url origin '$BACKUP_REPO' && git pull --ff-only" 2>&1 | while IFS= read -r line; do echo "    $line"; done
    ok "Workspace git remote updated"
  else
    remote "git clone '$BACKUP_REPO' ~/.openclaw/workspace --quiet" 2>&1
    ok "Memory restored from $BACKUP_REPO"
  fi
fi
echo ""

# ── Step 7: Write .env + launch sinain ───────────────────────────────────────
echo -e "${bold}[7/7] Write .env + launch sinain${reset}"

# Strip lines we're about to rewrite; preserve everything else
if [ -f "$ENV_FILE" ]; then
  grep -vE "^(OPENROUTER_API_KEY|TRANSCRIPTION_BACKEND|OPENCLAW_|SINAIN_SSH_|SINAIN_BACKUP_REPO)" \
    "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
fi

{
  echo ""
  echo "# ── Written by setup-remote.sh ────────────────────────────────"
  echo "OPENROUTER_API_KEY=${OR_KEY}"
  if [ -n "$STT_VARS" ]; then echo "${STT_VARS}"; fi
  echo "OPENCLAW_WS_URL=ws://${SERVER_IP}:${OC_PORT}"
  echo "OPENCLAW_HTTP_URL=http://${SERVER_IP}:${OC_PORT}/hooks/agent"
  echo "OPENCLAW_WS_TOKEN=${TOKEN}"
  echo "OPENCLAW_HTTP_TOKEN=${TOKEN}"
  echo "OPENCLAW_SESSION_KEY=agent:main:sinain"
  echo "# ── Connection details (for re-runs) ─────────────────────────"
  echo "SINAIN_SSH_HOST=${SSH_HOST}"
  echo "SINAIN_SSH_KEY=${SSH_KEY}"
  if [ -n "$BACKUP_REPO" ]; then echo "SINAIN_BACKUP_REPO=${BACKUP_REPO}"; fi
} >> "$ENV_FILE"

ok "Configuration saved to sinain-core/.env"
echo ""
echo -e "${bold}Starting sinain...${reset}"
echo ""

exec "$SINAIN_DIR/start.sh"
