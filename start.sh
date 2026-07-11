#!/usr/bin/env bash
set -euo pipefail

# SECURITY: owner-only for everything this script and its child services create
# — backend.log holds OCR/vision/transcript output and must not be world-readable.
umask 077

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
PARANOID_MODE=false
SUPERVISED=false
SUPERVISED_DEV=false

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
    --paranoid)   PARANOID_MODE=true ;;
    --supervised) SUPERVISED=true ;;
    --dev)        SUPERVISED_DEV=true ;;
    --help|-h)
      echo "Usage: ./start.sh [--supervised] [--no-sense] [--no-overlay] [--paranoid]"
      echo "  --supervised  Hand off to sinaind (native supervisor: detached,"
      echo "                restart-with-backoff, health probes, compiled core)"
      echo "  --dev         With --supervised: dev toolchain (tsx watch, flutter run)"
      echo "  --no-sense    Skip sense_client (screen capture)"
      echo "  --no-overlay  Skip overlay (Flutter HUD)"
      echo "  --paranoid    Fully offline mode (Ollama + whisper, zero cloud)"
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

# ── Supervised mode: hand off to sinaind and exit ────────────────────────────
# sinaind owns everything this script does below (stale-kill, launch, pipe→log,
# health checks, cleanup) natively: detached from the terminal, children
# restart with backoff, a live-but-deaf core gets probe-restarted. This bash
# path remains the dev default until sinaind has soaked.
if [ "$SUPERVISED" = true ]; then
  SINAIND_DIR="$SCRIPT_DIR/tools/sinaind"
  if [ ! -f "$SINAIND_DIR/sinaind" ] || [ "$SINAIND_DIR/main.swift" -nt "$SINAIND_DIR/sinaind" ]; then
    log "Building sinaind (supervisor)..."
    (cd "$SINAIND_DIR" && bash build.sh) || fail "sinaind build failed"
  fi
  SINAIND_FLAGS=(--daemon)
  $SUPERVISED_DEV && SINAIND_FLAGS+=(--dev)
  $SKIP_SENSE     && SINAIND_FLAGS+=(--no-sense)
  $SKIP_OVERLAY   && SINAIND_FLAGS+=(--no-overlay)
  $PARANOID_MODE  && SINAIND_FLAGS+=(--paranoid)
  log "Handing off to sinaind ${SINAIND_FLAGS[*]}"
  exec "$SINAIND_DIR/sinaind" "${SINAIND_FLAGS[@]}"
fi
if [ "$SUPERVISED_DEV" = true ]; then
  fail "--dev only applies with --supervised"
fi

# Keep dev/local runs aligned with packaged builds: the overlay's
# "Open Session Log" button opens this file.
LOG_DIR="${SINAIN_LOG_DIR:-$HOME/.sinain/logs}"
LOG_FILE="${SINAIN_SESSION_LOG:-$LOG_DIR/backend.log}"
mkdir -p "$LOG_DIR"
if [ -f "$LOG_FILE" ] && [ "$(wc -c <"$LOG_FILE" 2>/dev/null || echo 0)" -gt 5000000 ]; then
  mv "$LOG_FILE" "$LOG_FILE.1" 2>/dev/null || true
fi
touch "$LOG_FILE"
export SINAIN_SESSION_LOG="$LOG_FILE"
printf '\n# SinainHUD session started %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$LOG_FILE"

pipe_log() {
  local plain_prefix="$1"
  local color_prefix="$2"
  local line
  while IFS= read -r line; do
    printf '%s %s\n' "$plain_prefix" "$line" >> "$LOG_FILE"
    printf '%b %s\n' "$color_prefix" "$line"
  done
}

