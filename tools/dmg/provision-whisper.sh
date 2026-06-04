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
MIN_BYTES=1000000000     # ~1.5GB expected; treat <1GB as incomplete
TOTAL_BYTES=1624555275   # known size, for progress %

size_of() { stat -f%z "$1" 2>/dev/null || echo 0; }

# Progress status the overlay reads.
PS="$HOME/.sinain/provisioning"
pstatus() { mkdir -p "$PS"; printf '%s|%s|%s\n' "$1" "${2:-}" "${3:-}" > "$PS/whisper.status"; }

if [ -f "$DEST" ] && [ "$(size_of "$DEST")" -gt "$MIN_BYTES" ]; then
  echo "[provision-whisper] model present: $DEST"
  pstatus done 100 "Speech model ready"
  exit 0
fi

mkdir -p "$MODEL_DIR"
echo "[provision-whisper] downloading $MODEL (~1.5GB, resumable)…"
pstatus active 0 "Downloading speech model"
# Background poller: translate the growing .part size into a percentage.
( while [ ! -f "$DEST" ]; do
    s=$(size_of "$DEST.part"); p=$(( s * 100 / TOTAL_BYTES ))
    [ "$p" -gt 99 ] && p=99
    pstatus active "$p" "Downloading speech model"
    sleep 2
  done ) &
POLLER=$!
# -C - resumes a partial .part; download to .part then atomically rename.
if curl -fL --retry 5 --retry-delay 2 -C - "$URL" -o "$DEST.part"; then
  kill "$POLLER" 2>/dev/null
  if [ "$(size_of "$DEST.part")" -gt "$MIN_BYTES" ]; then
    mv "$DEST.part" "$DEST"
    echo "[provision-whisper] ✓ model ready: $DEST"
    pstatus done 100 "Speech model ready"
    exit 0
  fi
  pstatus error "" "Speech model download incomplete"
  echo "[provision-whisper] ✗ downloaded file too small — left as $DEST.part for resume"
  exit 1
fi
kill "$POLLER" 2>/dev/null
pstatus error "" "Speech model download failed"
echo "[provision-whisper] ✗ download failed (will retry next launch; partial kept)"
exit 1
