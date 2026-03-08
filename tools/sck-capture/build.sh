#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "[sck-capture] compiling main.swift..."
swiftc -O -o sck-capture main.swift \
  -framework ScreenCaptureKit \
  -framework CoreMedia \
  -framework AVFoundation \
  -framework CoreImage

echo "[sck-capture] built: $SCRIPT_DIR/sck-capture"
