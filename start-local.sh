#!/usr/bin/env bash
set -euo pipefail

# ── SinainHUD — Launch with Local Whisper Transcription ───────────────────────
# Wrapper around start.sh that enables local whisper-cpp transcription.
# Checks for whisper-cli and model, offers to install if missing.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

log()  { echo -e "${BOLD}[local]${RESET} $*"; }
ok()   { echo -e "${BOLD}[local]${RESET} ${GREEN}✓${RESET} $*"; }
warn() { echo -e "${BOLD}[local]${RESET} ${YELLOW}⚠${RESET} $*"; }
fail() { echo -e "${BOLD}[local]${RESET} ${RED}✗${RESET} $*"; exit 1; }

MODEL_DIR="$HOME/models"
MODEL_NAME="ggml-large-v3-turbo.bin"
MODEL_PATH="${LOCAL_WHISPER_MODEL:-$MODEL_DIR/$MODEL_NAME}"

# ── 1. Check whisper-cli ──────────────────────────────────────────────────────
if ! command -v whisper-cli >/dev/null 2>&1; then
  warn "whisper-cli not found"
  if command -v brew >/dev/null 2>&1; then
    read -rp "Install via Homebrew? [Y/n] " ans
    if [[ "${ans:-y}" =~ ^[Yy]$ ]]; then
      log "Installing whisper-cpp..."
      brew install whisper-cpp
      ok "whisper-cpp installed"
    else
      fail "whisper-cli required for local transcription"
    fi
  else
    fail "whisper-cli not found and brew not available. Install whisper-cpp manually."
  fi
else
  ok "whisper-cli found: $(which whisper-cli)"
fi

# ── 2. Check model ────────────────────────────────────────────────────────────
if [ ! -f "$MODEL_PATH" ]; then
  warn "Model not found at $MODEL_PATH"
  read -rp "Download ggml-large-v3-turbo (~1.5GB)? [Y/n] " ans
  if [[ "${ans:-y}" =~ ^[Yy]$ ]]; then
    mkdir -p "$(dirname "$MODEL_PATH")"
    log "Downloading $MODEL_NAME..."
    curl -L --progress-bar \
      -o "$MODEL_PATH" \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_NAME"
    ok "Model downloaded to $MODEL_PATH"
  else
    fail "Model required. Set LOCAL_WHISPER_MODEL to your .bin/.gguf path."
  fi
else
  ok "Model: $MODEL_PATH ($(du -h "$MODEL_PATH" | awk '{print $1}'))"
fi

# ── 3. Quick smoke test ──────────────────────────────────────────────────────
log "Smoke test..."
TMP_WAV=$(mktemp /tmp/sinain-whisper-test-XXXXXX.wav)
sox -n -r 16000 -c 1 -b 16 "$TMP_WAV" trim 0 1 2>/dev/null || true
if [ -f "$TMP_WAV" ] && whisper-cli -m "$MODEL_PATH" -f "$TMP_WAV" --no-timestamps -l en --print-progress false >/dev/null 2>&1; then
  ok "whisper-cli works"
else
  warn "smoke test failed — whisper may still work with real audio"
fi
rm -f "$TMP_WAV"

# ── 4. Export env and delegate to start.sh ────────────────────────────────────
export TRANSCRIPTION_BACKEND=local
export LOCAL_WHISPER_MODEL="$MODEL_PATH"
export LOCAL_WHISPER_BIN="${LOCAL_WHISPER_BIN:-whisper-cli}"

echo ""
log "Starting SinainHUD with local transcription..."
log "  backend:  whisper-cpp"
log "  model:    $MODEL_PATH"
log "  bin:      $LOCAL_WHISPER_BIN"
echo ""

exec "$SCRIPT_DIR/start.sh" "$@"