# ── Paranoid mode: source config + verify prerequisites ──────────────────────
if [ "$PARANOID_MODE" = true ]; then
  if [ -f "$SCRIPT_DIR/.env.paranoid" ]; then
    set -a; source "$SCRIPT_DIR/.env.paranoid"; set +a
    log "${MAGENTA}PARANOID MODE${RESET} — fully offline, zero cloud APIs"
  else
    fail ".env.paranoid not found in $SCRIPT_DIR"
  fi

  # Verify Ollama
  if ! curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
    fail "Ollama not running. Start with: ${BOLD}ollama serve${RESET}"
  fi
  ok "Ollama running"

  # Verify required models
  _ollama_tags=$(curl -sf http://localhost:11434/api/tags)
  _llm="${SINAIN_LOCAL_LLM:-phi4-mini}"
  _vision="${SINAIN_LOCAL_VISION:-qwen2.5vl:7b}"
  for _model in "$_llm" "$_vision"; do
    if echo "$_ollama_tags" | grep -q "\"name\":\"${_model}"; then
      ok "Model $_model available"
    else
      warn "Model '$_model' not found. Pull with: ${BOLD}ollama pull $_model${RESET}"
    fi
  done

  # Verify whisper
  if [ "${TRANSCRIPTION_BACKEND:-}" = "local" ]; then
    _whisper_bin="${LOCAL_WHISPER_BIN:-whisper-cli}"
    if command -v "$_whisper_bin" >/dev/null 2>&1; then
      ok "$_whisper_bin found"
    else
      warn "$_whisper_bin not found. Install: ${BOLD}brew install whisper-cpp${RESET}"
    fi
    _whisper_model="${LOCAL_WHISPER_MODEL/#\~/$HOME}"
    if [ -f "$_whisper_model" ]; then
      ok "Whisper model: $_whisper_model"
    else
      warn "Whisper model not found at $_whisper_model"
      warn "Download from: https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"
    fi
  fi

  echo ""
fi

# ── Kill stale processes from previous runs ──────────────────────────────────
# Wait (bounded) for processes to exit after SIGTERM. kill -9 too early is how
# core mid-distillation got killed mid-RocksDB-write -> KG corruption -> wipe.
wait_gone() {
  local pattern="$1" timeout="${2:-25}" i=0
  while [ "$i" -lt "$timeout" ]; do
    pgrep -f "$pattern" >/dev/null 2>&1 || return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

kill_stale() {
  local killed=false

  # Kill previous overlay instances
  if pkill -f "sinain_hud.app/Contents/MacOS/sinain_hud" 2>/dev/null; then
    killed=true
  fi
  if pkill -f "flutter run -d macos" 2>/dev/null; then
    killed=true
  fi

  # Kill previous sense_client instances (match both python3 and framework Python)
  if pkill -f "python3 -m sense_client" 2>/dev/null; then
    killed=true
  fi
  if pkill -f "Python -m sense_client" 2>/dev/null; then
    killed=true
  fi

  # Kill previous sinain chat sidecar instances
  if pkill -f "sinain-chat-agent/sidecar.py" 2>/dev/null; then
    killed=true
  fi
  if pkill -f "[Pp]ython3* sidecar.py" 2>/dev/null; then
    killed=true
  fi

  # Kill previous sck-capture instances
  if pkill -f "tools/sck-capture/sck-capture" 2>/dev/null; then
    killed=true
  fi

  # Kill previous sinain-core processes
  if pkill -f "tsx.*src/index.ts" 2>/dev/null; then
    killed=true
  fi
  if pkill -f "tsx watch src/index.ts" 2>/dev/null; then
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
    wait_gone "tsx.*src/index.ts" 25 || warn "sinain-core did not exit within 25s — forcing"
    wait_gone "sinain-memory/(knowledge_integrator|reconstruct|session_distiller)" 20 \
      || warn "distillation child did not exit within 20s — forcing"
    pkill -9 -f "sinain_hud.app/Contents/MacOS/sinain_hud" 2>/dev/null || true
    pkill -9 -f "sck-capture" 2>/dev/null || true
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
    local waited=0
    while [ "$waited" -lt 25 ]; do
      local alive=false
      for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then alive=true; break; fi
      done
      $alive || break
      sleep 1
      waited=$((waited + 1))
    done
    for pid in "${PIDS[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    done
  fi

  lsof -i :9500 -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null || true
  pkill -f "tools/sck-capture/sck-capture" 2>/dev/null || true
  pkill -f "python3 -m sense_client" 2>/dev/null || true
  pkill -f "Python -m sense_client" 2>/dev/null || true
  pkill -f "sinain-chat-agent/sidecar.py" 2>/dev/null || true
  pkill -f "[Pp]ython3* sidecar.py" 2>/dev/null || true
  pkill -f "tsx.*src/index.ts" 2>/dev/null || true

  rm -f "$PID_FILE"
  log "All services stopped."
}
trap cleanup EXIT INT TERM

# ── 0. Kill stale processes ────────────────────────────────────────────────
kill_stale

# ── 1. Preflight checks ─────────────────────────────────────────────────────
log "Preflight checks..."
ok "session log: $LOG_FILE"

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

# ── 1b. Build sck-capture if source exists and binary is stale ─────────────
if [ -f "$SCRIPT_DIR/tools/sck-capture/main.swift" ]; then
  if [ ! -f "$SCRIPT_DIR/tools/sck-capture/sck-capture" ] || \
     [ "$SCRIPT_DIR/tools/sck-capture/main.swift" -nt "$SCRIPT_DIR/tools/sck-capture/sck-capture" ]; then
    log "Building sck-capture (unified screen + audio capture)..."
    if (cd "$SCRIPT_DIR/tools/sck-capture" && bash build.sh); then
      ok "sck-capture built"
    else
      warn "sck-capture build failed — audio falls back to ffmpeg/sox, screen to CGDisplayCreateImage"
    fi
  else
    ok "sck-capture binary up to date"
  fi
fi

# ── 1c. Region-SLM model (provisional ROI eyes) — every mode ────────────────
# The two-tier ROI lane uses a small local model for instant "thinking about
# this…" placeholders. It's on by default and needs Ollama + the model present;
# auto-pull it once if missing. Degrades gracefully (eyes still come from the
# main analyzer lane) if Ollama is unavailable.
if [ "${REGION_SLM_ENABLED:-true}" != "false" ]; then
  _slm_model="${REGION_SLM_MODEL:-qwen2.5:3b}"
  _ollama_url="${REGION_SLM_ENDPOINT:-http://localhost:11434}"
  if curl -sf "$_ollama_url/api/tags" >/dev/null 2>&1; then
    if curl -sf "$_ollama_url/api/tags" | grep -q "\"name\":\"${_slm_model}\""; then
      ok "region-SLM model present: $_slm_model"
    elif command -v ollama >/dev/null 2>&1; then
      log "Pulling region-SLM model ${BOLD}$_slm_model${RESET} (one-time, for instant ROI previews)..."
      if ollama pull "$_slm_model" >/dev/null 2>&1; then
        ok "region-SLM model pulled: $_slm_model"
      else
        warn "could not pull $_slm_model — provisional ROI eyes off (main analyzer lane still labels them)"
      fi
    else
      warn "region-SLM model $_slm_model missing and 'ollama' CLI not found — provisional ROI eyes off"
    fi
  else
    warn "Ollama not reachable at $_ollama_url — provisional ROI eyes off (eyes still come from the analyzer lane)"
  fi
fi

# Ensure IPC directory for screen frames
mkdir -p "$HOME/.sinain/capture"

# ── 2. Start sinain-core ──────────────────────────────────────────────────
log "Starting sinain-core..."
(cd "$SCRIPT_DIR/sinain-core" && npm run dev 2>&1) | pipe_log "[core]" "$(printf "${CYAN}[core]${RESET}    ")" &
CORE_PID=$!
PIDS+=("$CORE_PID")

# ── 3. Health-check sinain-core ────────────────────────────────────────────
# Paranoid mode needs longer — local model distillation at startup is slower
HEALTH_TIMEOUT="${SINAIN_HEALTH_TIMEOUT:-15}"
if [ "$PARANOID_MODE" = true ]; then HEALTH_TIMEOUT="${SINAIN_HEALTH_TIMEOUT:-45}"; fi
CORE_OK=false
for i in $(seq 1 $HEALTH_TIMEOUT); do
  if curl -sf http://localhost:9500/health >/dev/null 2>&1; then
    CORE_OK=true
    break
  fi
  sleep 1
done
if $CORE_OK; then
  ok "sinain-core healthy on :9500"
else
  fail "sinain-core did not become healthy after ${HEALTH_TIMEOUT}s"
fi

# ── 3b. Propagate PRIVACY_MODE to sense_client env vars ─────────────────────
# sinain-core loads PRIVACY_MODE via dotenv (not inherited by child processes).
# Read it here so sense_client gets the matching OCR/image privacy levels.
_privacy_mode=""
for _env_file in "$SCRIPT_DIR/sinain-core/.env" "$SCRIPT_DIR/.env"; do
  if [ -f "$_env_file" ]; then
    _val=$(grep -E '^PRIVACY_MODE=' "$_env_file" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '[:space:]' || true)
    if [ -n "$_val" ]; then _privacy_mode="$_val"; break; fi
  fi
done
_privacy_mode="${_privacy_mode:-off}"

# Map preset → sense_client vars (only set if not already in environment)
case "$_privacy_mode" in
  paranoid)
    export PRIVACY_OCR_OPENROUTER="${PRIVACY_OCR_OPENROUTER:-none}"
    export PRIVACY_IMAGES_OPENROUTER="${PRIVACY_IMAGES_OPENROUTER:-none}"
    ;;
  strict)
    export PRIVACY_OCR_OPENROUTER="${PRIVACY_OCR_OPENROUTER:-summary}"
    export PRIVACY_IMAGES_OPENROUTER="${PRIVACY_IMAGES_OPENROUTER:-none}"
    ;;
  standard)
    export PRIVACY_OCR_OPENROUTER="${PRIVACY_OCR_OPENROUTER:-redacted}"
    export PRIVACY_IMAGES_OPENROUTER="${PRIVACY_IMAGES_OPENROUTER:-none}"
    ;;
  *)  # off or unknown: full (unrestricted)
    export PRIVACY_OCR_OPENROUTER="${PRIVACY_OCR_OPENROUTER:-full}"
    export PRIVACY_IMAGES_OPENROUTER="${PRIVACY_IMAGES_OPENROUTER:-full}"
    ;;
