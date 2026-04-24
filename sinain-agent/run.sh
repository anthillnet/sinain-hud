#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load .env as fallback — does NOT override vars already in the environment
# (e.g. vars set by the launcher from ~/.sinain/.env)
# Load project root .env (single config for all subsystems)
ENV_FILE="$SCRIPT_DIR/../.env"
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key val; do
    # Skip comments and blank lines
    [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
    key=$(echo "$key" | xargs)  # trim whitespace
    val=$(echo "$val" | xargs)
    # Strip inline comments (e.g. "5 # seconds" → "5")
    val="${val%%#*}"
    val=$(echo "$val" | xargs)  # re-trim after comment strip
    [[ -z "$val" ]] && continue
    # Only set if not already in environment
    if [ -z "${!key+x}" ]; then
      export "$key=$val"
    fi
  done < "$ENV_FILE"
fi

MCP_CONFIG="${MCP_CONFIG:-$SCRIPT_DIR/mcp-config.json}"
CORE_URL="${SINAIN_CORE_URL:-http://localhost:9500}"
POLL_INTERVAL="${SINAIN_POLL_INTERVAL:-2}"
AGENT="${SINAIN_AGENT:-claude}"
WORKSPACE="${SINAIN_WORKSPACE:-$HOME/.openclaw/workspace}"
AGENT_MAX_TURNS="${SINAIN_AGENT_MAX_TURNS:-5}"
SPAWN_MAX_TURNS="${SINAIN_SPAWN_MAX_TURNS:-25}"

# Build allowed tools list for Claude's --allowedTools flag.
# SINAIN_ALLOWED_TOOLS in .env overrides; otherwise auto-derive from MCP config.
if [ -n "${SINAIN_ALLOWED_TOOLS:-}" ]; then
  ALLOWED_TOOLS="$SINAIN_ALLOWED_TOOLS"
elif [ -f "$MCP_CONFIG" ]; then
  ALLOWED_TOOLS=$(python3 -c "
import json
with open('$MCP_CONFIG') as f:
    cfg = json.load(f)
print(' '.join('mcp__' + s for s in cfg.get('mcpServers', {})))
" 2>/dev/null || echo "mcp__sinain")
else
  ALLOWED_TOOLS="mcp__sinain"
fi

# --- Agent profiles ---

# Returns 0 if the selected agent supports MCP tools natively.
# Junie support is detected at startup (JUNIE_HAS_MCP flag).
JUNIE_HAS_MCP=false  # set during startup checks
agent_has_mcp() {
  # Optional arg: agent name to check. Defaults to $AGENT for back-compat
  # with startup-time usage. Main loop passes the lane-specific choice.
  local check="${1:-$AGENT}"
  case "$check" in
    claude|openclaude|codex|goose) return 0 ;;
    junie) $JUNIE_HAS_MCP ;;
    *) return 1 ;;
  esac
}

