#!/usr/bin/env bash
set -euo pipefail

# ── Stage the self-contained backend into a bundle Resources layout (REAL) ───
# SEED-001 Phase 2, Stage 3. Assembles bundled Node + compiled sinain-core +
# prod node_modules + sck-capture into build/stage/Resources/, then writes the
# launch script the overlay .app will spawn. arm64-only (SPEC §9 Q6 default).
# sense_client (Python/OCR) is deferred from the MVP DMG (SPEC §3 / Q3).
#
# Verifies nothing — run tools/dmg/verify-backend.sh after, or this script's
# tail self-check. Produces no .app and does no signing (that's Stage 6).

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STAGE="$REPO/build/stage"
RES="$STAGE/Resources"
NODE_BIN="$(command -v node)"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
fail() { printf "\033[0;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

[ -n "$NODE_BIN" ] || fail "node not found on PATH"
[ -f "$REPO/sinain-core/dist/index.js" ] || fail "sinain-core not built — run: (cd sinain-core && npm run build)"
[ -f "$REPO/tools/sck-capture/sck-capture" ] || fail "sck-capture not built — run: tools/sck-capture/build.sh"

bold "Cleaning stage → $STAGE"
rm -rf "$STAGE"
mkdir -p "$RES/node/bin" "$RES/sinain-core" "$RES/sck-capture" "$RES/scripts"

bold "1 · Bundling Node runtime ($(node --version), arm64)"
cp "$NODE_BIN" "$RES/node/bin/node"

bold "2 · Staging compiled sinain-core + production deps"
cp -R "$REPO/sinain-core/dist" "$RES/sinain-core/dist"
cp "$REPO/sinain-core/package.json" "$RES/sinain-core/package.json"
[ -f "$REPO/sinain-core/package-lock.json" ] && cp "$REPO/sinain-core/package-lock.json" "$RES/sinain-core/"
# Production-only install using the BUNDLED node, into the staged core.
( cd "$RES/sinain-core" && "$RES/node/bin/node" "$(command -v npm)" install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) \
  || fail "prod npm install failed in stage"

bold "3 · Staging sck-capture (arm64)"
cp "$REPO/tools/sck-capture/sck-capture" "$RES/sck-capture/sck-capture"
chmod +x "$RES/sck-capture/sck-capture"

bold "3b · Staging agent runtime (sinain-agent-runner + sinain-mcp-server)"
# Bare-agent runtime: run.sh dispatches escalations/spawns to a local coding
# CLI (claude/codex/…) using MCP tools from sinain-mcp-server. Tiny source;
# the MCP server needs its own prod deps (@modelcontextprotocol/sdk). tsx (to
# run the .ts MCP entry) already ships in sinain-core/node_modules/.bin.
cp -R "$REPO/sinain-agent-runner" "$RES/sinain-agent-runner"
rm -rf "$RES/sinain-agent-runner/agents.json"  # never bundle a user's agents.json
cp -R "$REPO/sinain-mcp-server" "$RES/sinain-mcp-server"
rm -rf "$RES/sinain-mcp-server/node_modules"
( cd "$RES/sinain-mcp-server" && "$RES/node/bin/node" "$(command -v npm)" install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) \
  || fail "prod npm install failed in sinain-mcp-server stage"

bold "3c · Staging Python pipelines (sense_client + sinain-memory knowledge)"
# Screen capture/OCR (sense_client) and the knowledge-graph distillation
# scripts (sinain-memory) run on the user's system python3. A self-contained
# PyInstaller build for consumer Macs without the deps is future work (Q3).
cp -R "$REPO/sense_client" "$RES/sense_client"
cp -R "$REPO/sinain-hud-plugin/sinain-memory" "$RES/sinain-memory"
find "$RES/sense_client" "$RES/sinain-memory" -name "__pycache__" -type d -prune -exec rm -rf {} + 2>/dev/null || true

bold "3d · Staging whisper-cli (local transcription, T1/T2)"
# Self-contained arm64 whisper.cpp binary (system frameworks only). The model
# downloads at runtime (T1/T2) via provision-whisper.sh.
if [ -f "$REPO/tools/whisper/whisper-cli" ]; then
  mkdir -p "$RES/whisper"
  cp "$REPO/tools/whisper/whisper-cli" "$RES/whisper/whisper-cli"
  chmod +x "$RES/whisper/whisper-cli"
else
  echo "  ⚠ tools/whisper/whisper-cli missing — run tools/whisper/build-whisper.sh (local STT will be unavailable)"
fi

bold "4 · Writing launch-backend.sh (supervisor: core + bare agent)"
cat > "$RES/scripts/launch-backend.sh" <<'LAUNCH'
#!/usr/bin/env bash
# Bundled-backend supervisor — spawned by the overlay .app on startup.
# Starts sinain-core, waits for health, then starts the bare agent (run.sh).
# Resolves all paths inside the bundle so nothing depends on the user's PATH.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"          # …/Resources/scripts
RES="$(cd "$HERE/.." && pwd)"                   # …/Resources
NODE="$RES/node/bin/node"
CORE="$RES/sinain-core"
AGENT_DIR="$RES/sinain-agent-runner"

# Capture all backend output (core + agent + sense_client) to a rotating log so
# failures are diagnosable — the overlay spawns this script with no stdout sink.
mkdir -p "$HOME/.sinain/logs"
LOG="$HOME/.sinain/logs/backend.log"
[ -f "$LOG" ] && [ "$(wc -c <"$LOG" 2>/dev/null || echo 0)" -gt 5000000 ] && mv "$LOG" "$LOG.1"
exec >>"$LOG" 2>&1
echo "===== backend launch $(date '+%Y-%m-%d %H:%M:%S') ====="
# Version banner — exported so every child (core, sense_client, agent) can
# log which build it is running.
[ -f "$RES/BUILD_ID" ] && export SINAIN_BUILD_ID="$(cat "$RES/BUILD_ID")"
[ -f "$RES/DMG_VERSION" ] && export SINAIN_DMG_VERSION="$(cat "$RES/DMG_VERSION")"
echo "[launch] versions: dmg=${SINAIN_DMG_VERSION:-n/a} build=${SINAIN_BUILD_ID:-n/a}"

# ── Refuse to run from a read-only location ──────────────────────────────────
# If the user double-clicked Sinain inside the mounted DMG (or a quarantine
# AppTranslocation copy) instead of moving it to /Applications, the bundle lives
# on a read-only volume. core/sense/sck-capture all execute from inside the
# bundle, so when that volume unmounts they're SIGKILL'd and the backend never
# stays online. The overlay shows a native "move to Applications" alert
# (AppDelegate BackendLauncher); this is the backstop when the script is run
# directly. Probe the directory *containing* the .app — writable on
# /Applications (and read-write external drives), read-only on a DMG — so we
# don't touch the signed bundle itself.
APP_CONTAINER="$(cd "$RES/../../.." 2>/dev/null && pwd || true)"
if [ -n "$APP_CONTAINER" ]; then
  _probe="$APP_CONTAINER/.sinain-write-probe.$$"
  if ! ( : > "$_probe" ) 2>/dev/null; then
    echo "[launch] ✗ Sinain is running from a read-only location ($APP_CONTAINER) — likely the mounted DMG."
    echo "[launch]   Move Sinain.app to /Applications and open it from there. Aborting backend startup."
    exit 78   # EX_CONFIG
  fi
  rm -f "$_probe" 2>/dev/null || true
fi

# Reset per-launch provisioning status (the overlay polls these files for the
# setup-progress banner; stale 'done' files from a prior run shouldn't linger).
mkdir -p "$HOME/.sinain/provisioning"
rm -f "$HOME/.sinain/provisioning/"*.status 2>/dev/null || true

# Import the user's login-shell environment. GUI apps inherit launchd's bare
# env, but agent CLIs depend on vars exported in shell profiles — e.g. a
# claude apiKeyHelper that reads VAULT_ADDR works in the user's terminal but
# 401s under Sinain without this (issue #144). Same approach as VS Code's
# shell-env resolution: run an interactive login shell, print env, import
# vars we don't already have. perl alarm = hard 10s cap so a hung .zshrc
# can't block backend startup.
USER_SHELL="${SHELL:-/bin/zsh}"
SHELL_ENV="$(perl -e '$p=fork; if(!$p){exec @ARGV or exit 127} $SIG{ALRM}=sub{kill 9,$p; exit 1}; alarm 10; waitpid $p,0; exit $?>>8' "$USER_SHELL" -ilc 'command env' 2>/dev/null </dev/null || true)"
if [ -n "$SHELL_ENV" ]; then
  IMPORTED=0
  SHELL_PATH=""
  while IFS= read -r line; do
    case "$line" in *=*) ;; *) continue ;; esac   # skip multi-line value spillover
    k="${line%%=*}"
    case "$k" in ''|*[!A-Za-z0-9_]*) continue ;; esac
    if [ "$k" = "PATH" ]; then SHELL_PATH="${line#*=}"; continue; fi
    case "$k" in HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|SHLVL|TMPDIR|_|TERM|XPC_FLAGS|XPC_SERVICE_NAME) continue ;; esac
    printenv "$k" >/dev/null 2>&1 && continue     # never clobber launchd/our own vars
    export "$k=${line#*=}"
    IMPORTED=$((IMPORTED + 1))
  done <<< "$SHELL_ENV"
  # Shell PATH goes last so bundle + launchd entries keep precedence;
  # it picks up nvm/asdf/custom install dirs the hardcoded list misses.
  [ -n "$SHELL_PATH" ] && export PATH="$PATH:$SHELL_PATH"
  echo "[launch] imported $IMPORTED env vars from login shell ($USER_SHELL)"
