#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Interactive thread-terminal mode: `run.sh --interactive-region <id>`
# resolves the SPAWN-lane profile exactly like the poll loop, fetches the
# region's composed context from sinain-core, and execs the agent CLI
# *interactively* (the overlay's thread terminal runs this). No polling,
# no roster registration — see the branch below the proxy block.
INTERACTIVE_REGION=""
if [ "${1:-}" = "--interactive-region" ]; then
  INTERACTIVE_REGION="${2:?usage: run.sh --interactive-region <regionId>}"
fi

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
WORKSPACE="${SINAIN_WORKSPACE:-$HOME/.openclaw/workspace}"

# --- agents.json early bootstrap + top-level helper ---
# We need top-level fields (default agent, turns, allowed tools, poll
# interval) BEFORE the per-profile loader runs further down. So compute
# the file path here and define a helper to read individual fields.
#
# Path priority (highest first):
#   1. $AGENTS_CONFIG_PATH (explicit env override)
#   2. ~/.sinain/agents.json (wizard write target — works on npm installs
#      where the package dir is read-only)
#   3. $SCRIPT_DIR/agents.json (legacy/dev-repo location)
# agents.example.json (committed template) is the bootstrap source if
# none of the above exists yet.
AGENTS_EXAMPLE="$SCRIPT_DIR/agents.example.json"
USER_AGENTS_FILE="$HOME/.sinain/agents.json"
if [ -n "${AGENTS_CONFIG_PATH:-}" ]; then
  AGENTS_FILE="$AGENTS_CONFIG_PATH"
elif [ -f "$USER_AGENTS_FILE" ]; then
  AGENTS_FILE="$USER_AGENTS_FILE"
else
  AGENTS_FILE="$SCRIPT_DIR/agents.json"
fi
# First-run bootstrap: prefer dev location ($SCRIPT_DIR/agents.json) when
# the package dir is writable; otherwise seed user home (~/.sinain).
if [ ! -f "$AGENTS_FILE" ] && [ -f "$AGENTS_EXAMPLE" ]; then
  if [ -w "$SCRIPT_DIR" ] && [ "$AGENTS_FILE" = "$SCRIPT_DIR/agents.json" ]; then
    echo "  Creating $AGENTS_FILE from agents.example.json (first-run bootstrap)"
    cp "$AGENTS_EXAMPLE" "$AGENTS_FILE"
  else
    mkdir -p "$HOME/.sinain"
    AGENTS_FILE="$USER_AGENTS_FILE"
    echo "  Creating $AGENTS_FILE from agents.example.json (first-run bootstrap)"
    cp "$AGENTS_EXAMPLE" "$AGENTS_FILE"
  fi
fi

# agents_get <key> [default]
# Reads a top-level scalar field from agents.json. Supports cross-field
# substitution: a value like "${allowedTools} Bash(git:*)" resolves
# `${allowedTools}` against the same JSON before being returned. Env-var
# expansion happens via apply_profile_env later (or by shell when the
# value is exported), so we stop at one substitution pass here.
agents_get() {
  local key="$1" def="${2:-}"
  local val
  if [ ! -f "$AGENTS_FILE" ]; then
    printf '%s' "$def"
    return 0
  fi
  val=$(python3 - "$AGENTS_FILE" "$key" <<'PY' 2>/dev/null
import json, sys, re
path, key = sys.argv[1], sys.argv[2]
try:
    with open(path) as f:
        data = json.load(f)
except Exception:
    sys.exit(0)
val = data.get(key)
if val is None:
    sys.exit(0)
if isinstance(val, str):
    def repl(m):
        other = data.get(m.group(1))
        return other if isinstance(other, str) else m.group(0)
    val = re.sub(r'\$\{([A-Za-z_][A-Za-z0-9_]*)\}', repl, val)
print(val)
PY
)
  if [ -z "$val" ]; then
    printf '%s' "$def"
  else
    printf '%s' "$val"
  fi
}