# Invoke the selected agent with a prompt. MCP-capable agents get the config
# so they can call sinain tools directly. Returns text on stdout.
# Exit code 1 means "agent doesn't support MCP — use pipe mode instead".
# First arg is the lane's agent name (shadows the global $AGENT for the
# case-dispatch below); second arg is the prompt; third optional is turns.
invoke_agent() {
  local AGENT="$1"     # shadow the global so case-statement doesn't need edits
  local prompt="$2"
  case "$AGENT" in
    claude|openclaude)
      local turns="${3:-$AGENT_MAX_TURNS}"
      # Stderr filter: drops openclaude's repeated "not in context window table"
      # warnings (one per LLM call, ~40/escalation). All other stderr passes through.
      # No-op for claude (it doesn't emit that line). Toggle with QUIET_OPENCLAUDE=false.
      local quiet="${QUIET_OPENCLAUDE:-true}"
      if [ -n "${SINAIN_SPAWN:-}" ]; then
        # Spawn path: user-initiated tasks often need git/edit/write. The
        # --allowedTools whitelist is a pre-invocation gate; PreToolUse hook
        # (./hooks/approve-tool.sh) still routes each call to the overlay for
        # user Allow/Deny. Widen the whitelist so the hook can do its job.
        # Override via SINAIN_SPAWN_ALLOWED_TOOLS.
        local spawn_allowed="${SINAIN_SPAWN_ALLOWED_TOOLS:-${ALLOWED_TOOLS} Bash(git:*) Edit Write Read Glob Grep LS}"
        if [ "$quiet" = "true" ]; then
          "$AGENT" \
            --mcp-config "$MCP_CONFIG" \
            --settings "$SCRIPT_DIR/.claude/settings.json" \
            --allowedTools $spawn_allowed \
            --max-turns "$turns" --output-format text \
            -p "$prompt" \
            2> >(grep -v "not in context window table" >&2)
        else
          "$AGENT" \
            --mcp-config "$MCP_CONFIG" \
            --settings "$SCRIPT_DIR/.claude/settings.json" \
            --allowedTools $spawn_allowed \
            --max-turns "$turns" --output-format text \
            -p "$prompt"
        fi
      else
        # Escalation path: the PreToolUse hook auto-approves MCP + safe reads
        # (sinain_respond, Read, Glob, Grep, Ls, Cat) for speed, and routes
        # writes (Bash/Edit/Write) to the overlay for user Allow/Deny. Same
        # gating as spawn — user commands like "commit this file" that land
        # on the escalation path (Enter instead of Shift+Enter) still work.
        # Override via SINAIN_ESC_ALLOWED_TOOLS.
        local esc_allowed="${SINAIN_ESC_ALLOWED_TOOLS:-${ALLOWED_TOOLS} Bash(git:*) Edit Write Read Glob Grep LS}"
        if [ "$quiet" = "true" ]; then
          "$AGENT" \
            --mcp-config "$MCP_CONFIG" \
            --settings "$SCRIPT_DIR/.claude/settings.json" \
            --allowedTools $esc_allowed \
            --max-turns "$turns" --output-format text \
            -p "$prompt" \
            2> >(grep -v "not in context window table" >&2)
        else
          "$AGENT" \
            --mcp-config "$MCP_CONFIG" \
            --settings "$SCRIPT_DIR/.claude/settings.json" \
            --allowedTools $esc_allowed \
            --max-turns "$turns" --output-format text \
            -p "$prompt"
        fi
      fi
      ;;
    codex)
      codex exec -s danger-full-access \
        --dangerously-bypass-approvals-and-sandbox \
        --skip-git-repo-check \
        "$prompt"
      ;;
    junie)
      if $JUNIE_HAS_MCP; then
        if [ ! -f "$HOME/.junie/allowlist.json" ]; then
          echo "  ⚠ Junie: no allowlist.json — MCP tools may prompt. Run junie --brave once to create it." >&2
        fi
        junie --output-format text \
          --mcp-location "$JUNIE_MCP_DIR" \
          --task "$prompt"
      else
        return 1
      fi
      ;;
    goose)
      local turns="${3:-$AGENT_MAX_TURNS}"
      GOOSE_MODE=auto goose run --text "$prompt" \
        --output-format text \
        --quiet \
        --no-session \
        --max-turns "$turns"
      ;;
    aider)
      # No MCP support — signal pipe mode
      return 1
      ;;
    *)
      # Generic pipe mode — treat AGENT value as a command
      return 1
      ;;
  esac
}

# --- Pipe-mode helpers (for agents without MCP) ---

# JSON-encode stdin for use in curl payloads
json_encode() {
  python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'
}

# Post an escalation response via HTTP (used in pipe mode)
post_response() {
  local esc_id="$1" response="$2"
  curl -sf -X POST "$CORE_URL/escalation/respond" \
    -H 'Content-Type: application/json' \
    -d "{\"id\":\"$esc_id\",\"response\":$(echo "$response" | json_encode)}" >/dev/null
}

# Invoke a pipe-mode agent with escalation message text.
# Some agents take the message as an argument, others via stdin.
invoke_pipe() {
  local AGENT="$1"     # shadow the global; case-dispatch uses the lane's agent
  local msg="$2"
  case "$AGENT" in
    junie)
      junie --output-format text --task "$msg"
      ;;
    aider)
      aider --yes -m "$msg"
      ;;
    *)
      # Generic: pipe message to stdin
      echo "$msg" | $AGENT 2>/dev/null
      ;;
  esac
}

