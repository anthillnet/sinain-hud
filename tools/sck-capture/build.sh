#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-13.0}"
SCK_CAPTURE_ARCH="${SCK_CAPTURE_ARCH:-$(uname -m)}"
SCK_CAPTURE_TARGET="${SCK_CAPTURE_TARGET:-${SCK_CAPTURE_ARCH}-apple-macos${MACOSX_DEPLOYMENT_TARGET}}"

echo "[sck-capture] compiling main.swift for $SCK_CAPTURE_TARGET..."
swiftc -O -target "$SCK_CAPTURE_TARGET" -o sck-capture main.swift \
  -framework ScreenCaptureKit \
  -framework CoreMedia \
  -framework AVFoundation \
  -framework CoreImage

echo "[sck-capture] built: $SCRIPT_DIR/sck-capture"