# Top-level config: agents.json wins, env vars are honored as a fallback
# (during the migration window — once .env is fully cleaned up, the
# env reads become dead code).
POLL_INTERVAL="${SINAIN_POLL_INTERVAL:-$(agents_get pollIntervalSec 2)}"
AGENT="${SINAIN_AGENT:-$(agents_get default claude)}"
AGENT_MAX_TURNS="${SINAIN_AGENT_MAX_TURNS:-$(agents_get agentMaxTurns 5)}"
SPAWN_MAX_TURNS="${SINAIN_SPAWN_MAX_TURNS:-$(agents_get spawnMaxTurns 25)}"

# Build allowed tools list for Claude's --allowedTools flag.
# Priority: SINAIN_ALLOWED_TOOLS env > agents.json `allowedTools` >
# auto-derive from MCP config > "mcp__sinain" hardcoded default.
if [ -n "${SINAIN_ALLOWED_TOOLS:-}" ]; then
  ALLOWED_TOOLS="$SINAIN_ALLOWED_TOOLS"
else
  ALLOWED_TOOLS=$(agents_get allowedTools "")
  if [ -z "$ALLOWED_TOOLS" ] && [ -f "$MCP_CONFIG" ]; then
    ALLOWED_TOOLS=$(python3 -c "
import json
with open('$MCP_CONFIG') as f:
    cfg = json.load(f)
print(' '.join('mcp__' + s for s in cfg.get('mcpServers', {})))
" 2>/dev/null || echo "mcp__sinain")
  fi
  [ -z "$ALLOWED_TOOLS" ] && ALLOWED_TOOLS="mcp__sinain"
fi

# Per-lane allowed tools — agents.json wins, env vars override per-host.
# Note: agents.json's `escAllowedTools` already substitutes ${allowedTools}
# during agents_get, so the value is fully composed by the time we read it.
SINAIN_ESC_ALLOWED_TOOLS="${SINAIN_ESC_ALLOWED_TOOLS:-$(agents_get escAllowedTools "")}"
SINAIN_SPAWN_ALLOWED_TOOLS="${SINAIN_SPAWN_ALLOWED_TOOLS:-$(agents_get spawnAllowedTools "")}"
export SINAIN_ESC_ALLOWED_TOOLS SINAIN_SPAWN_ALLOWED_TOOLS

# --- Agent profiles ---

# --- Agent profile registry (loaded from agents.json at startup) ---
# Each profile maps a roster name → {bin, type, settings, model, env}.
# The roster (AVAILABLE_AGENTS) is profile names whose bin is on PATH;
# invoke_agent dispatches by profile.type and substitutes profile.bin.
# This lets users add custom names like "pclaude" pointing at a binary
# of the same kind as claude but with different env/settings.
#
# Implemented with namespaced variables (PROFILE_<UPPER_NAME>_<FIELD>)
# instead of bash-4 associative arrays so the script runs on macOS's
# default bash 3.2.
ALL_PROFILES=()
JUNIE_HAS_MCP=false  # set during startup checks for the junie-typed profile

# Internal: build the namespaced variable name for (profile, field).
# Profile names like "pclaude" → "PCLAUDE"; "openclaude-spawn" → "OPENCLAUDE_SPAWN".
_prof_var() {
  local name="$1" field="$2"
  local safe_name
  safe_name=$(echo "$name" | tr 'a-z-' 'A-Z_')
  local field_upper
  field_upper=$(echo "$field" | tr 'a-z' 'A-Z')
  echo "PROFILE_${safe_name}_${field_upper}"
}

prof_set() {
  local name="$1" field="$2" value="$3"
  local var
  var=$(_prof_var "$name" "$field")
  printf -v "$var" '%s' "$value"
  # Track distinct profile names in ALL_PROFILES (no duplicates).
  local found=false p
  for p in "${ALL_PROFILES[@]:-}"; do
    [ "$p" = "$name" ] && { found=true; break; }
  done
  $found || ALL_PROFILES+=("$name")
}

prof_get() {
  local name="$1" field="$2"
  local var
  var=$(_prof_var "$name" "$field")
  echo "${!var:-}"
}

# Read with a fallback default (last arg).
prof_get_or() {
  local val
  val=$(prof_get "$1" "$2")
  echo "${val:-$3}"
}

# Returns 0 if the selected profile's TYPE supports MCP tools natively.
# Optional arg: profile name. Defaults to $AGENT for back-compat with
# startup-time usage. Main loop passes the lane-specific choice.
agent_has_mcp() {
  local check="${1:-$AGENT}"
  local type
  type=$(prof_get_or "$check" type "$check")
  case "$type" in
    claude|openclaude|codex|goose) return 0 ;;
    # Hermes is an MCP client, but headless tool approval (calling back into
    # sinain_respond) depends on its yolo/approval config. Default to pipe
    # mode (self-contained text oracle); opt in to the claude-style MCP flow
    # with HERMES_USE_MCP=true once approval is configured (see startup block).
    hermes) [ "${HERMES_USE_MCP:-false}" = "true" ] && return 0 || return 1 ;;
    junie) $JUNIE_HAS_MCP ;;
    *) return 1 ;;
  esac
}

