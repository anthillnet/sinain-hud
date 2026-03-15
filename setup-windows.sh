#!/usr/bin/env bash
set -euo pipefail

# ── SinainHUD — Windows Setup ─────────────────────────────────────────────────
# Installs all prerequisites for running sinain on Windows:
#   1. Verifies Node.js + Python
#   2. Installs sinain-core npm dependencies
#   3. Installs sense_client pip dependencies
#   4. Installs C++ build tools (cmake + MinGW) via Chocolatey if missing
#   5. Builds win-audio-capture.exe
#   6. Installs Flutter if missing (via Chocolatey)
#   7. Creates sinain data directories
#
# Run once before using ./start-windows.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
RESET='\033[0m'

log()  { echo -e "${BOLD}[setup]${RESET} $*"; }
ok()   { echo -e "${BOLD}[setup]${RESET} ${GREEN}✓${RESET} $*"; }
warn() { echo -e "${BOLD}[setup]${RESET} ${YELLOW}⚠${RESET} $*"; }
fail() { echo -e "${BOLD}[setup]${RESET} ${RED}✗${RESET} $*"; exit 1; }
ask()  { read -rp "$(echo -e "${BOLD}[setup]${RESET} $* [Y/n] ")" ans; [[ "${ans:-y}" =~ ^[Yy]$ ]]; }

echo ""
echo -e "${BOLD}── SinainHUD Windows Setup ───────────────${RESET}"
echo ""

# ── 1. Check Node.js ──────────────────────────────────────────────────────────
if command -v node >/dev/null 2>&1; then
  ok "Node.js $(node --version)"
else
  fail "Node.js not found. Install from https://nodejs.org or: choco install nodejs"
fi

# ── 2. Check Python ───────────────────────────────────────────────────────────
PYTHON_CMD=""
if command -v python >/dev/null 2>&1; then
  PYTHON_CMD="python"
  ok "Python $(python --version 2>&1 | awk '{print $2}')"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_CMD="python3"
  ok "Python $(python3 --version 2>&1 | awk '{print $2}')"
else
  warn "Python not found — sense_client will not work"
  warn "Install from https://python.org or: choco install python"
fi

# ── 3. Check Chocolatey (for installing build tools) ──────────────────────────
HAS_CHOCO=false
if command -v choco >/dev/null 2>&1; then
  HAS_CHOCO=true
  ok "Chocolatey found"
else
  warn "Chocolatey not found — will skip automated installs"
  warn "Install from https://chocolatey.org/install"
fi

# ── 4. Install sinain-core dependencies ───────────────────────────────────────
log "Installing sinain-core dependencies..."
if [ ! -d "$SCRIPT_DIR/sinain-core/node_modules" ]; then
  (cd "$SCRIPT_DIR/sinain-core" && npm install)
  ok "sinain-core dependencies installed"
else
  # Check if node_modules is stale
  if [ "$SCRIPT_DIR/sinain-core/package.json" -nt "$SCRIPT_DIR/sinain-core/node_modules/.package-lock.json" ] 2>/dev/null; then
    (cd "$SCRIPT_DIR/sinain-core" && npm install)
    ok "sinain-core dependencies updated"
  else
    ok "sinain-core dependencies up to date"
  fi
fi

# ── 5. Install sense_client Python dependencies ──────────────────────────────
if [ -n "$PYTHON_CMD" ]; then
  log "Installing sense_client Python dependencies..."
  $PYTHON_CMD -m pip install -q -r "$SCRIPT_DIR/sense_client/requirements.txt" 2>&1 | tail -5
  ok "sense_client Python dependencies installed"
fi

# ── 6. Build win-audio-capture ────────────────────────────────────────────────
WIN_AUDIO_DIR="$SCRIPT_DIR/tools/win-audio-capture"
WIN_AUDIO_EXE="$WIN_AUDIO_DIR/build/Release/win-audio-capture.exe"
WIN_AUDIO_EXE_ALT="$WIN_AUDIO_DIR/build/win-audio-capture.exe"