# --- Startup checks ---

# Verify sinain-core is running
if ! curl -sf "$CORE_URL/health" > /dev/null 2>&1; then
  echo "ERROR: sinain-core is not running at $CORE_URL"
  echo "Start it first: cd sinain-core && npm run dev"
  exit 1
fi

# Junie: detect --mcp-location support (must run before agent_has_mcp calls)
JUNIE_MCP_DIR="$SCRIPT_DIR/.junie-mcp"
if [ "$AGENT" = "junie" ]; then
  if junie --help 2>&1 | grep -q "mcp-location"; then
    JUNIE_HAS_MCP=true
    mkdir -p "$JUNIE_MCP_DIR"
    # Junie expects relative paths from the config file location.
    # Since we moved the config into a sub-directory, we need to adjust ../ to ../../
    sed 's|"\.\./|"../../|g' "$MCP_CONFIG" > "$JUNIE_MCP_DIR/mcp.json"
  else
    echo "NOTE: junie $(junie --version 2>&1 | grep -oE '[0-9.]+' | head -1) lacks --mcp-location, using pipe mode"
    echo "  Upgrade junie for MCP support: brew upgrade junie"
  fi
fi

# Verify MCP server dependencies (only needed for MCP agents)
if agent_has_mcp && [ ! -d "$SCRIPT_DIR/../sinain-mcp-server/node_modules" ]; then
  echo "Installing sinain-mcp-server dependencies..."
  (cd "$SCRIPT_DIR/../sinain-mcp-server" && npm install)
fi

# Codex: auto-register sinain MCP server if not already configured
if [ "$AGENT" = "codex" ]; then
  TSX_BIN="$SCRIPT_DIR/../sinain-core/node_modules/.bin/tsx"
  MCP_ENTRY="$SCRIPT_DIR/../sinain-mcp-server/index.ts"
  if ! codex mcp get sinain >/dev/null 2>&1; then
    echo "Registering sinain MCP server with codex..."
    codex mcp add sinain \
      --env "SINAIN_CORE_URL=$CORE_URL" \
      --env "SINAIN_WORKSPACE=$WORKSPACE" \
      -- "$TSX_BIN" "$MCP_ENTRY"
  fi
fi

# Goose: auto-register sinain MCP server in config.yaml if not present
if [ "$AGENT" = "goose" ]; then
  TSX_BIN="$(cd "$SCRIPT_DIR/.." && pwd)/sinain-core/node_modules/.bin/tsx"
  MCP_ENTRY="$(cd "$SCRIPT_DIR/.." && pwd)/sinain-mcp-server/index.ts"
  GOOSE_CONFIG="${HOME}/.config/goose/config.yaml"
  if [ -f "$GOOSE_CONFIG" ] && ! grep -q "sinain:" "$GOOSE_CONFIG" 2>/dev/null; then
    echo "Registering sinain MCP server with goose..."
    python3 -c "
import yaml, os, sys
config_path = sys.argv[1]
with open(config_path) as f:
    cfg = yaml.safe_load(f) or {}
cfg.setdefault('extensions', {})['sinain'] = {
    'name': 'Sinain MCP Server',
    'cmd': sys.argv[2],
    'args': [sys.argv[3]],
    'enabled': True,
    'envs': {'SINAIN_CORE_URL': sys.argv[4], 'SINAIN_WORKSPACE': sys.argv[5]},
    'type': 'stdio',
    'timeout': 300,
}
with open(config_path, 'w') as f:
    yaml.dump(cfg, f, default_flow_style=False)
print('  sinain extension added to ' + config_path)
" "$GOOSE_CONFIG" "$TSX_BIN" "$MCP_ENTRY" "$CORE_URL" "$WORKSPACE"
  fi
fi