# Apply per-profile env overrides in the current (sub)shell. Values may
# use ${VAR} indirection (anywhere in the string, e.g. "${HOME}/sub/path"
# or "${PERSONAL_OPENAI_API_KEY}") to pull from the parent's environment
# so secrets stay in .env, not in agents.json. Only ${...} braced refs are
# expanded — bare $VAR and $(cmd) are left literal to avoid surprises and
# command-injection risk from a typo'd config.
apply_profile_env() {
  local profile="$1"
  local env_str
  env_str=$(prof_get "$profile" env)
  [ -z "$env_str" ] && return 0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local k="${line%%=*}"
    local v="${line#*=}"
    # Inline ${VAR} expansion via python — handles both whole-value and
    # embedded references. python sees env via os.environ, so we don't
    # need to shell-export anything ahead of time.
    if [[ "$v" == *'${'* ]]; then
      v=$(printf '%s' "$v" | python3 -c 'import os,re,sys; sys.stdout.write(re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", lambda m: os.environ.get(m.group(1), ""), sys.stdin.read()))')
    fi
    export "$k=$v"
  done <<< "$env_str"
}

# Invoke a profile with a prompt. First arg is the profile NAME (looked up
# in PROFILE_*); second is the prompt; third optional is turns. Profile's
# bin/type/settings/model/env apply per-invocation. Body runs in a subshell
# so apply_profile_env's exports don't leak into the parent.
# Returns text on stdout. Exit code 1 means "type doesn't support MCP —
# use pipe mode instead".
invoke_agent() {
  (
    local profile="$1"
    local prompt="$2"
    local turns="${3:-$AGENT_MAX_TURNS}"
    local bin type settings model
    bin=$(prof_get_or "$profile" bin "$profile")
    type=$(prof_get_or "$profile" type "$profile")
    settings=$(prof_get_or "$profile" settings "$SCRIPT_DIR/.claude/settings.json")
    model=$(prof_get "$profile" model)
    apply_profile_env "$profile"
    # If the profile pinned a model, override OPENAI_MODEL for this call only.
    [ -n "$model" ] && export OPENAI_MODEL="$model"

    case "$type" in
      claude|openclaude)
        # Stderr filter: drops openclaude's repeated "not in context window table"
        # warnings (one per LLM call, ~40/escalation). All other stderr passes through.
        # No-op for claude (it doesn't emit that line). Toggle with QUIET_OPENCLAUDE=false.
        local quiet="${QUIET_OPENCLAUDE:-true}"
        if [ -n "${SINAIN_SPAWN:-}" ]; then
          # Spawn path: user-initiated tasks often need git/edit/write. The
          # --allowedTools whitelist is a pre-invocation gate; PreToolUse hook
          # still routes each call to the overlay for user Allow/Deny. Widen the
          # whitelist so the hook can do its job. Override via SINAIN_SPAWN_ALLOWED_TOOLS.
          local spawn_allowed="${SINAIN_SPAWN_ALLOWED_TOOLS:-${ALLOWED_TOOLS} Bash(git:*) Edit Write Read Glob Grep LS}"
          # ToolSearch is a built-in Claude Code uses to load deferred MCP tool
          # schemas. Without it pre-approved, every escalation that needs an
          # un-cached sinain_* tool triggers a permission prompt — Test Mac
          # hit this on overlay-v1.24.5 (~4 prompts per 7min). Always include
          # regardless of agents.json content (defense-in-depth).
          spawn_allowed="$spawn_allowed ToolSearch"
          if [ "$quiet" = "true" ]; then
            "$bin" \
              --mcp-config "$MCP_CONFIG" \
              --settings "$settings" \
              --allowedTools $spawn_allowed \
              --max-turns "$turns" --output-format text \
              -p "$prompt" \
              2> >(grep -v "not in context window table" >&2)
          else
            "$bin" \
              --mcp-config "$MCP_CONFIG" \
              --settings "$settings" \
              --allowedTools $spawn_allowed \
              --max-turns "$turns" --output-format text \
              -p "$prompt"
          fi
        else
          # Escalation path. Override via SINAIN_ESC_ALLOWED_TOOLS.
          local esc_allowed="${SINAIN_ESC_ALLOWED_TOOLS:-${ALLOWED_TOOLS} Bash(git:*) Edit Write Read Glob Grep LS}"
          # See spawn_allowed comment above — ToolSearch must be pre-approved
          # or every escalation triggers a permission prompt.
          esc_allowed="$esc_allowed ToolSearch"
          if [ "$quiet" = "true" ]; then
            "$bin" \
              --mcp-config "$MCP_CONFIG" \
              --settings "$settings" \
              --allowedTools $esc_allowed \
              --max-turns "$turns" --output-format text \
              -p "$prompt" \
              2> >(grep -v "not in context window table" >&2)
          else
            "$bin" \
              --mcp-config "$MCP_CONFIG" \
              --settings "$settings" \
              --allowedTools $esc_allowed \
              --max-turns "$turns" --output-format text \
              -p "$prompt"
          fi
        fi
        ;;
      codex)
        "$bin" exec -s danger-full-access \
          --dangerously-bypass-approvals-and-sandbox \
          --skip-git-repo-check \
          "$prompt"
        ;;
      junie)
        if $JUNIE_HAS_MCP; then
          if [ ! -f "$HOME/.junie/allowlist.json" ]; then
            echo "  ⚠ Junie: no allowlist.json — MCP tools may prompt. Run junie --brave once to create it." >&2
          fi
          "$bin" --output-format text \
            --mcp-location "$JUNIE_MCP_DIR" \
            --task "$prompt"
        else
          return 1
        fi
        ;;
      goose)
        GOOSE_MODE=auto "$bin" run --text "$prompt" \
          --output-format text \
          --quiet \
          --no-session \
          --max-turns "$turns"
        ;;
      hermes)
        # MCP mode (reached only when HERMES_USE_MCP=true — see agent_has_mcp).
        # Hermes loads the sinain MCP server from ~/.hermes/config.yaml
        # (registered at startup) and calls sinain_respond / sinain_knowledge_query
        # itself, mirroring the claude flow. `-z/--oneshot` prints only the final
        # text to stdout and auto-bypasses approvals (no TTY hang). Turn budget
        # comes from config.yaml (max_turns, default 60) — there's no top-level
        # --max-turns flag. `--toolsets`/`-t` can narrow tools if needed.
        "$bin" -z "$prompt"
        ;;
      aider)
        return 1  # No MCP support — caller falls back to invoke_pipe
        ;;
      *)
        return 1  # Unknown type — caller falls back to invoke_pipe
        ;;
    esac
  )
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
  (
    local profile="$1"
    local msg="$2"
    local bin type
    bin=$(prof_get_or "$profile" bin "$profile")
    type=$(prof_get_or "$profile" type "$profile")
    apply_profile_env "$profile"
    # Below uses $bin instead of $AGENT and $type for the case-dispatch
    # selector. Variable named AGENT is preserved as alias for type-only
    # lookups to keep the body diff minimal.
    local AGENT="$type"
  case "$AGENT" in
    junie)
      "$bin" --output-format text --task "$msg"
      ;;
    aider)
      "$bin" --yes -m "$msg"
      ;;
    hermes)
      # Hermes one-shot: `-z/--oneshot` sends a single prompt and prints ONLY
      # the final response text to stdout (no banner/spinner/tool previews,
      # no session-id line) — and auto-bypasses tool approvals, so it never
      # hangs waiting on a TTY. Tools, memory, and skills still load. The
      # escalation message already includes full screen/audio/digest context,
      # so Hermes answers as a self-contained oracle using its own configured
      # model (set via `hermes model`/`hermes setup`) — no sinain MCP needed.
      # For the richer flow where Hermes calls sinain tools, set HERMES_USE_MCP=true.
      "$bin" -z "$msg" 2>/dev/null
      ;;
    *)
      # Generic: pipe message to stdin to whatever binary the profile names
      echo "$msg" | "$bin" 2>/dev/null
      ;;
  esac
  )
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

