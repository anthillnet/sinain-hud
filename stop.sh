#!/usr/bin/env bash
# ── SinainHUD — Stop All Services ────────────────────────────────────────────
# Canonical, supervisor-independent teardown for the whole stack. Kills every
# process that `start.sh` (dev) or the bundled `launch-backend.sh` (DMG) can
# spawn, plus anything left listening on the core port. Matches by process
# pattern + port so it works no matter who launched the stack — that's what lets
# the overlay's "Quit Sinain" button tear everything down (see AppDelegate
# BackendLauncher.stop), not just itself.
#
# Safe to run repeatedly. Does NOT match its own command line, so it never
# kills itself.
#
#   ./stop.sh            # graceful (SIGTERM), then SIGKILL stragglers
#
# Core is SIGTERMed first (never SIGKILLed outright) so its graceful-shutdown
# hook can flush/distill the session knowledge before exiting.

PORT="${SINAIN_CORE_PORT:-9500}"

# Process patterns covering both dev (tsx) and bundled (node dist/index.js) runs.
# sck-capture is core's child and dies on core's SIGTERM, but we list it too as
# a backstop in case core was killed uncleanly on a previous run.
PATTERNS=(
  "sinain_hud.app/Contents/MacOS/sinain_hud"   # overlay (packaged + dev build)
  "flutter run -d macos"                        # dev overlay wrapper
  "python3 -m sense_client"                     # sense_client (python3)
  "Python -m sense_client"                       # sense_client (framework Python)
  "sense_client/__main__"                        # sense_client (bundled python)
  "sinain-chat-agent/sidecar.py"                 # chat sidecar (dev path)
  "[Pp]ython3* sidecar.py"                       # chat sidecar (bundled)
  "sck-capture"                                   # ScreenCaptureKit binary
  "tsx.*src/index.ts"                            # core (dev: tsx watch)
  "sinain-core/dist/index.js"                    # core (bundled: node dist)
)

term_pass() {
  for pat in "${PATTERNS[@]}"; do
    pkill -TERM -f "$pat" 2>/dev/null || true
  done
  # Anything still listening on the core port (covers an orphaned core whose
  # command line drifted from the patterns above).
  local pids
  pids=$(lsof -i ":$PORT" -sTCP:LISTEN -t 2>/dev/null || true)
  [ -n "$pids" ] && kill -TERM $pids 2>/dev/null || true
}

kill_pass() {
  for pat in "${PATTERNS[@]}"; do
    pkill -KILL -f "$pat" 2>/dev/null || true
  done
  local pids
  pids=$(lsof -i ":$PORT" -sTCP:LISTEN -t 2>/dev/null || true)
  [ -n "$pids" ] && kill -KILL $pids 2>/dev/null || true
}

term_pass
# Give core a moment to distill the session and exit cleanly before the hammer.
sleep 2
kill_pass

rm -f /tmp/sinain-pids.txt 2>/dev/null || true
exit 0
