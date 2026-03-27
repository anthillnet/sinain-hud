#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load .env as fallback — does NOT override vars already in the environment
# (e.g. vars set by the launcher from ~/.sinain/.env)
if [ -f "$SCRIPT_DIR/.env" ]; then
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
  done < "$SCRIPT_DIR/.env"
fi

MCP_CONFIG="${MCP_CONFIG:-$SCRIPT_DIR/mcp-config.json}"
CORE_URL="${SINAIN_CORE_URL:-http://localhost:9500}"
POLL_INTERVAL="${SINAIN_POLL_INTERVAL:-2}"
HEARTBEAT_INTERVAL="${SINAIN_HEARTBEAT_INTERVAL:-900}" # 15 minutes
AGENT="${SINAIN_AGENT:-claude}"
WORKSPACE="${SINAIN_WORKSPACE:-$HOME/.openclaw/workspace}"

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
  case "$AGENT" in
    claude|codex|goose) return 0 ;;
    junie) $JUNIE_HAS_MCP ;;
    *) return 1 ;;
  esac
}

# Invoke the selected agent with a prompt. MCP-capable agents get the config
# so they can call sinain tools directly. Returns text on stdout.
# Exit code 1 means "agent doesn't support MCP — use pipe mode instead".
invoke_agent() {
  local prompt="$1"
  case "$AGENT" in
    claude)
      claude --enable-auto-mode \
        --mcp-config "$MCP_CONFIG" \
        ${ALLOWED_TOOLS:+--allowedTools $ALLOWED_TOOLS} \
        --max-turns 5 --output-format text \
        -p "$prompt"
      ;;
    codex)
      codex exec -s danger-full-access \
        --dangerously-bypass-approvals-and-sandbox \
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
      GOOSE_MODE=auto goose run --text "$prompt" \
        --output-format text \
        --max-turns 10
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
  local msg="$1"
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

# Agent mode label
if agent_has_mcp; then
  AGENT_MODE="MCP"
else
  AGENT_MODE="pipe"
fi

echo "sinain bare agent started"
echo "  Agent: $AGENT ($AGENT_MODE)"
echo "  Core: $CORE_URL"
echo "  Allowed: ${ALLOWED_TOOLS:-<none>}"
echo "  Poll: every ${POLL_INTERVAL}s"
echo "  Heartbeat: every ${HEARTBEAT_INTERVAL}s"
echo "  Press Ctrl+C to stop"
echo ""

LAST_HEARTBEAT=$(date +%s)
ESCALATION_COUNT=0

cleanup() {
  echo ""
  echo "Agent stopped. Escalations handled: $ESCALATION_COUNT"
  exit 0
}
trap cleanup INT TERM

# --- Prompt templates ---

ESC_PROMPT_TEMPLATE='You are the sinain HUD agent. An escalation is pending with ID=%s.

Call sinain_get_escalation to see the full context, then call sinain_respond with the ID and your response.

Response guidelines: 5-10 sentences, address errors first, reference specific screen/audio context, never NO_REPLY. Max 4000 chars for coding context, 3000 otherwise.'

HEARTBEAT_PROMPT='You are the sinain HUD agent. Run the heartbeat cycle:
1. Call sinain_heartbeat_tick with a brief session summary
2. If the result contains a suggestion, post it to HUD via sinain_post_feed
3. Call sinain_get_feedback to review recent scores'

# --- Main loop ---