# Hermes: auto-register sinain MCP server in ~/.hermes/config.yaml (opt-in).
# Only when HERMES_USE_MCP=true and hermes is the selected agent — pipe mode
# (the default) is a black-box text oracle and needs none of this. Hermes
# reads MCP servers from config.yaml under the `mcp_servers` key (stdio:
# command + args + env). ruamel.yaml (a Hermes core dep) preserves the
# user's comments/formatting; falls back to PyYAML if unavailable.
if [ "${HERMES_USE_MCP:-false}" = "true" ] && [ "$AGENT" = "hermes" ]; then
  TSX_BIN="$(cd "$SCRIPT_DIR/.." && pwd)/sinain-core/node_modules/.bin/tsx"
  MCP_ENTRY="$(cd "$SCRIPT_DIR/.." && pwd)/sinain-mcp-server/index.ts"
  HERMES_CONFIG="${HERMES_CONFIG_DIR:-$HOME/.hermes}/config.yaml"
  if [ -f "$HERMES_CONFIG" ] && ! grep -q "sinain:" "$HERMES_CONFIG" 2>/dev/null; then
    echo "Registering sinain MCP server with hermes ($HERMES_CONFIG)..."
    python3 -c "
import sys
try:
    from ruamel.yaml import YAML
    _y = YAML()
    load = _y.load
    def dump(cfg, f): _y.dump(cfg, f)