# Ollama warmup — pin the backing model so each agent invocation hits hot weights.
# openclaude + Ollama via the OpenAI-compat endpoint does NOT forward keep_alive,
# so we ping Ollama's native /api/generate once with keep_alive=-1 (persistent).
# Applies to any agent pointed at an Ollama-compatible endpoint via OPENAI_BASE_URL.
OLLAMA_WARMUP="${OLLAMA_WARMUP:-true}"
if [ "$OLLAMA_WARMUP" = "true" ] && [ -n "${OPENAI_BASE_URL:-}" ]; then
  if [[ "$OPENAI_BASE_URL" == *"11434"* ]] || [[ "$OPENAI_BASE_URL" == *"ollama"* ]]; then
    # Derive Ollama host by stripping /v1 suffix from OPENAI_BASE_URL
    OLLAMA_HOST="${OLLAMA_HOST:-${OPENAI_BASE_URL%/v1*}}"
    OLLAMA_MODEL="${OLLAMA_MODEL:-${OPENAI_MODEL:-}}"
    OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:--1}"  # -1 = persistent, or "24h", "30m", etc.
    if [ -n "$OLLAMA_MODEL" ]; then
      echo "Warming Ollama model $OLLAMA_MODEL at $OLLAMA_HOST (keep_alive=$OLLAMA_KEEP_ALIVE)..."
      # Ollama accepts keep_alive as int (-1 = persistent) or duration string ("24h", "30m").
      if [[ "$OLLAMA_KEEP_ALIVE" =~ ^-?[0-9]+$ ]]; then
        WARMUP_PAYLOAD="{\"model\":\"$OLLAMA_MODEL\",\"prompt\":\"\",\"keep_alive\":$OLLAMA_KEEP_ALIVE,\"stream\":false}"
      else
        WARMUP_PAYLOAD="{\"model\":\"$OLLAMA_MODEL\",\"prompt\":\"\",\"keep_alive\":\"$OLLAMA_KEEP_ALIVE\",\"stream\":false}"
      fi
      if curl -sf -m 60 -X POST "$OLLAMA_HOST/api/generate" \
          -H 'Content-Type: application/json' \
          -d "$WARMUP_PAYLOAD" >/dev/null 2>&1; then
        echo "  ✓ Model pinned in memory"
      else
        echo "  ⚠ Warmup failed — first request will cold-start the model"
      fi
    else
      echo "  ⚠ OLLAMA_WARMUP=true but OPENAI_MODEL not set — skipping warmup"
    fi
  fi
fi

# Agent mode label
if agent_has_mcp; then
  AGENT_MODE="MCP"
else
  AGENT_MODE="pipe"
fi

# --- Detect installed agents & register with sinain-core ---
# Probes `command -v` for each known bare-agent CLI so the overlay knows
# which ones to offer in its selector. The result is POSTed to
# /bareagent/register; server state becomes visible to the overlay via the
# existing status broadcast. Lane-specific choices (ESC_AGENT, SPAWN_AGENT)
# default to $AGENT and are refreshed per-iteration from the config
# piggyback field on /escalation/pending and /spawn/pending responses.
AVAILABLE_AGENTS=()
for candidate in claude openclaude codex goose junie aider; do
  command -v "$candidate" >/dev/null 2>&1 && AVAILABLE_AGENTS+=("$candidate")
done
if ! command -v "$AGENT" >/dev/null 2>&1; then
  echo "  ⚠ configured agent '$AGENT' not installed — waiting for overlay override"
fi

ESC_AGENT="$AGENT"
SPAWN_AGENT="$AGENT"

