#!/usr/bin/env bash
set -euo pipefail

# ── SinainHUD — Launch All Services on Windows ────────────────────────────────
# Processes:
#   1. sinain-core (Node.js) — HTTP + WS on :9500
#   2. sense_client (Python) — screen capture pipeline
#   3. overlay (Flutter) — ghost HUD overlay
#
# Usage: ./start-windows.sh [--no-sense] [--no-overlay] [--nanoclaw]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Ensure Flutter is on PATH (Chocolatey installs to C:\tools\flutter)
if [ -d "/c/tools/flutter/bin" ]; then
  export PATH="/c/tools/flutter/bin:$PATH"
fi
NANOCLAW_DIR="${NANOCLAW_DIR:-$HOME/IdeaProjects/nanoclaw}"
PID_FILE="$TEMP/sinain-pids.txt"
PIDS=()
SKIP_SENSE=false
SKIP_OVERLAY=false
USE_NANOCLAW=false

# ── Colors ────────────────────────────────────────────────────────────────────
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
MAGENTA='\033[0;35m'
RED='\033[0;31m'
BLUE='\033[0;34m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ── Parse flags ───────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --no-sense)   SKIP_SENSE=true ;;
    --no-overlay) SKIP_OVERLAY=true ;;
    --nanoclaw)   USE_NANOCLAW=true ;;
    --help|-h)
      echo "Usage: ./start-windows.sh [--no-sense] [--no-overlay] [--nanoclaw]"
      echo "  --no-sense    Skip sense_client (screen capture)"
      echo "  --no-overlay  Skip overlay (Flutter HUD)"
      echo "  --nanoclaw    Start nanoclaw locally"
      exit 0
      ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────
log()  { echo -e "${BOLD}[start]${RESET} $*"; }
ok()   { echo -e "${BOLD}[start]${RESET} ${GREEN}✓${RESET} $*"; }
warn() { echo -e "${BOLD}[start]${RESET} ${YELLOW}⚠${RESET} $*"; }
fail() { echo -e "${BOLD}[start]${RESET} ${RED}✗${RESET} $*"; exit 1; }

# ── Resolve python command ────────────────────────────────────────────────────
PYTHON_CMD=""
if command -v python >/dev/null 2>&1; then
  PYTHON_CMD="python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_CMD="python3"
fi

# ── Kill stale processes from previous runs ───────────────────────────────────
kill_stale() {
  local killed=false

  # Kill previous sinain-core processes
  if taskkill //F //FI "WINDOWTITLE eq sinain-core*" >/dev/null 2>&1; then
    killed=true
  fi

  # Kill orphaned overlay processes
  if taskkill //F //IM sinain_hud.exe >/dev/null 2>&1; then
    killed=true
  fi

  # Kill by image name patterns (tsx, node running sinain-core)
  # Use PID file from previous run
  if [ -f "$PID_FILE" ]; then
    while IFS='=' read -r name pid; do
      if [ -n "$pid" ]; then
        taskkill //F //PID "$pid" >/dev/null 2>&1 && killed=true || true
      fi
    done < "$PID_FILE"
    rm -f "$PID_FILE"
  fi

  # Kill anything on port 9500
  local pid
  pid=$(netstat -ano 2>/dev/null | grep ":9500.*LISTEN" | awk '{print $NF}' | head -1 || true)
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    taskkill //F //PID "$pid" >/dev/null 2>&1 && killed=true || true
  fi

  if $USE_NANOCLAW; then
    pid=$(netstat -ano 2>/dev/null | grep ":18789.*LISTEN" | awk '{print $NF}' | head -1 || true)
    if [ -n "$pid" ] && [ "$pid" != "0" ]; then
      taskkill //F //PID "$pid" >/dev/null 2>&1 && killed=true || true
    fi
  fi

  if $killed; then
    sleep 1
    warn "killed stale processes from previous run"
  fi
}