except Exception:
    import yaml as _py
    load = _py.safe_load
    def dump(cfg, f): _py.safe_dump(cfg, f, default_flow_style=False, sort_keys=False)
path, tsx, entry, core, ws = sys.argv[1:6]
with open(path) as f:
    cfg = load(f) or {}
cfg.setdefault('mcp_servers', {})['sinain'] = {
    'command': tsx,
    'args': [entry],
    'env': {'SINAIN_CORE_URL': core, 'SINAIN_WORKSPACE': ws},
}
with open(path, 'w') as f:
    dump(cfg, f)
print('  sinain mcp_server added to ' + path)
" "$HERMES_CONFIG" "$TSX_BIN" "$MCP_ENTRY" "$CORE_URL" "$WORKSPACE"
  elif [ ! -f "$HERMES_CONFIG" ]; then
    echo "  ⚠ HERMES_USE_MCP=true but $HERMES_CONFIG missing — run \`hermes setup\` first"
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

# --- Load agent profiles from agents.json ---
# Built-in defaults are 1:1 (profile name == binary == type). Users can
# override fields or add custom profiles by editing sinain-agent/agents.json.
# Profiles whose binaries aren't in PATH are silently skipped.
for default_name in claude openclaude codex goose junie aider hermes; do
  prof_set "$default_name" bin "$default_name"
  prof_set "$default_name" type "$default_name"
done