# Register roster with sinain-core (fire-and-forget; core may not be ready)
if [ ${#AVAILABLE_AGENTS[@]} -gt 0 ]; then
  REGISTER_PAYLOAD=$(python3 -c "
import json, sys
available = sys.argv[1].split(' ') if sys.argv[1] else []
print(json.dumps({'available': available, 'current': sys.argv[2]}))
" "${AVAILABLE_AGENTS[*]}" "$AGENT")
  curl -sf -m 2 -X POST "$CORE_URL/bareagent/register" \
    -H 'Content-Type: application/json' \
    -d "$REGISTER_PAYLOAD" >/dev/null 2>&1 || true
fi
echo "  Agents available: ${AVAILABLE_AGENTS[*]:-<none>}"
echo "  Lanes:  escalation=$ESC_AGENT  spawn=$SPAWN_AGENT"

# --- Apply config piggybacked on escalation/spawn poll responses ---
# No separate polling — parses the `config` field from /escalation/pending
# and /spawn/pending response JSONs. Heals on "empty config after we had
# state" by re-POSTing /bareagent/register (covers core-restart).
apply_config_from_response() {
  local json="$1"
  # Short-circuit: only process if the response actually includes a config.
  echo "$json" | grep -q '"config"' || return 0
  local new_esc new_spawn
  new_esc=$(echo "$json"   | python3 -c "import sys,json; d=json.load(sys.stdin); c=d.get('config') or {}; print(c.get('escalationAgent',''))" 2>/dev/null)
  new_spawn=$(echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); c=d.get('config') or {}; print(c.get('spawnAgent',''))" 2>/dev/null)

  # Healing: if BOTH lanes come back empty but we had state before, core
  # likely restarted — re-announce our roster so it re-adopts our choice.
  if [ -z "$new_esc" ] && [ -z "$new_spawn" ] && { [ -n "$ESC_AGENT" ] || [ -n "$SPAWN_AGENT" ]; }; then
    echo "[$(date +%H:%M:%S)] config empty — re-registering roster with core"
    if [ ${#AVAILABLE_AGENTS[@]} -gt 0 ]; then
      local heal_payload
      heal_payload=$(python3 -c "
import json, sys
print(json.dumps({'available': sys.argv[1].split(' '), 'current': sys.argv[2]}))
" "${AVAILABLE_AGENTS[*]}" "${ESC_AGENT:-$AGENT}")
      curl -sf -m 2 -X POST "$CORE_URL/bareagent/register" \
        -H 'Content-Type: application/json' \
        -d "$heal_payload" >/dev/null 2>&1 || true
    fi
    return 0
  fi

  if [ "$new_esc" != "$ESC_AGENT" ]; then
    echo "[$(date +%H:%M:%S)] escalation agent: ${ESC_AGENT:-<off>} → ${new_esc:-<off>}"
    ESC_AGENT="$new_esc"
  fi
  if [ "$new_spawn" != "$SPAWN_AGENT" ]; then
    echo "[$(date +%H:%M:%S)] spawn agent: ${SPAWN_AGENT:-<off>} → ${new_spawn:-<off>}"
    SPAWN_AGENT="$new_spawn"
  fi
}

# --- OpenRouter reasoning-preserving proxy autolaunch ---
# Starts sinain-agent/openrouter-proxy.mjs when OPENAI_BASE_URL points at it.
# The proxy preserves reasoning_content across multi-turn MCP flows so
# DeepSeek V4 Flash (and other thinking models) don't 400 on turn-2.
# Skipped if proxy already running, or if base URL doesn't use the proxy port.
PROXY_PID=""
PROXY_PORT="${OPENROUTER_PROXY_PORT:-11435}"
if [[ "${OPENAI_BASE_URL:-}" == *":${PROXY_PORT}"* ]]; then
  if lsof -iTCP:"$PROXY_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "OpenRouter proxy already running on :$PROXY_PORT — reusing"
  else
    PROXY_SCRIPT="$SCRIPT_DIR/openrouter-proxy.mjs"
    if [ -f "$PROXY_SCRIPT" ]; then
      PROXY_STDOUT="/tmp/openrouter-proxy.stdout.log"
      echo "Starting OpenRouter proxy (mode=${REASONING_MODE:-preserve})..."
      node "$PROXY_SCRIPT" > "$PROXY_STDOUT" 2>&1 &
      PROXY_PID=$!
      # Wait up to 2s for the proxy to accept connections before proceeding
      for i in 1 2 3 4 5 6 7 8; do
        if lsof -iTCP:"$PROXY_PORT" -sTCP:LISTEN >/dev/null 2>&1; then break; fi
        sleep 0.25
      done
      if kill -0 "$PROXY_PID" 2>/dev/null && lsof -iTCP:"$PROXY_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
        echo "  ✓ proxy listening (pid=$PROXY_PID, logs=/tmp/openrouter-proxy.log)"
      else
        echo "  ⚠ proxy failed to start — see $PROXY_STDOUT"
        PROXY_PID=""
      fi
    else
      echo "  ⚠ OPENAI_BASE_URL points at :$PROXY_PORT but $PROXY_SCRIPT missing"
    fi
  fi
fi

echo "sinain bare agent started"
echo "  Agent: $AGENT ($AGENT_MODE)"
echo "  Core: $CORE_URL"
echo "  Allowed: ${ALLOWED_TOOLS:-<none>}"
echo "  Poll: every ${POLL_INTERVAL}s"
echo "  Press Ctrl+C to stop"
echo ""

ESCALATION_COUNT=0

cleanup() {
  echo ""
  echo "Agent stopped. Escalations handled: $ESCALATION_COUNT"
  if [ -n "${PROXY_PID:-}" ]; then
    kill "$PROXY_PID" 2>/dev/null && echo "  stopped OpenRouter proxy (pid=$PROXY_PID)"
  fi
  exit 0
}
trap cleanup INT TERM

# --- Prompt templates ---

ESC_PROMPT_TEMPLATE='You are the sinain HUD agent. An escalation is pending with ID=%s.

Call sinain_get_escalation to see the full context, then call sinain_respond with the ID and your response.

Response guidelines: 5-10 sentences, address errors first, reference specific screen/audio context, never NO_REPLY. Max 4000 chars for coding context, 3000 otherwise.'

# --- Main loop ---

while true; do
  # Poll for pending escalation
  ESC=$(curl -sf "$CORE_URL/escalation/pending" 2>/dev/null || echo '{"ok":false}')
  # Pick up per-lane agent choices from the piggybacked config field
  apply_config_from_response "$ESC"
  ESC_PAUSED=$(echo "$ESC" | python3 -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('paused') else '')" 2>/dev/null || true)
  if [ -n "$ESC_PAUSED" ]; then
    sleep 10  # Slow polling when paused
    continue
  fi
  ESC_ID=$(echo "$ESC" | python3 -c "import sys,json; d=json.load(sys.stdin); e=d.get('escalation'); print(e['id'] if e else '')" 2>/dev/null || true)

  # Escalation lane guard: if user set escalation agent to Off via the
  # selector, skip responding even if an escalation is pending. The server's
  # setMode("off") already stops new escalations; this protects against any
  # residual queued state and makes "Off" behavior uniform across restarts.
  if [ -n "$ESC_ID" ] && [ -z "$ESC_AGENT" ]; then
    echo "[$(date +%H:%M:%S)] Escalation $ESC_ID skipped — lane is Off"
    ESC_ID=""
  fi

  if [ -n "$ESC_ID" ]; then
    ESC_MSG=$(echo "$ESC" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['escalation']['message'])" 2>/dev/null)
    ESC_SCORE=$(echo "$ESC" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['escalation'].get('score','?'))" 2>/dev/null)
    ESC_CODING=$(echo "$ESC" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['escalation'].get('codingContext',False))" 2>/dev/null)

    echo "[$(date +%H:%M:%S)] Escalation $ESC_ID (score=$ESC_SCORE, coding=$ESC_CODING)"

    if agent_has_mcp "$ESC_AGENT"; then
      # MCP path: agent calls sinain tools directly. Export a correlation id
      # so the PreToolUse hook can key YOLO on this invocation when the agent
      # runtime doesn't emit session_id in hook input.
      export SINAIN_ESC_TASK_ID="esc-$ESC_ID"
      PROMPT=$(printf "$ESC_PROMPT_TEMPLATE" "$ESC_ID")
      RESPONSE=$(invoke_agent "$ESC_AGENT" "$PROMPT" || echo "ERROR: $ESC_AGENT invocation failed")
      unset SINAIN_ESC_TASK_ID
    else
      # Pipe path: bash handles HTTP, agent just generates text
      RESPONSE=$(invoke_pipe "$ESC_AGENT" "$ESC_MSG" || true)
      if [ -n "$RESPONSE" ]; then
        post_response "$ESC_ID" "$RESPONSE"
      else
        echo "[$(date +%H:%M:%S)] WARNING: $ESC_AGENT returned empty response"
      fi
    fi

    ESCALATION_COUNT=$((ESCALATION_COUNT + 1))
    # Detect cases where the agent's tool call didn't land on HUD (ID race, max turns, API errors, crashes).
    # On drop: print a short inline summary + append the full response to /tmp/sinain-drops.log for diagnosis.
    if echo "$RESPONSE" | grep -qiE "no pending escalation|id mismatch|Reached max turns|invocation failed|API Error|^Error:"; then
      echo "[$(date +%H:%M:%S)] ⚠ DROP ($ESC_ID) ─────────────────────────────"
      echo "$RESPONSE"
      echo "─────────────────────────────────────────────────────────────"
      {
        echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) DROP ($ESC_ID) ====="
        echo "$RESPONSE"
        echo ""
      } >> /tmp/sinain-drops.log
    else
      echo "[$(date +%H:%M:%S)] Responded ($ESCALATION_COUNT total): ${RESPONSE:0:120}..."
    fi
    echo ""
  fi

  # Poll for pending spawn task (queued via HUD Shift+Enter or POST /spawn).
  # Skip entirely when the spawn lane is Off — queued tasks will TTL on
  # the server side. This prevents fetching + throwing away task bodies.
  if [ -n "$SPAWN_AGENT" ]; then
    SPAWN=$(curl -sf "$CORE_URL/spawn/pending" 2>/dev/null || echo '{"ok":false}')
    apply_config_from_response "$SPAWN"
    SPAWN_ID=$(echo "$SPAWN" | python3 -c "import sys,json; d=json.load(sys.stdin); t=d.get('task'); print(t['id'] if t else '')" 2>/dev/null || true)
  else
    SPAWN_ID=""
  fi

  if [ -n "$SPAWN_ID" ]; then
    SPAWN_TASK=$(echo "$SPAWN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['task']['task'])" 2>/dev/null)
    SPAWN_LABEL=$(echo "$SPAWN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['task'].get('label','task'))" 2>/dev/null)

    echo "[$(date +%H:%M:%S)] Spawn task $SPAWN_ID ($SPAWN_LABEL)"

    if agent_has_mcp "$SPAWN_AGENT"; then
      # MCP path: agent runs task with sinain tools available
      # Pre-fetch knowledge context so the spawn doesn't waste turns calling tools
      SPAWN_KNOWLEDGE=$(curl -sf "$CORE_URL/knowledge" 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
k = d.get('knowledge', '')
# Trim to 2000 chars to avoid prompt bloat
print(k[:2000])
" 2>/dev/null || true)
      SPAWN_PROMPT="You have a background task to complete. Task: $SPAWN_TASK
${SPAWN_KNOWLEDGE:+
## Knowledge Context
$SPAWN_KNOWLEDGE
}
Complete this task thoroughly. You also have sinain_get_knowledge and sinain_knowledge_query tools available for additional context. Summarize your findings concisely."
      export SINAIN_SPAWN=1 SINAIN_SPAWN_TASK_ID="$SPAWN_ID"
      SPAWN_RESULT=$(invoke_agent "$SPAWN_AGENT" "$SPAWN_PROMPT" "$SPAWN_MAX_TURNS" || echo "ERROR: $SPAWN_AGENT invocation failed")
      unset SINAIN_SPAWN SINAIN_SPAWN_TASK_ID
    else
      # Pipe path: agent gets task text directly
      SPAWN_RESULT=$(invoke_pipe "$SPAWN_AGENT" "Background task: $SPAWN_TASK" || echo "No output")
    fi

    # Post result back
    if [ -n "$SPAWN_RESULT" ]; then
      curl -sf -X POST "$CORE_URL/spawn/respond" \
        -H 'Content-Type: application/json' \
        -d "{\"id\":\"$SPAWN_ID\",\"result\":$(echo "$SPAWN_RESULT" | json_encode)}" >/dev/null 2>&1 || true
      echo "[$(date +%H:%M:%S)] Spawn $SPAWN_ID completed: ${SPAWN_RESULT:0:120}..."
    fi
    echo ""
  fi

  # Heartbeat moved server-side: sinain-core's LocalCurationService runs the
  # full pipeline (signal_analyzer, insight_synthesizer, feedback_analyzer,
  # memory_miner, playbook_curator) every 30 min natively, and broadcasts
  # insights to the HUD directly. No LLM roundtrip needed here.

  sleep "$POLL_INTERVAL"
done