else
  echo "[launch] ⚠ could not read login-shell env — agent CLIs may miss profile vars (auth helpers etc.)"
fi

# Augment PATH: bundled node first, then where user CLIs (claude/codex/…)
# typically live — the app's launchd PATH is just /usr/bin:/bin and wouldn't
# find them, leaving the agent roster empty.
export PATH="$RES/node/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/.deno/bin:$PATH"

# sinain-core resolves the sck-capture binary from ~/.sinain/sck-capture first.
mkdir -p "$HOME/.sinain/sck-capture" "$HOME/.sinain/capture" "$HOME/.openclaw/workspace"
ln -sf "$RES/sck-capture/sck-capture" "$HOME/.sinain/sck-capture/sck-capture"

# Load user config from ~/.sinain/.env (written by the first-run wizard).
ENV_FILE="$HOME/.sinain/.env"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

export NODE_ENV=production
export SINAIN_CORE_URL="http://localhost:${PORT:-9500}"
export SINAIN_WORKSPACE="${SINAIN_WORKSPACE:-$HOME/.openclaw/workspace}"
export SINAIN_MEMORY_DIR="${SINAIN_MEMORY_DIR:-$HOME/.sinain/memory}"
export TRANSFORMERS_CACHE="${TRANSFORMERS_CACHE:-$HOME/.sinain/models/embedding}"
# Pin the bare agent's roster file to user home (the bundle dir is read-only in
# the signed .app; run.sh seeds it from the bundled agents.example.json).
export AGENTS_CONFIG_PATH="$HOME/.sinain/agents.json"

