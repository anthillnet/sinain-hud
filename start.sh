I#!/usr/bin/env bash
set -euo pipefail

# ── SinainHUD — Launch All Services ──────────────────────────────────────────

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

  # Kill previous bridge tsx watch / node child processes
  if pkill -f "tsx watch src/index.ts" 2>/dev/null; then
    killed=true
  fi

  # Kill previous relay
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

  # Kill anything on our ports
  local pid
  pid=$(lsof -i :18791 -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    killed=true
  fi
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
    # Force kill anything that didn't exit gracefully
    pkill -9 -f "sinain_hud.app/Contents/MacOS/sinain_hud" 2>/dev/null || true
    pkill -9 -f "tsx watch src/index.ts" 2>/dev/null || true
    pkill -9 -f "node.*hud-relay.mjs" 2>/dev/null || true
    lsof -i :18791 -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null || true
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

  # Kill the overlay app binary directly (flutter run only kills its wrapper)
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

  # Final sweep — kill anything still on our ports or by name
  lsof -i :18791 -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null || true
  lsof -i :9500 -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null || true
  pkill -f "python3 -m sense_client" 2>/dev/null || true
  pkill -f "tsx watch src/index.ts" 2>/dev/null || true
  pkill -f "node.*hud-relay.mjs" 2>/dev/null || true

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

# Check bridge/node_modules
if [ ! -d "$SCRIPT_DIR/bridge/node_modules" ]; then
  warn "bridge/node_modules missing"
  log "Running npm install in bridge/..."
  (cd "$SCRIPT_DIR/bridge" && npm install)
  ok "bridge dependencies installed"
else
  ok "bridge/node_modules present"
fi

# Check bridge/.env
if [ ! -f "$SCRIPT_DIR/bridge/.env" ]; then
  warn "bridge/.env not found — bridge may use defaults"
else
  ok "bridge/.env present"
fi

# Check ports (after kill_stale, these should be free)
if lsof -i :18791 -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Port 18791 still in use after cleanup"
fi
ok "port 18791 free"

if lsof -i :9500 -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Port 9500 still in use after cleanup"
fi
ok "port 9500 free"

# Ensure sense_client control file is enabled
if [ -f /tmp/sinain-sense-control.json ]; then
  echo '{"enabled":true}' > /tmp/sinain-sense-control.json
fi

echo ""

# ── 2. Start hud-relay ──────────────────────────────────────────────────────
log "Starting hud-relay..."
node "$SCRIPT_DIR/server/hud-relay.mjs" 2>&1 | sed -u "s/^/$(printf "${CYAN}[relay]${RESET}   ")/" &
RELAY_PID=$!
PIDS+=("$RELAY_PID")

# ── 3. Health-check relay ────────────────────────────────────────────────────
RELAY_OK=false
for i in $(seq 1 10); do
  if curl -sf http://localhost:18791/health >/dev/null 2>&1; then
    RELAY_OK=true
    break
  fi
  sleep 1
done
if $RELAY_OK; then
  ok "hud-relay healthy on :18791"
else
  fail "hud-relay did not become healthy after 10s"
fi

# ── 4. Start bridge ─────────────────────────────────────────────────────────
log "Starting bridge..."
(cd "$SCRIPT_DIR/bridge" && npm run dev 2>&1) | sed -u "s/^/$(printf "${GREEN}[bridge]${RESET}  ")/" &
BRIDGE_PID=$!
PIDS+=("$BRIDGE_PID")

# ── 5. Health-check bridge ──────────────────────────────────────────────────
BRIDGE_OK=false
for i in $(seq 1 15); do
  if nc -z localhost 9500 2>/dev/null; then
    BRIDGE_OK=true
    break
  fi
  sleep 1
done
if $BRIDGE_OK; then
  ok "bridge ready on :9500"
else
  fail "bridge did not start on :9500 after 15s"
fi

# ── 6. Start sense_client ───────────────────────────────────────────────────
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

# ── 7. Start overlay ────────────────────────────────────────────────────────
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

# ── 8. Write PID file ───────────────────────────────────────────────────────
{
  echo "relay=$RELAY_PID"
  echo "bridge=$BRIDGE_PID"
  [ -n "$SENSE_PID" ]   && echo "sense=$SENSE_PID"
  [ -n "$OVERLAY_PID" ] && echo "overlay=$OVERLAY_PID"
} > "$PID_FILE"

# ── 9. Status banner ────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}── SinainHUD ──────────────────────────${RESET}"

# relay
echo -e "  ${CYAN}relay${RESET}    :18791  ${GREEN}✓${RESET}  (healthy)"

# bridge
echo -e "  ${GREEN}bridge${RESET}   :9500   ${GREEN}✓${RESET}  (ws ready)"

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

# ── 10. Wait for all children ────────────────────────────────────────────────
wait
