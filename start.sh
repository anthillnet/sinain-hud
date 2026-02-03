#!/usr/bin/env bash
set -euo pipefail

# ── SinainHUD — Launch All Services ──────────────────────────────────────────
# After the sinain-core redesign, only 3 processes:
#   1. sinain-core (Node.js) — HTTP + WS on :9500
#   2. sense_client (Python) — optional
#   3. overlay (Flutter) — optional

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="/tmp/sinain-pids.txt"
PIDS=()
SKIP_SENSE=false
SKIP_OVERLAY=false

# ── Colors ───────────────────────────────────────────────────────────────────
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
MAGENTA='\033[0;35m'
RED='\033[0;31m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ── Parse flags ──────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --no-sense)   SKIP_SENSE=true ;;
    --no-overlay) SKIP_OVERLAY=true ;;
    --help|-h)
      echo "Usage: ./start.sh [--no-sense] [--no-overlay]"
      echo "  --no-sense    Skip sense_client (screen capture)"
      echo "  --no-overlay  Skip overlay (Flutter HUD)"
      exit 0
      ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# ── Helpers ──────────────────────────────────────────────────────────────────
log()  { echo -e "${BOLD}[start]${RESET} $*"; }
ok()   { echo -e "${BOLD}[start]${RESET} ${GREEN}✓${RESET} $*"; }
warn() { echo -e "${BOLD}[start]${RESET} ${YELLOW}⚠${RESET} $*"; }
fail() { echo -e "${BOLD}[start]${RESET} ${RED}✗${RESET} $*"; exit 1; }

# ── Kill stale processes from previous runs ──────────────────────────────────
kill_stale() {
  local killed=false

  # Kill previous overlay instances
  if pkill -f "sinain_hud.app/Contents/MacOS/sinain_hud" 2>/dev/null; then
    killed=true
  fi
  if pkill -f "flutter run -d macos" 2>/dev/null; then
    killed=true
  fi

  # Kill previous sense_client instances
  if pkill -f "python3 -m sense_client" 2>/dev/null; then
    killed=true
  fi

  # Kill previous sinain-core / bridge / relay processes
  if pkill -f "tsx.*src/index.ts" 2>/dev/null; then
    killed=true
  fi
  if pkill -f "tsx watch src/index.ts" 2>/dev/null; then
    killed=true
  fi
  if pkill -f "node.*hud-relay.mjs" 2>/dev/null; then
    killed=true
  fi

  # Kill previous start.sh wrappers (but not ourselves)
  local my_pid=$$
  local stale_pids
  stale_pids=$(pgrep -f "bash.*start\.sh" 2>/dev/null | grep -v "^${my_pid}$" || true)
  if [ -n "$stale_pids" ]; then
    echo "$stale_pids" | xargs kill 2>/dev/null || true
    killed=true
  fi

  # Kill anything on our port (single port now)
  local pid
  pid=$(lsof -i :9500 -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    killed=true
  fi

  # Clean old PID file
  if [ -f "$PID_FILE" ]; then
    while IFS='=' read -r name pid; do
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        killed=true
      fi
    done < "$PID_FILE"
    rm -f "$PID_FILE"
  fi

  if $killed; then
    sleep 2
    pkill -9 -f "sinain_hud.app/Contents/MacOS/sinain_hud" 2>/dev/null || true
    pkill -9 -f "tsx.*src/index.ts" 2>/dev/null || true
    lsof -i :9500 -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null || true
    sleep 1
    warn "killed stale processes from previous run"
  fi
}

# ── Cleanup on exit ─────────────────────────────────────────────────────────
CLEANING=false
cleanup() {
  $CLEANING && return
  CLEANING=true
  echo ""
  log "Shutting down services..."

  pkill -f "sinain_hud.app/Contents/MacOS/sinain_hud" 2>/dev/null || true

  if [ ${#PIDS[@]} -gt 0 ]; then
    for pid in "${PIDS[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        kill -TERM "$pid" 2>/dev/null || true
      fi
    done
    sleep 2
    for pid in "${PIDS[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    done
  fi

  lsof -i :9500 -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null || true
  pkill -f "python3 -m sense_client" 2>/dev/null || true
  pkill -f "tsx.*src/index.ts" 2>/dev/null || true

  rm -f "$PID_FILE"
  log "All services stopped."
}
trap cleanup EXIT INT TERM

# ── 0. Kill stale processes ────────────────────────────────────────────────
kill_stale

# ── 1. Preflight checks ─────────────────────────────────────────────────────
log "Preflight checks..."

command -v node >/dev/null 2>&1    || fail "node not found — install Node.js"
ok "node $(node --version)"

if command -v python3 >/dev/null 2>&1; then
  ok "python3 $(python3 --version 2>&1 | awk '{print $2}')"
else
  warn "python3 not found — sense_client will be skipped"
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

# Check port
if lsof -i :9500 -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Port 9500 still in use after cleanup"
fi
ok "port 9500 free"

echo ""

# ── 2. Start sinain-core ──────────────────────────────────────────────────
log "Starting sinain-core..."
(cd "$SCRIPT_DIR/sinain-core" && npm run dev 2>&1) | sed -u "s/^/$(printf "${CYAN}[core]${RESET}    ")/" &
CORE_PID=$!
PIDS+=("$CORE_PID")

# ── 3. Health-check sinain-core ────────────────────────────────────────────
CORE_OK=false
for i in $(seq 1 15); do
  if curl -sf http://localhost:9500/health >/dev/null 2>&1; then
    CORE_OK=true
    break
  fi
  sleep 1
done
if $CORE_OK; then
  ok "sinain-core healthy on :9500"
else
  fail "sinain-core did not become healthy after 15s"
fi

# ── 4. Start sense_client ───────────────────────────────────────────────────
SENSE_PID=""
if $SKIP_SENSE; then
  warn "sense_client skipped"
else
  log "Starting sense_client..."
  (cd "$SCRIPT_DIR" && python3 -m sense_client) 2>&1 | sed -u "s/^/$(printf "${YELLOW}[sense]${RESET}   ")/" &
  SENSE_PID=$!
  PIDS+=("$SENSE_PID")
  sleep 1
  if kill -0 "$SENSE_PID" 2>/dev/null; then
    ok "sense_client running (pid:$SENSE_PID)"
  else
    warn "sense_client exited early — check logs above"
    SENSE_PID=""
  fi
fi

# ── 5. Start overlay ────────────────────────────────────────────────────────
OVERLAY_PID=""
if $SKIP_OVERLAY; then
  warn "overlay skipped"
else
  log "Starting overlay..."
  (cd "$SCRIPT_DIR/overlay" && flutter run -d macos 2>&1) | sed -u "s/^/$(printf "${MAGENTA}[overlay]${RESET} ")/" &
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

# ── 6. Write PID file ───────────────────────────────────────────────────────
{
  echo "core=$CORE_PID"
  [ -n "$SENSE_PID" ]   && echo "sense=$SENSE_PID"
  [ -n "$OVERLAY_PID" ] && echo "overlay=$OVERLAY_PID"
} > "$PID_FILE"

# ── 7. Status banner ────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}── SinainHUD (sinain-core) ────────────${RESET}"

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

echo -e "${BOLD}───────────────────────────────────────${RESET}"
echo -e "  Press ${BOLD}Ctrl+C${RESET} to stop all services"
echo -e "${BOLD}───────────────────────────────────────${RESET}"
echo ""

# ── 8. Wait for all children ────────────────────────────────────────────────
wait