# Pick a python3 that has the full dep set (numpy + Quartz/pyobjc). A machine
# may have several python3 installs and only one carries them. This one drives
# BOTH sense_client AND sinain-core's knowledge scripts (page_renderer,
# distillers) via SINAIN_PYTHON — core defaults to bare "python3" otherwise,
# which may resolve to a dep-less interpreter and silently fail page rendering.
PROVISIONED_PY="$HOME/.sinain/python/bin/python3"
SENSE_PY=""
for _py in "${SINAIN_PYTHON:-}" \
           "$PROVISIONED_PY" \
           /Library/Frameworks/Python.framework/Versions/Current/bin/python3 \
           /opt/homebrew/bin/python3 /usr/local/bin/python3 \
           "$(command -v python3 || true)" \
           /Library/Frameworks/Python.framework/Versions/3.*/bin/python3; do
  [ -n "${_py:-}" ] && [ -x "$_py" ] || continue
  if "$_py" -c "import numpy, Quartz" >/dev/null 2>&1; then SENSE_PY="$_py"; break; fi
done
# Nothing usable on this Mac → provision a self-contained Python (download a
# relocatable CPython + pip-install the deps). One-time, ~2 min. This is what
# lets the DMG main path work without any pre-existing Python on the user's Mac.
if [ -z "$SENSE_PY" ] && [ -x "$HERE/provision-python.sh" ]; then
  echo "[launch] no Python with deps found — provisioning a self-contained one (one-time, ~2 min)…"
  if bash "$HERE/provision-python.sh" "$HOME/.sinain/python"; then
    SENSE_PY="$PROVISIONED_PY"
  fi
