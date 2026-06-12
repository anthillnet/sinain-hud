#!/usr/bin/env bash
set -euo pipefail

# ── Build a self-contained arm64 whisper-cli for bundling (SEED-001) ─────────
# Produces tools/whisper/whisper-cli — a static whisper.cpp binary with embedded
# Metal shaders, linking only system frameworks (Accelerate/Metal/Foundation).
# Used for local transcription (T1/T2). The committed binary is the build output
# of this script; re-run to refresh.

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$REPO/tools/whisper/whisper-cli"
SRC="${WHISPER_SRC:-/tmp/whisper.cpp}"

command -v cmake >/dev/null || { echo "cmake required (brew install cmake)"; exit 1; }

[ -d "$SRC" ] || git clone --depth 1 https://github.com/ggerganov/whisper.cpp "$SRC"
cd "$SRC"
cmake -B build \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON >/dev/null
cmake --build build --config Release -j --target whisper-cli >/dev/null

cp "$SRC/build/bin/whisper-cli" "$OUT"
echo "✓ built $OUT ($(file "$OUT"))"
