#!/usr/bin/env bash
set -uo pipefail

# ── Download the whisper model for local transcription (T1/T2) ───────────────
# The whisper-cli binary ships in the bundle; only the (~1.5GB) model is
# fetched here, into ~/.sinain/models/whisper/. Resumable. Logs to stdout
# (supervisor → ~/.sinain/logs/backend.log).
#
# Usage: provision-whisper.sh [MODEL_DIR]

MODEL_DIR="${1:-$HOME/.sinain/models/whisper}"
MODEL="ggml-large-v3-turbo.bin"
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL}"
DEST="$MODEL_DIR/$MODEL"
MIN_BYTES=1000000000   # ~1.5GB expected; treat <1GB as incomplete

size_of() { stat -f%z "$1" 2>/dev/null || echo 0; }

if [ -f "$DEST" ] && [ "$(size_of "$DEST")" -gt "$MIN_BYTES" ]; then
  echo "[provision-whisper] model present: $DEST"
  exit 0
fi

mkdir -p "$MODEL_DIR"
echo "[provision-whisper] downloading $MODEL (~1.5GB, resumable)…"
# -C - resumes a partial .part; download to .part then atomically rename.
if curl -fL --retry 5 --retry-delay 2 -C - "$URL" -o "$DEST.part"; then
  if [ "$(size_of "$DEST.part")" -gt "$MIN_BYTES" ]; then
    mv "$DEST.part" "$DEST"
    echo "[provision-whisper] ✓ model ready: $DEST"
    exit 0
  fi
  echo "[provision-whisper] ✗ downloaded file too small — left as $DEST.part for resume"
  exit 1
fi
echo "[provision-whisper] ✗ download failed (will retry next launch; partial kept)"
exit 1