fi
if [ -n "$SENSE_PY" ]; then
  # Brand our Python helpers so they show as sinain-* (not bare "Python") in
  # Activity Monitor / ps — macOS names a process from its executable's
  # basename, so we exec the one interpreter through sinain-named symlinks.
  SINAIN_BIN="$HOME/.sinain/bin"
  mkdir -p "$SINAIN_BIN"
  ln -sf "$SENSE_PY" "$SINAIN_BIN/sinain-sense"      # sense_client
  ln -sf "$SENSE_PY" "$SINAIN_BIN/sinain-knowledge"  # core's knowledge scripts
  ln -sf "$SENSE_PY" "$SINAIN_BIN/sinain-chat"       # chat sidecar
  export SINAIN_PYTHON="$SINAIN_BIN/sinain-knowledge"
  export SINAIN_CHAT_PYTHON="$SINAIN_BIN/sinain-chat"
  export SINAIN_SENSE_PYTHON="$SINAIN_BIN/sinain-sense"
  echo "[launch] python (sense + knowledge): $SENSE_PY (as sinain-sense / sinain-knowledge)"
else
  echo "[launch] python provisioning failed — sense_client + knowledge pages degraded"
fi

# ── Over-install refresh ──────────────────────────────────────────────────────
# Installing a newer DMG over an existing install replaces everything inside
# the .app (backend runs from Resources, always fresh), but provisioned state
# in ~/.sinain was set up once by the OLD version. Compare the bundle's build
# stamp with the recorded one and refresh version-sensitive pieces — python
# deps may have changed between releases. User config (.env, agents.json,
# models) is never touched.
BUILD_ID_FILE="$RES/BUILD_ID"
BUILD_STAMP="$HOME/.sinain/installed-build"
if [ -f "$BUILD_ID_FILE" ]; then
  NEW_BUILD="$(cat "$BUILD_ID_FILE")"
  OLD_BUILD="$(cat "$BUILD_STAMP" 2>/dev/null || true)"
  if [ "$NEW_BUILD" != "$OLD_BUILD" ]; then
    echo "[launch] bundle updated (${OLD_BUILD:-fresh install} → $NEW_BUILD) — refreshing provisioned deps"
    if [ -x "$PROVISIONED_PY" ] && [ -f "$RES/sense_client/requirements.txt" ]; then
      "$PROVISIONED_PY" -m pip install -q --upgrade -r "$RES/sense_client/requirements.txt" \
        && echo "[launch] python deps refreshed" \
        || echo "[launch] python dep refresh failed — continuing with existing env"
    fi
    echo "$NEW_BUILD" > "$BUILD_STAMP"
  fi
fi

# ── Local-mode model provisioning (tier-gated, background) ───────────────────
# Runs in the background so core/overlay stay responsive; local features come
# online when downloads finish. All idempotent + resumable. T1 (local STT) →
# whisper model; T2 (full local) → whisper + Ollama SLMs.
PROV_PIDS=""
if [ "${TRANSCRIPTION_BACKEND:-}" = "local" ]; then
  [ -x "$RES/whisper/whisper-cli" ] && export LOCAL_WHISPER_BIN="${LOCAL_WHISPER_BIN:-$RES/whisper/whisper-cli}"
  if [ -x "$HERE/provision-whisper.sh" ]; then
    echo "[launch] local transcription — ensuring whisper model (background)…"
    bash "$HERE/provision-whisper.sh" "$HOME/.sinain/models/whisper" &
    PROV_PIDS="$PROV_PIDS $!"
  fi
fi
if [ "${SINAIN_LOCAL_MODE:-}" = "true" ] && [ -x "$HERE/provision-ollama.sh" ]; then
  echo "[launch] full-local mode — ensuring Ollama SLMs (background)…"
  bash "$HERE/provision-ollama.sh" &
  PROV_PIDS="$PROV_PIDS $!"
fi

# Initialise the knowledge graph on first run so entity detection is live from
# the start (otherwise it stays disabled until the first distillation writes a db).
mkdir -p "$SINAIN_MEMORY_DIR"
KG_DB="$SINAIN_MEMORY_DIR/knowledge-graph.db"
KG_PY="${SINAIN_PYTHON:-python3}"
if [ ! -f "$KG_DB" ] && [ -d "$RES/sinain-memory" ]; then
  PYTHONPATH="$RES/sinain-memory" "$KG_PY" -c "from triplestore import TripleStore; TripleStore('$KG_DB')" 2>/dev/null \
    && echo "[launch] initialised knowledge graph → $KG_DB"
