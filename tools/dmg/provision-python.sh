#!/usr/bin/env bash
set -uo pipefail

# ── Provision a self-contained Python for sense_client + knowledge scripts ───
# SEED-001 — makes the DMG self-sufficient: downloads a relocatable CPython
# (astral python-build-standalone, arm64) into ~/.sinain/python and pip-installs
# the scientific deps (numpy/scikit-image/pillow/pyobjc/…). Idempotent. Logs to
# stdout (the supervisor inherits it → ~/.sinain/logs/backend.log).
#
# Usage: provision-python.sh [PYROOT]   (default ~/.sinain/python)

PYROOT="${1:-$HOME/.sinain/python}"
PYBIN="$PYROOT/bin/python3"
DEPS="numpy scikit-image pillow pytesseract requests pyobjc-framework-Quartz pyobjc-framework-Vision"

# Already provisioned and importable?
if [ -x "$PYBIN" ] && "$PYBIN" -c "import numpy, Quartz, skimage, PIL" >/dev/null 2>&1; then
  echo "[provision-python] already provisioned: $PYBIN"
  exit 0
fi

PBS_TAG="20260602"
PYVER="3.12.13"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/cpython-${PYVER}+${PBS_TAG}-aarch64-apple-darwin-install_only.tar.gz"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[provision-python] downloading CPython ${PYVER} (arm64, ~25MB)…"
if ! curl -fSL --retry 3 "$URL" -o "$TMP/py.tar.gz"; then
  echo "[provision-python] ✗ download failed: $URL"; exit 1
fi

echo "[provision-python] extracting → $PYROOT"
tar -xzf "$TMP/py.tar.gz" -C "$TMP"   # install_only layout extracts to $TMP/python
[ -x "$TMP/python/bin/python3" ] || { echo "[provision-python] ✗ unexpected archive layout"; exit 1; }
rm -rf "$PYROOT"; mkdir -p "$(dirname "$PYROOT")"
mv "$TMP/python" "$PYROOT"

echo "[provision-python] installing deps (numpy, scikit-image, pyobjc, …, ~150MB)…"
if ! "$PYBIN" -m pip install --quiet --disable-pip-version-check $DEPS; then
  echo "[provision-python] ✗ pip install failed"; exit 1
fi

if "$PYBIN" -c "import numpy, Quartz, skimage, PIL, requests" >/dev/null 2>&1; then
  echo "[provision-python] ✓ ready: $PYBIN"
  exit 0
fi
echo "[provision-python] ✗ dependency verification failed"
exit 1