build_audio_capture() {
  local cmake_cmd="$1"
  log "Building win-audio-capture..."
  mkdir -p "$WIN_AUDIO_DIR/build"

  # Try to find a generator that works
  local generator=""
  if command -v cl >/dev/null 2>&1 || [ -n "$(find '/c/Program Files/Microsoft Visual Studio' -name 'cl.exe' 2>/dev/null | head -1)" ]; then
    generator=""  # Let cmake auto-detect MSVC
  elif command -v g++ >/dev/null 2>&1; then
    generator='-G "MinGW Makefiles"'
  elif command -v ninja >/dev/null 2>&1; then
    generator='-G Ninja'
  fi

  (
    cd "$WIN_AUDIO_DIR/build"
    if [ -n "$generator" ]; then
      eval "$cmake_cmd" "$generator" ..
    else
      "$cmake_cmd" ..
    fi
    "$cmake_cmd" --build . --config Release
  )

  if [ -f "$WIN_AUDIO_EXE" ] || [ -f "$WIN_AUDIO_EXE_ALT" ]; then
    ok "win-audio-capture built"
    return 0
  fi

  # Check for other possible output locations
  local found
  found=$(find "$WIN_AUDIO_DIR/build" -name "win-audio-capture.exe" 2>/dev/null | head -1)
  if [ -n "$found" ]; then
    ok "win-audio-capture built at $found"
    return 0
  fi

  return 1
}

# Check if we need to build
NEED_BUILD=false
if [ ! -f "$WIN_AUDIO_EXE" ] && [ ! -f "$WIN_AUDIO_EXE_ALT" ]; then
  # Check any location
  EXISTING=$(find "$WIN_AUDIO_DIR/build" -name "win-audio-capture.exe" 2>/dev/null | head -1)
  if [ -z "$EXISTING" ]; then
    NEED_BUILD=true
  fi
elif [ "$WIN_AUDIO_DIR/main.cpp" -nt "$WIN_AUDIO_EXE" ] 2>/dev/null && \
     [ "$WIN_AUDIO_DIR/main.cpp" -nt "$WIN_AUDIO_EXE_ALT" ] 2>/dev/null; then
  NEED_BUILD=true
fi

if $NEED_BUILD; then
  # Check for cmake
  CMAKE_CMD=""
  if command -v cmake >/dev/null 2>&1; then
    CMAKE_CMD="cmake"
  elif [ -f "/c/Program Files/CMake/bin/cmake.exe" ]; then
    CMAKE_CMD="/c/Program Files/CMake/bin/cmake.exe"
  fi

  if [ -z "$CMAKE_CMD" ]; then
    warn "cmake not found"
    if $HAS_CHOCO && ask "Install cmake via Chocolatey?"; then
      log "Installing cmake..."
      choco install cmake --installargs 'ADD_CMAKE_TO_PATH=System' -y 2>&1 | tail -3
      # Refresh PATH
      export PATH="/c/Program Files/CMake/bin:$PATH"
      CMAKE_CMD="cmake"
      ok "cmake installed"
    else
      warn "Skipping win-audio-capture build (no cmake)"
      warn "Audio capture will not work until you build it manually"
    fi
  fi

  # Check for a C++ compiler
  if [ -n "$CMAKE_CMD" ]; then
    HAS_COMPILER=false
    if command -v cl >/dev/null 2>&1 || command -v g++ >/dev/null 2>&1; then
      HAS_COMPILER=true
    fi

    if ! $HAS_COMPILER; then
      warn "No C++ compiler found (need MSVC or MinGW g++)"
      if $HAS_CHOCO && ask "Install MinGW C++ compiler via Chocolatey?"; then
        log "Installing mingw (this may take a few minutes)..."
        choco install mingw -y 2>&1 | tail -3
        export PATH="/c/ProgramData/mingw64/mingw64/bin:/c/tools/mingw64/bin:$PATH"
        ok "MinGW installed"
        HAS_COMPILER=true
      else
        warn "Skipping win-audio-capture build (no C++ compiler)"
        warn "Install Visual Studio Build Tools or MinGW, then re-run setup"
      fi
    fi

    if $HAS_COMPILER; then
      if ! build_audio_capture "$CMAKE_CMD"; then
        warn "win-audio-capture build failed — audio capture will need manual build"
        warn "Try: cd tools/win-audio-capture/build && cmake .. && cmake --build . --config Release"
      fi
    fi
  fi