fi

# Resolve the MCP config (template uses ../relative paths that break in a
# bundle) into ~/.sinain with absolute paths, and point run.sh at it.
RESOLVED_MCP="$HOME/.sinain/mcp-config.json"
cat > "$RESOLVED_MCP" <<JSON
{
  "mcpServers": {
    "sinain": {
      "command": "$RES/sinain-core/node_modules/.bin/tsx",
      "args": ["$RES/sinain-mcp-server/index.ts"],
      "env": {
        "SINAIN_CORE_URL": "$SINAIN_CORE_URL",
        "SINAIN_WORKSPACE": "$SINAIN_WORKSPACE"
      }
    }
  }
}
JSON
export MCP_CONFIG="$RESOLVED_MCP"

# ── Supervise: start core, then bare agent + sense_client; kill all on signal ─
CORE_PID=""; AGENT_PID=""; SENSE_PID=""
cleanup() {
  [ -n "$SENSE_PID" ] && kill "$SENSE_PID" 2>/dev/null
  [ -n "$AGENT_PID" ] && kill "$AGENT_PID" 2>/dev/null
  [ -n "$CORE_PID" ]  && kill "$CORE_PID"  2>/dev/null
  # Stop any in-flight model downloads (resumable on next launch).
  [ -n "${PROV_PIDS:-}" ] && kill $PROV_PIDS 2>/dev/null
  # run.sh's own TERM trap stops the OpenRouter proxy it may have started.
  exit 0
}
trap cleanup TERM INT

( cd "$CORE" && exec "$NODE" dist/index.js ) &
CORE_PID=$!

# Wait for core health before starting dependents (they exit if core is down).
for _i in $(seq 1 40); do
  curl -sf "$SINAIN_CORE_URL/health" >/dev/null 2>&1 && break
  sleep 1
done

# Start the bare agent. CWD = bundled sinain-agent-runner so settings.json's relative
# ./hooks/approve-tool.sh resolves.
if [ -f "$AGENT_DIR/run.sh" ]; then
  ( cd "$AGENT_DIR" && exec bash run.sh ) &
  AGENT_PID=$!
fi

# Start sense_client (screen capture → OCR → POST /sense), reusing the python3
# picked above (SENSE_PY). CWD = Resources so `-m sense_client` imports it.
if [ -n "$SENSE_PY" ] && [ -d "$RES/sense_client" ]; then
  ( cd "$RES" && exec "${SINAIN_SENSE_PYTHON:-$SENSE_PY}" -m sense_client ) &
  SENSE_PID=$!
  echo "[launch] sense_client started (${SINAIN_SENSE_PYTHON:-$SENSE_PY})"
else
  echo "[launch] sense_client skipped — no full-dep python3"
fi

wait "$CORE_PID"
LAUNCH
chmod +x "$RES/scripts/launch-backend.sh"
for _ps in provision-python.sh provision-whisper.sh provision-ollama.sh; do
  cp "$REPO/tools/dmg/$_ps" "$RES/scripts/$_ps"
  chmod +x "$RES/scripts/$_ps"
done

# stop.sh — canonical full-stack teardown the overlay runs on "Quit Sinain"
# (AppDelegate BackendLauncher.stop finds it at Resources/scripts/stop.sh).
cp "$REPO/stop.sh" "$RES/scripts/stop.sh"
chmod +x "$RES/scripts/stop.sh"

# Build stamp — launch-backend.sh compares this against ~/.sinain/installed-build
# to detect a DMG installed over an older version and refresh provisioned deps.
_git_sha="$(git -C "$REPO" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
echo "${_git_sha}-$(date -u +%Y%m%d%H%M%S)" > "$RES/BUILD_ID"
echo "    build stamp: $(cat "$RES/BUILD_ID")"

# DMG release version (CI passes SINAIN_DMG_VERSION=macos-vX.Y.Z) — the
# overlay's in-app update check reads Resources/DMG_VERSION and compares it
# against the latest macos-v* GitHub release. Local builds may omit it.
if [ -n "${SINAIN_DMG_VERSION:-}" ]; then
  echo "${SINAIN_DMG_VERSION#macos-v}" > "$RES/DMG_VERSION"
  echo "    dmg version: $(cat "$RES/DMG_VERSION")"
fi

bold "✓ Staged backend → $RES"
du -sh "$RES" 2>/dev/null | awk '{print "  size: "$1}'