while true; do
  # Poll for pending escalation
  ESC=$(curl -sf "$CORE_URL/escalation/pending" 2>/dev/null || echo '{"ok":false}')
  ESC_ID=$(echo "$ESC" | python3 -c "import sys,json; d=json.load(sys.stdin); e=d.get('escalation'); print(e['id'] if e else '')" 2>/dev/null || true)

  if [ -n "$ESC_ID" ]; then
    ESC_MSG=$(echo "$ESC" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['escalation']['message'])" 2>/dev/null)
    ESC_SCORE=$(echo "$ESC" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['escalation'].get('score','?'))" 2>/dev/null)
    ESC_CODING=$(echo "$ESC" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['escalation'].get('codingContext',False))" 2>/dev/null)

    echo "[$(date +%H:%M:%S)] Escalation $ESC_ID (score=$ESC_SCORE, coding=$ESC_CODING)"

    if agent_has_mcp; then
      # MCP path: agent calls sinain tools directly
      PROMPT=$(printf "$ESC_PROMPT_TEMPLATE" "$ESC_ID")
      RESPONSE=$(invoke_agent "$PROMPT" || echo "ERROR: $AGENT invocation failed")
    else
      # Pipe path: bash handles HTTP, agent just generates text
      RESPONSE=$(invoke_pipe "$ESC_MSG" || true)
      if [ -n "$RESPONSE" ]; then
        post_response "$ESC_ID" "$RESPONSE"
      else
        echo "[$(date +%H:%M:%S)] WARNING: $AGENT returned empty response"
      fi
    fi

    ESCALATION_COUNT=$((ESCALATION_COUNT + 1))
    echo "[$(date +%H:%M:%S)] Responded ($ESCALATION_COUNT total): ${RESPONSE:0:120}..."
    echo ""
  fi

  # Poll for pending spawn task (queued via HUD Shift+Enter or POST /spawn)
  SPAWN=$(curl -sf "$CORE_URL/spawn/pending" 2>/dev/null || echo '{"ok":false}')
  SPAWN_ID=$(echo "$SPAWN" | python3 -c "import sys,json; d=json.load(sys.stdin); t=d.get('task'); print(t['id'] if t else '')" 2>/dev/null || true)

  if [ -n "$SPAWN_ID" ]; then
    SPAWN_TASK=$(echo "$SPAWN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['task']['task'])" 2>/dev/null)
    SPAWN_LABEL=$(echo "$SPAWN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['task'].get('label','task'))" 2>/dev/null)

    echo "[$(date +%H:%M:%S)] Spawn task $SPAWN_ID ($SPAWN_LABEL)"

    if agent_has_mcp; then
      # MCP path: agent runs task with sinain tools available
      SPAWN_PROMPT="You have a background task to complete. Task: $SPAWN_TASK

Complete this task thoroughly. Use sinain_get_knowledge and sinain_knowledge_query if you need context from past sessions. Summarize your findings concisely."
      SPAWN_RESULT=$(invoke_agent "$SPAWN_PROMPT" || echo "ERROR: agent invocation failed")
    else
      # Pipe path: agent gets task text directly
      SPAWN_RESULT=$(invoke_pipe "Background task: $SPAWN_TASK" || echo "No output")
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

  # Heartbeat check
  NOW=$(date +%s)
  ELAPSED=$((NOW - LAST_HEARTBEAT))
  if [ "$ELAPSED" -ge "$HEARTBEAT_INTERVAL" ]; then
    echo "[$(date +%H:%M:%S)] Running heartbeat tick..."

    if agent_has_mcp; then
      # MCP path: agent runs heartbeat tools
      invoke_agent "$HEARTBEAT_PROMPT" || true
    else
      # Pipe path: run curation scripts directly
      SCRIPTS_DIR="$WORKSPACE/sinain-memory"
      MEMORY_DIR="$WORKSPACE/memory"
      if [ -d "$SCRIPTS_DIR" ]; then
        python3 "$SCRIPTS_DIR/signal_analyzer.py" --memory-dir "$MEMORY_DIR" 2>/dev/null || true
        python3 "$SCRIPTS_DIR/playbook_curator.py" --memory-dir "$MEMORY_DIR" 2>/dev/null || true
        echo "[$(date +%H:%M:%S)] Heartbeat: ran signal_analyzer + playbook_curator"
      else
        echo "[$(date +%H:%M:%S)] Heartbeat: skipped (no scripts at $SCRIPTS_DIR)"
      fi
    fi

    LAST_HEARTBEAT=$NOW
    echo "[$(date +%H:%M:%S)] Heartbeat complete"
    echo ""
  fi

  sleep "$POLL_INTERVAL"
done