else
  ok "win-audio-capture binary up to date"
fi

# ── 7. Check / install Flutter ────────────────────────────────────────────────
if command -v flutter >/dev/null 2>&1; then
  ok "Flutter $(flutter --version 2>&1 | head -1 | awk '{print $2}')"
else
  warn "Flutter not found"
  if $HAS_CHOCO && ask "Install Flutter via Chocolatey? (large download)"; then
    log "Installing Flutter (this will take a while)..."
    choco install flutter -y 2>&1 | tail -5
    ok "Flutter installed — you may need to restart your terminal for PATH"
  else
    warn "Flutter not installed — overlay will not work"
    warn "Install from https://docs.flutter.dev/get-started/install/windows or: choco install flutter"
  fi
fi

# ── 8. Create data directories ────────────────────────────────────────────────
APPDATA_DIR="${APPDATA:-$HOME/AppData/Roaming}"
log "Creating data directories..."
mkdir -p "$APPDATA_DIR/sinain/capture"
mkdir -p "$APPDATA_DIR/sinain/feedback"
mkdir -p "$APPDATA_DIR/sinain/traces"
mkdir -p "$APPDATA_DIR/openclaw/workspace"
ok "Data directories created in $APPDATA_DIR/sinain/"

# ── 9. Flutter pub get for overlay ────────────────────────────────────────────
if command -v flutter >/dev/null 2>&1 && [ -d "$SCRIPT_DIR/sinain-hud-enterprise" ]; then
  log "Installing Flutter dependencies..."
  (cd "$SCRIPT_DIR/sinain-hud-enterprise" && flutter pub get 2>&1) | tail -5
  ok "Flutter dependencies installed"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}── Setup Summary ───────────────────────────${RESET}"
echo -e "  Node.js:           $(node --version 2>/dev/null || echo 'missing')"
echo -e "  Python:            $(python --version 2>&1 | awk '{print $2}' || echo 'missing')"
echo -e "  sinain-core deps:  ${GREEN}✓${RESET}"

AUDIO_STATUS="${RED}✗ not built${RESET}"
if find "$WIN_AUDIO_DIR/build" -name "win-audio-capture.exe" 2>/dev/null | head -1 | grep -q .; then
  AUDIO_STATUS="${GREEN}✓ built${RESET}"
fi
echo -e "  win-audio-capture: $AUDIO_STATUS"

SENSE_STATUS="${RED}✗ missing${RESET}"
if [ -n "$PYTHON_CMD" ] && $PYTHON_CMD -c "import mss" 2>/dev/null; then
  SENSE_STATUS="${GREEN}✓ ready${RESET}"
elif [ -n "$PYTHON_CMD" ]; then
  SENSE_STATUS="${YELLOW}⚠ mss not installed${RESET}"
fi
echo -e "  sense_client:      $SENSE_STATUS"

FLUTTER_STATUS="${RED}✗ not installed${RESET}"
if command -v flutter >/dev/null 2>&1; then
  FLUTTER_STATUS="${GREEN}✓ $(flutter --version 2>&1 | head -1 | awk '{print $2}')${RESET}"
fi
echo -e "  Flutter:           $FLUTTER_STATUS"

echo -e "${BOLD}────────────────────────────────────────────${RESET}"
echo ""
ok "Setup complete. Run ${BOLD}./start-windows.sh${RESET} to launch."
echo ""
