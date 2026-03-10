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
echo ""

exec "$SCRIPT_DIR/start.sh" "$@"