# ── Cleanup on exit ───────────────────────────────────────────────────────────
CLEANING=false
cleanup() {
  $CLEANING && return
  CLEANING=true
  echo ""
  log "Shutting down services..."

  # Kill tracked pipeline PIDs (sed wrappers)
  if [ ${#PIDS[@]} -gt 0 ]; then
    for pid in "${PIDS[@]}"; do
      taskkill //F //PID "$pid" >/dev/null 2>&1 || true
    done
  fi

  # Kill actual child processes by name — pipeline PIDs are sed wrappers,
  # not the real node/python/overlay processes, so we must kill by image name.
  taskkill //F //IM sinain_hud.exe >/dev/null 2>&1 || true

  # Kill sinain-core by port
  local pid
  pid=$(netstat -ano 2>/dev/null | grep ":9500.*LISTEN" | awk '{print $NF}' | head -1 || true)
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    taskkill //F //PID "$pid" >/dev/null 2>&1 || true
  fi

  # Kill nanoclaw by port if started
  if $USE_NANOCLAW; then
    pid=$(netstat -ano 2>/dev/null | grep ":18789.*LISTEN" | awk '{print $NF}' | head -1 || true)
    if [ -n "$pid" ] && [ "$pid" != "0" ]; then
      taskkill //F //PID "$pid" >/dev/null 2>&1 || true
    fi
  fi

  # Kill sense_client python processes (match the module invocation)
  tasklist 2>/dev/null | grep -i "python" | awk '{print $2}' | while read ppid; do
    wmic process where "ProcessId=$ppid" get CommandLine 2>/dev/null | grep -q "sense_client" && \
      taskkill //F //PID "$ppid" >/dev/null 2>&1 || true
  done

  rm -f "$PID_FILE"
  log "All services stopped."
}
trap cleanup EXIT INT TERM

# ── 0. Kill stale processes ──────────────────────────────────────────────────
kill_stale

# ── 1. Preflight checks ──────────────────────────────────────────────────────
log "Preflight checks..."

command -v node >/dev/null 2>&1 || fail "node not found — install Node.js"
ok "node $(node --version)"

if [ -n "$PYTHON_CMD" ]; then
  ok "$PYTHON_CMD $($PYTHON_CMD --version 2>&1 | awk '{print $2}')"
else
  warn "python not found — sense_client will be skipped"
  SKIP_SENSE=true
fi

if command -v flutter >/dev/null 2>&1; then
  ok "flutter $(flutter --version 2>&1 | head -1 | awk '{print $2}')"
else
  warn "flutter not found — overlay will be skipped"
  SKIP_OVERLAY=true
fi

# Check sinain-core/node_modules
if [ ! -d "$SCRIPT_DIR/sinain-core/node_modules" ]; then
  warn "sinain-core/node_modules missing"
  log "Running npm install in sinain-core/..."
  (cd "$SCRIPT_DIR/sinain-core" && npm install)
  ok "sinain-core dependencies installed"
else
  ok "sinain-core/node_modules present"
fi

# Check nanoclaw
if $USE_NANOCLAW; then
  if [ ! -d "$NANOCLAW_DIR" ]; then
    fail "nanoclaw not found at $NANOCLAW_DIR — set NANOCLAW_DIR env var"
  fi
  ok "nanoclaw dir: $NANOCLAW_DIR"
fi

# Check ports (Windows: use netstat)
check_port() {
  local port=$1
  netstat -ano 2>/dev/null | grep -q ":${port}.*LISTEN"
}

if $USE_NANOCLAW && check_port 18789; then
  fail "Port 18789 still in use after cleanup"
fi
if check_port 9500; then
  fail "Port 9500 still in use after cleanup"
fi
ok "port 9500 free"

# Ensure data directories
APPDATA_DIR="${APPDATA:-$HOME/AppData/Roaming}"
mkdir -p "$APPDATA_DIR/sinain/capture"
mkdir -p "$APPDATA_DIR/sinain/feedback"
mkdir -p "$APPDATA_DIR/sinain/traces"
mkdir -p "$APPDATA_DIR/sinain/logs"
mkdir -p "$APPDATA_DIR/openclaw/workspace"
LOG_DIR="$APPDATA_DIR/sinain/logs"

echo ""

# ── 2. Build win-audio-capture if needed ─────────────────────────────────────
WIN_AUDIO_DIR="$SCRIPT_DIR/tools/win-audio-capture"
if [ -f "$WIN_AUDIO_DIR/main.cpp" ]; then
  WIN_AUDIO_EXE=$(find "$WIN_AUDIO_DIR/build" -name "win-audio-capture.exe" 2>/dev/null | head -1)
  if [ -z "$WIN_AUDIO_EXE" ] || [ "$WIN_AUDIO_DIR/main.cpp" -nt "$WIN_AUDIO_EXE" ]; then
    if command -v cmake >/dev/null 2>&1; then
      log "Building win-audio-capture..."
      mkdir -p "$WIN_AUDIO_DIR/build"
      if (cd "$WIN_AUDIO_DIR/build" && cmake .. 2>&1 | tail -3 && cmake --build . --config Release 2>&1 | tail -5); then
        ok "win-audio-capture built"
      else
        warn "win-audio-capture build failed — audio capture will not work"
        warn "Run ./setup-windows.sh to install build tools"
      fi
    else
      warn "cmake not found — skipping win-audio-capture build"
      warn "Audio capture will not work. Run ./setup-windows.sh first."
    fi
  else
    ok "win-audio-capture binary up to date"
  fi
fi

# ── 3. Start nanoclaw (optional) ─────────────────────────────────────────────
NANOCLAW_PID=""
if $USE_NANOCLAW; then
  log "Starting nanoclaw..."
  (cd "$NANOCLAW_DIR" && npm run dev 2>&1) | tee -a "$LOG_DIR/nanoclaw.log" | sed -u "s/^/$(printf "${BLUE}[nanoclaw]${RESET} ")/" &
  NANOCLAW_PID=$!
  PIDS+=("$NANOCLAW_PID")

  NANOCLAW_OK=false
  for i in $(seq 1 15); do
    if check_port 18789; then
      NANOCLAW_OK=true
      break
    fi
    sleep 1
  done
  if $NANOCLAW_OK; then
    ok "nanoclaw listening on :18789"
  else
    fail "nanoclaw did not start after 15s"
  fi
else
  warn "nanoclaw skipped (use --nanoclaw to start locally)"
fi

# ── 4. Start sinain-core ─────────────────────────────────────────────────────
log "Starting sinain-core..."
(cd "$SCRIPT_DIR/sinain-core" && npm run dev 2>&1) | tee -a "$LOG_DIR/core.log" | sed -u "s/^/$(printf "${CYAN}[core]${RESET}    ")/" &
CORE_PID=$!
PIDS+=("$CORE_PID")

# ── 5. Health-check sinain-core ──────────────────────────────────────────────
CORE_OK=false
for i in $(seq 1 20); do
  if curl -sf http://localhost:9500/health >/dev/null 2>&1; then
    CORE_OK=true
    break
  fi
  sleep 1
done
if $CORE_OK; then
  ok "sinain-core healthy on :9500"
else
  fail "sinain-core did not become healthy after 20s"
fi

# ── 6. Start sense_client ────────────────────────────────────────────────────
SENSE_PID=""
if $SKIP_SENSE; then
  warn "sense_client skipped"
else
  log "Starting sense_client..."
  (cd "$SCRIPT_DIR" && $PYTHON_CMD -m sense_client 2>&1) | tee -a "$LOG_DIR/sense.log" | sed -u "s/^/$(printf "${YELLOW}[sense]${RESET}   ")/" &
  SENSE_PID=$!
  PIDS+=("$SENSE_PID")
  sleep 2
  if ! kill -0 "$SENSE_PID" 2>/dev/null; then
    warn "sense_client exited early — check $LOG_DIR/sense.log"
    SENSE_PID=""
  else
    # PID exists, but verify sinain-core actually received sense events
    SENSE_HEALTHY=false
    for i in $(seq 1 13); do
      SENSE_EVENTS=$(curl -sf http://localhost:9500/health 2>/dev/null \
        | $PYTHON_CMD -c "import sys,json; print(json.load(sys.stdin).get('senseEvents',0))" 2>/dev/null || echo "0")
      if [ "$SENSE_EVENTS" -gt 0 ] 2>/dev/null; then
        SENSE_HEALTHY=true
        break
      fi
      # Re-check that process hasn't died while waiting
      if ! kill -0 "$SENSE_PID" 2>/dev/null; then
        warn "sense_client crashed during init — check $LOG_DIR/sense.log"
        SENSE_PID=""
        break
      fi
      sleep 1
    done
    if [ -n "$SENSE_PID" ]; then
      if $SENSE_HEALTHY; then
        ok "sense_client running (pid:$SENSE_PID, events:$SENSE_EVENTS)"
      else
        warn "sense_client running (pid:$SENSE_PID) but 0 events after 15s — may be frozen, check $LOG_DIR/sense.log"
      fi
    fi
  fi
fi

# ── 7. Start overlay ─────────────────────────────────────────────────────────
OVERLAY_PID=""
if $SKIP_OVERLAY; then
  warn "overlay skipped"
else
  # Build overlay if needed, then launch the exe directly
  OVERLAY_EXE="$SCRIPT_DIR/sinain-hud-enterprise/build/windows/x64/runner/Release/sinain_hud.exe"
  if [ ! -f "$OVERLAY_EXE" ]; then
    log "Building overlay (first time)..."
    (cd "$SCRIPT_DIR/sinain-hud-enterprise" && flutter build windows 2>&1) | sed -u "s/^/$(printf "${MAGENTA}[overlay]${RESET} ")/"
    if [ ! -f "$OVERLAY_EXE" ]; then
      warn "overlay build failed — skipping"
      OVERLAY_EXE=""
    else
      ok "overlay built"
    fi
  fi
  if [ -n "$OVERLAY_EXE" ]; then
    log "Starting overlay..."
    "$OVERLAY_EXE" 2>&1 | tee -a "$LOG_DIR/overlay.log" &
    OVERLAY_PID=$!
    PIDS+=("$OVERLAY_PID")
    sleep 2
    if kill -0 "$OVERLAY_PID" 2>/dev/null; then
      ok "overlay running (pid:$OVERLAY_PID)"
    else
      warn "overlay exited early — check logs above"
      OVERLAY_PID=""
    fi
  fi
fi

# ── 8. Write PID file ────────────────────────────────────────────────────────
{
  [ -n "$NANOCLAW_PID" ] && echo "nanoclaw=$NANOCLAW_PID"
  echo "core=$CORE_PID"
  [ -n "$SENSE_PID" ]   && echo "sense=$SENSE_PID"
  [ -n "$OVERLAY_PID" ] && echo "overlay=$OVERLAY_PID"
} > "$PID_FILE"

# ── 9. Status banner ─────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}── SinainHUD (Windows) ────────────────────${RESET}"

# nanoclaw
if [ -n "$NANOCLAW_PID" ]; then
  echo -e "  ${BLUE}nanoclaw${RESET} :18789  ${GREEN}✓${RESET}  (ws+http)"
else
  echo -e "  ${BLUE}nanoclaw${RESET} ${DIM}—       skipped${RESET}"
fi

# core
echo -e "  ${CYAN}core${RESET}     :9500   ${GREEN}✓${RESET}  (http+ws)"

# sense
if [ -n "$SENSE_PID" ]; then
  echo -e "  ${YELLOW}sense${RESET}    pid:${SENSE_PID}  ${GREEN}✓${RESET}  (running)"
elif $SKIP_SENSE; then
  echo -e "  ${YELLOW}sense${RESET}    ${DIM}—       skipped${RESET}"
else
  echo -e "  ${YELLOW}sense${RESET}    ${RED}✗${RESET}       (failed)"
fi

# overlay
if [ -n "$OVERLAY_PID" ]; then
  echo -e "  ${MAGENTA}overlay${RESET}  pid:${OVERLAY_PID}  ${GREEN}✓${RESET}  (running)"
elif $SKIP_OVERLAY; then
  echo -e "  ${MAGENTA}overlay${RESET}  ${DIM}—       skipped${RESET}"
else
  echo -e "  ${MAGENTA}overlay${RESET}  ${RED}✗${RESET}       (failed)"
fi

echo -e "${BOLD}───────────────────────────────────────────${RESET}"
echo -e "  ${DIM}logs${RESET}     $LOG_DIR/"
echo -e "  Press ${BOLD}Ctrl+C${RESET} to stop all services"
echo -e "${BOLD}───────────────────────────────────────────${RESET}"
echo ""

# ── 10. Wait for all children ─────────────────────────────────────────────────
wait
