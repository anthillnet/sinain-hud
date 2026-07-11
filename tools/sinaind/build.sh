#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-13.0}"
SINAIND_ARCH="${SINAIND_ARCH:-$(uname -m)}"
SINAIND_TARGET="${SINAIND_TARGET:-${SINAIND_ARCH}-apple-macos${MACOSX_DEPLOYMENT_TARGET}}"

echo "[sinaind] compiling main.swift for $SINAIND_TARGET..."
swiftc -O -target "$SINAIND_TARGET" -o sinaind main.swift

echo "[sinaind] built: $SCRIPT_DIR/sinaind"
