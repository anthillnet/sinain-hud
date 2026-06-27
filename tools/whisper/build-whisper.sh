#!/usr/bin/env bash
set -euo pipefail

# ── Build self-contained arm64 whisper binaries for bundling (SEED-001) ──────
# Produces tools/whisper/whisper-cli AND tools/whisper/whisper-server — static
# whisper.cpp binaries with embedded Metal shaders, linking only system
# frameworks (Accelerate/Metal/Foundation). Used for local transcription
# (T1/T2): whisper-server keeps the model resident (fast path), whisper-cli is
# the per-chunk fallback. The committed binaries are this script's output;
# re-run to refresh.

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$REPO/tools/whisper/whisper-cli"
OUT_SERVER="$REPO/tools/whisper/whisper-server"
SRC="${WHISPER_SRC:-/tmp/whisper.cpp}"

command -v cmake >/dev/null || { echo "cmake required (brew install cmake)"; exit 1; }

[ -d "$SRC" ] || git clone --depth 1 https://github.com/ggerganov/whisper.cpp "$SRC"
cd "$SRC"
cmake -B build \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=ON \
  -DWHISPER_BUILD_EXAMPLES=ON >/dev/null
cmake --build build --config Release -j --target whisper-cli whisper-server >/dev/null

cp "$SRC/build/bin/whisper-cli" "$OUT"
cp "$SRC/build/bin/whisper-server" "$OUT_SERVER"
echo "✓ built $OUT + $OUT_SERVER"
echo "  $(file "$OUT")"
echo "  $(file "$OUT_SERVER")"