# Path + bootstrap for AGENTS_FILE happen earlier in this script (right
# after CORE_URL is set) so top-level scalars can be read before the
# default-AGENT block. The full per-profile flatten still happens below.
if [ -f "$AGENTS_FILE" ]; then
  # Python flattens profiles into "name|field|value" lines; we ingest in
  # the parent shell via process substitution so prof_set writes (which
  # mutate ALL_PROFILES) persist — a piped `while` would run in a
  # subshell and lose them.
  while IFS='|' read -r p_name p_field p_value; do
    [ -z "$p_name" ] && continue
    case "$p_field" in
      bin)      prof_set "$p_name" bin      "$p_value" ;;
      type)     prof_set "$p_name" type     "$p_value" ;;
      settings) prof_set "$p_name" settings "${p_value/#\~/$HOME}" ;;
      model)    prof_set "$p_name" model    "$p_value" ;;
      env)
        # env is multi-line: each "k=v" pair on its own line. Append to
        # any existing env block so multiple env entries accumulate.
        existing_env=$(prof_get "$p_name" env)
        if [ -n "$existing_env" ]; then
          prof_set "$p_name" env "$existing_env"$'\n'"$p_value"
        else
          prof_set "$p_name" env "$p_value"
        fi
        ;;
    esac
  done < <(python3 -c '
import json, sys
try:
  with open(sys.argv[1]) as f:
    data = json.load(f)
except Exception as e:
  sys.stderr.write(f"agents.json parse failed: {e}\n")
  sys.exit(0)
profiles = data.get("profiles", {}) or {}
for name, prof in profiles.items():
  if not isinstance(prof, dict): continue
  for field in ("bin", "type", "settings", "model"):
    val = prof.get(field)
    if val: print(f"{name}|{field}|{val}")
  env = prof.get("env") or {}
  if isinstance(env, dict):
    for k, v in env.items():
      print(f"{name}|env|{k}={v}")
' "$AGENTS_FILE")
fi

# Fill in defaults for any profile that didn't specify bin or type.
# (A profile defined with only env/settings/model still needs bin/type;
# default both to the profile name for the 1:1 case.)
for p in "${ALL_PROFILES[@]:-}"; do
  [ -z "$(prof_get "$p" bin)" ]  && prof_set "$p" bin  "$p"
  [ -z "$(prof_get "$p" type)" ] && prof_set "$p" type "$p"
done

# AVAILABLE_AGENTS = profile names whose configured bin is on PATH.
# This is what gets POSTed to /bareagent/register and shown in the
# overlay selector. Lane-specific choices (ESC_AGENT, SPAWN_AGENT)
# default to $AGENT and are refreshed per-iteration from the config
# piggyback field on /escalation/pending and /spawn/pending responses.
AVAILABLE_AGENTS=()
for p in "${ALL_PROFILES[@]:-}"; do
  # Gateway-style profiles (type=openclaw) have no local binary — they're
  # dispatched by sinain-core via WS RPC. Include them in the roster
  # regardless of PATH so they show up in the overlay's agent selector.
  ptype=$(prof_get_or "$p" type "$p")
  if [ "$ptype" = "openclaw" ]; then
    AVAILABLE_AGENTS+=("$p")
    continue
  fi
  if command -v "$(prof_get_or "$p" bin "$p")" >/dev/null 2>&1; then
    AVAILABLE_AGENTS+=("$p")
  fi
done

# Sanity check the configured default agent
AGENT_BIN=$(prof_get_or "$AGENT" bin "$AGENT")
if ! command -v "$AGENT_BIN" >/dev/null 2>&1; then
  echo "  ⚠ configured agent '$AGENT' (bin=$AGENT_BIN) not installed — waiting for overlay override"
fi

ESC_AGENT="$AGENT"
SPAWN_AGENT="$AGENT"

# Register roster with sinain-core (fire-and-forget; core may not be ready).
# Skipped in interactive mode: a second register would echo `current=$AGENT`
# back to core and reset the user's per-lane selections.
if [ ${#AVAILABLE_AGENTS[@]} -gt 0 ] && [ -z "$INTERACTIVE_REGION" ]; then
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
# and /spawn/pending response JSONs. Heals only when core explicitly signals
# `registered: false` (core forgot our roster, probably restarted) — NOT
# when the user legitimately picks Off/Off from the selector.
apply_config_from_response() {
  local json="$1"
  # Short-circuit: only process if the response actually includes a config.
  echo "$json" | grep -q '"config"' || return 0
  local new_esc new_spawn registered
  new_esc=$(echo "$json"     | python3 -c "import sys,json; d=json.load(sys.stdin); c=d.get('config') or {}; print(c.get('escalationAgent',''))" 2>/dev/null)
  new_spawn=$(echo "$json"   | python3 -c "import sys,json; d=json.load(sys.stdin); c=d.get('config') or {}; print(c.get('spawnAgent',''))" 2>/dev/null)
  registered=$(echo "$json"  | python3 -c "import sys,json; d=json.load(sys.stdin); c=d.get('config') or {}; print('true' if c.get('registered') else 'false')" 2>/dev/null)

  # Healing: core says it doesn't have our roster. Re-register (fire-and-
  # forget). Distinct from "user selected Off/Off" because in that case
  # registered is still true — core knows us, lanes are just blank.
  if [ "$registered" = "false" ] && [ ${#AVAILABLE_AGENTS[@]} -gt 0 ]; then
    echo "[$(date +%H:%M:%S)] core unregistered — re-registering roster"
    local heal_payload
    heal_payload=$(python3 -c "
import json, sys
print(json.dumps({'available': sys.argv[1].split(' '), 'current': sys.argv[2]}))
" "${AVAILABLE_AGENTS[*]}" "${ESC_AGENT:-$AGENT}")
    curl -sf -m 2 -X POST "$CORE_URL/bareagent/register" \
      -H 'Content-Type: application/json' \
      -d "$heal_payload" >/dev/null 2>&1 || true
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
# Starts sinain-agent/openrouter-proxy.mjs when any code path will need it.
# The proxy preserves reasoning_content across multi-turn MCP flows so
# DeepSeek V4 Flash (and other thinking models) don't 400 on turn-2.
#
# Detection: triggers if (a) the parent shell already has OPENAI_BASE_URL
# pointed at the proxy port (legacy .env-based config), OR (b) any loaded
# profile's env block references the proxy port (new agents.json-based
# config). The second case is what makes "all openclaude routing in
# agents.json" work without forcing a duplicate OPENAI_BASE_URL in .env.
PROXY_PID=""
PROXY_PORT="${OPENROUTER_PROXY_PORT:-11435}"
PROXY_NEEDED=false
if [[ "${OPENAI_BASE_URL:-}" == *":${PROXY_PORT}"* ]]; then
  PROXY_NEEDED=true
else
  for _p in "${ALL_PROFILES[@]:-}"; do
    _env=$(prof_get "$_p" env)
    if [[ "$_env" == *":${PROXY_PORT}"* ]]; then
      PROXY_NEEDED=true; break
    fi
  done
fi
if $PROXY_NEEDED; then
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

# --- Interactive region terminal (thread-terminal) ---
# Resolve the spawn lane's CURRENT agent from core's config piggyback
# (read-only peek at /escalation/pending — same field the poll loop uses),
# fetch the region context, and exec the agent CLI in its own REPL. The
# user converses with the dedicated spawn agent directly in the terminal.
if [ -n "$INTERACTIVE_REGION" ]; then
  lane=$(curl -sf -m 2 "$CORE_URL/escalation/pending" \
    | python3 -c "import sys,json; print((json.load(sys.stdin).get('config') or {}).get('spawnAgent',''))" 2>/dev/null || true)
  profile="${lane:-$AGENT}"
  bin=$(prof_get_or "$profile" bin "$profile")
  type=$(prof_get_or "$profile" type "$profile")
  task=$(curl -sf -m 5 "$CORE_URL/region/$INTERACTIVE_REGION/task" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('text',''))" 2>/dev/null || true)
  if [ -z "$task" ]; then
    task="(The screen-region context expired before this terminal opened. Ask the user what they need help with on screen.)"
  fi
  apply_profile_env "$profile"
  model=$(prof_get "$profile" model); [ -n "$model" ] && export OPENAI_MODEL="$model"
  # Same pre-approved whitelist as headless spawns. NOTE: no --settings —
  # interactive sessions should use the agent's native terminal approval UX,
  # not the overlay-routed PreToolUse hook from sinain-agent/.claude.
  spawn_allowed="${SINAIN_SPAWN_ALLOWED_TOOLS:-${ALLOWED_TOOLS} Bash(git:*) Edit Write Read Glob Grep LS} ToolSearch"
  echo "⌨ region terminal — agent=$profile ($type), region=$INTERACTIVE_REGION"
  case "$type" in
    claude|openclaude)
      exec "$bin" --mcp-config "$MCP_CONFIG" --allowedTools $spawn_allowed "$task"
      ;;
    codex)
      exec "$bin" "$task"
      ;;
    *)
      echo "⚠ agent type '$type' has no interactive terminal mode — plain shell instead"
      echo "  (region context lost; use the chat Run button for this agent)"
      exec "${SHELL:-/bin/zsh}" -il
      ;;
  esac
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

# Consecutive-drop tracking for the escalation lane (see DROP handling below).
LAST_DROP_ID=""
DROP_STREAK=0
MAX_DROP_RETRIES="${SINAIN_MAX_DROP_RETRIES:-3}"

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

  # Escalation lane guard: skip when the lane is Off (empty) OR routed to
  # openclaw (gateway-handled, not local). Posting an "ack-skip" tells
  # sinain-core to drop the pending entry so we don't loop on it forever
  # if the gateway WS is down — the alternative (no response) leaves the
  # escalation in httpPending and we re-poll it every iteration.
  if [ -n "$ESC_ID" ] && [ -z "$ESC_AGENT" ]; then
    echo "[$(date +%H:%M:%S)] Escalation $ESC_ID skipped — lane is Off"
    post_response "$ESC_ID" "[skipped: lane is Off]" 2>/dev/null || true
    ESC_ID=""
  elif [ -n "$ESC_ID" ] && [ "$(prof_get_or "$ESC_AGENT" type "$ESC_AGENT")" = "openclaw" ]; then
    echo "[$(date +%H:%M:%S)] Escalation $ESC_ID skipped — gateway agent '$ESC_AGENT' (type=openclaw) is WS-routed, not a local CLI"
    post_response "$ESC_ID" "[skipped: $ESC_AGENT is gateway-routed; sinain-core should have dispatched via WS]" 2>/dev/null || true
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
      # A dropped escalation stays httpPending in sinain-core and is re-offered
      # every poll — without a cap, a persistently broken agent (e.g. auth that
      # works in a terminal but not under launchd) is re-invoked into the same
      # failure every few seconds, indefinitely. After N consecutive drops of
      # the SAME id, ack core to clear it and tell the user what's broken.
      if [ "$ESC_ID" = "$LAST_DROP_ID" ]; then
        DROP_STREAK=$((DROP_STREAK + 1))
      else
        LAST_DROP_ID="$ESC_ID"
        DROP_STREAK=1
      fi
      if [ "$DROP_STREAK" -ge "$MAX_DROP_RETRIES" ]; then
        echo "[$(date +%H:%M:%S)] ⚠ abandoning $ESC_ID after $DROP_STREAK failed invocations of '$ESC_AGENT'"
        post_response "$ESC_ID" "⚠ Agent '$ESC_AGENT' failed $DROP_STREAK times in a row (see /tmp/sinain-drops.log). If it works in your terminal but not here, its auth may rely on shell-profile env vars — restart Sinain, or switch the escalation lane to another agent." 2>/dev/null || true
        LAST_DROP_ID=""
        DROP_STREAK=0
      fi
    else
      echo "[$(date +%H:%M:%S)] Responded ($ESCALATION_COUNT total): ${RESPONSE:0:120}..."
      LAST_DROP_ID=""
      DROP_STREAK=0
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
      # Detect spawn-side errors (401/403/500, auth failures, max-turns,
      # crashes). Print full body inline between dividers + append to
      # /tmp/sinain-drops.log for post-hoc diagnosis, same UX as escalation.
      if echo "$SPAWN_RESULT" | grep -qiE "API Error|unauthorized|401|403|invalid_api_key|Reached max turns|invocation failed|^Error:"; then
        echo "[$(date +%H:%M:%S)] ⚠ SPAWN DROP ($SPAWN_ID) ──────────────────────"
        echo "$SPAWN_RESULT"
        echo "─────────────────────────────────────────────────────────────"
        {
          echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) SPAWN DROP ($SPAWN_ID, agent=$SPAWN_AGENT) ====="
          echo "$SPAWN_RESULT"
          echo ""
        } >> /tmp/sinain-drops.log
      else
        echo "[$(date +%H:%M:%S)] Spawn $SPAWN_ID completed: ${SPAWN_RESULT:0:120}..."
      fi
    fi
    echo ""
  fi

  # Heartbeat moved server-side: sinain-core's LocalCurationService runs the
  # full pipeline (signal_analyzer, insight_synthesizer, feedback_analyzer,
  # memory_miner, playbook_curator) every 30 min natively, and broadcasts
  # insights to the HUD directly. No LLM roundtrip needed here.

  sleep "$POLL_INTERVAL"
done
