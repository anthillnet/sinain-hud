#!/usr/bin/env bash
set -euo pipefail

# ── SinainHUD — Launch with Local Whisper Transcription ───────────────────────
# Thin wrapper: validates that whisper-cli + model are present, exports env,
# then delegates to start.sh. Run ./setup-local-stt.sh first for installation.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

BOLD='\033[1m'
RED='\033[0;31m'
RESET='\033[0m'

fail() { echo -e "${BOLD}[local]${RESET} ${RED}✗${RESET} $*"; exit 1; }
log()  { echo -e "${BOLD}[local]${RESET} $*"; }

# Source .env (same file sinain-core reads) to pick up LOCAL_VISION_* etc.
for _env_file in "$SCRIPT_DIR/.env" "$HOME/.sinain/.env"; do
  if [ -f "$_env_file" ]; then
    while IFS='=' read -r _k _v; do
      [[ -z "$_k" || "$_k" =~ ^[[:space:]]*# ]] && continue
      _k=$(echo "$_k" | xargs)
      _v=$(echo "$_v" | xargs)
      _v="${_v%%#*}"
      _v=$(echo "$_v" | xargs)
      [[ -z "$_v" ]] && continue
      if [ -z "${!_k+x}" ]; then export "$_k=$_v"; fi
    done < "$_env_file"
  fi
done

MODEL_DIR="$HOME/models"
MODEL_NAME="ggml-large-v3-turbo.bin"
MODEL_PATH="${LOCAL_WHISPER_MODEL:-$MODEL_DIR/$MODEL_NAME}"
MODEL_PATH="${MODEL_PATH/#\~/$HOME}"
WHISPER_BIN="${LOCAL_WHISPER_BIN:-whisper-cli}"

# ── Preflight: whisper-cli must be installed ─────────────────────────────────
if ! command -v "$WHISPER_BIN" >/dev/null 2>&1; then
  fail "whisper-cli not found. Run ${BOLD}./setup-local-stt.sh${RESET} first."
fi

# ── Preflight: model must exist ──────────────────────────────────────────────
if [ ! -f "$MODEL_PATH" ]; then
  fail "Model not found at $MODEL_PATH. Run ${BOLD}./setup-local-stt.sh${RESET} first."
fi

# ── Export env and delegate to start.sh ──────────────────────────────────────
export TRANSCRIPTION_BACKEND=local
export LOCAL_WHISPER_MODEL="$MODEL_PATH"
export LOCAL_WHISPER_BIN="$WHISPER_BIN"

echo ""
log "Starting SinainHUD with local transcription..."
log "  backend:  whisper-cpp"
log "  model:    $MODEL_PATH"
log "  bin:      $LOCAL_WHISPER_BIN"

# Local vision check
if [ "${LOCAL_VISION_ENABLED:-}" = "true" ]; then
  VISION_MODEL="${LOCAL_VISION_MODEL:-llava}"
  if command -v ollama &>/dev/null; then
    if curl -sf http://localhost:11434/api/tags &>/dev/null; then
      log "  vision:   Ollama ($VISION_MODEL) — local"
    else
      log "  vision:   Ollama not running — will try auto-start"
    fi
  else
    log "  vision:   Ollama not installed — disabled"
  fi
else
  log "  vision:   cloud (OpenRouter)"
fi

# Agent config (the agent process connects separately via run.sh)
AGENT="${SINAIN_AGENT:-}"
TRANSPORT="${ESCALATION_TRANSPORT:-auto}"
if [ -n "$AGENT" ]; then
  log "  agent:    $AGENT (transport=$TRANSPORT) — start with: sinain-agent/run.sh"
else
  log "  agent:    not configured (set SINAIN_AGENT in .env)"
fi
echo ""

exec "$SCRIPT_DIR/start.sh" "$@"