esac
log "Privacy: mode=${_privacy_mode} ocr_openrouter=${PRIVACY_OCR_OPENROUTER} images_openrouter=${PRIVACY_IMAGES_OPENROUTER}"

# ── 4. Start sense_client + chat sidecar + overlay in parallel ──────────────
SENSE_PID=""
CHAT_PID=""
OVERLAY_PID=""

if ! $SKIP_SENSE; then
  log "Starting sense_client..."
  (cd "$SCRIPT_DIR" && python3 -m sense_client) 2>&1 | pipe_log "[sense]" "$(printf "${YELLOW}[sense]${RESET}   ")" &
  SENSE_PID=$!
  PIDS+=("$SENSE_PID")
else
  warn "sense_client skipped"
fi

# Built-in sinain chat lane — resident sidecar on :9610 (reads its own
# sinain-chat-agent/.env). Skipped if python3 is unavailable. Idle/proactive
# messages are opt-in inside the sidecar (SINAIN_CHAT_IDLE_ENABLED) — they're
# the dominant token cost; normal thread chat stays on.
if command -v python3 >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/sinain-chat-agent/sidecar.py" ]; then
  # Prefer the sidecar's own .venv (dev); fall back to system python3.
  CHAT_PY="python3"
  [ -x "$SCRIPT_DIR/sinain-chat-agent/.venv/bin/python" ] && CHAT_PY="$SCRIPT_DIR/sinain-chat-agent/.venv/bin/python"
  log "Starting sinain chat sidecar..."
  (cd "$SCRIPT_DIR/sinain-chat-agent" && "$CHAT_PY" sidecar.py) 2>&1 | pipe_log "[chat]" "$(printf "${MAGENTA}[chat]${RESET}    ")" &
  CHAT_PID=$!
  PIDS+=("$CHAT_PID")
else
  warn "sinain chat sidecar skipped (python3 or sidecar.py missing)"
fi

if ! $SKIP_OVERLAY; then
  log "Starting overlay..."
  (cd "$SCRIPT_DIR/overlay" && flutter run -d macos 2>&1) | pipe_log "[overlay]" "$(printf "${MAGENTA}[overlay]${RESET} ")" &
  OVERLAY_PID=$!
  PIDS+=("$OVERLAY_PID")
else
  warn "overlay skipped"
fi

# Brief pause then verify both launched
sleep 1

if [ -n "$SENSE_PID" ]; then
  if kill -0 "$SENSE_PID" 2>/dev/null; then
    ok "sense_client running (pid:$SENSE_PID)"
  else
    warn "sense_client exited early — check logs above"
    SENSE_PID=""
  fi
fi

if [ -n "$CHAT_PID" ]; then
  if kill -0 "$CHAT_PID" 2>/dev/null; then
    ok "sinain chat sidecar running (pid:$CHAT_PID)"
  else
    warn "sinain chat sidecar exited early — check logs above"
    CHAT_PID=""
  fi
fi

if [ -n "$OVERLAY_PID" ]; then
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
  [ -n "$CHAT_PID" ]    && echo "chat=$CHAT_PID"
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
