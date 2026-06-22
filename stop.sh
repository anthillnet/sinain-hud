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

# Process patterns covering both dev (tsx) and bundled runs. These match the
# CURRENT command line, so they account for our process renaming: core/proxy set
# process.title (-> "sinain-core" / "sinain-proxy"), and the Python helpers are
# launched via sinain-named symlinks. We match on the stable module/script name
# (e.g. "sense_client", "sidecar.py") so a renamed interpreter still matches.
# sck-capture is core's child and dies on core's SIGTERM, but we list it too as
# a backstop in case core was killed uncleanly on a previous run.
PATTERNS=(
  "sinain_hud.app/Contents/MacOS/sinain_hud"   # overlay (packaged + dev build)
  "flutter run -d macos"                        # dev overlay wrapper
  "sinain-core"                                  # core (process.title; dev + bundled)
  "tsx.*src/index.ts"                            # core (dev, pre-title fallback)
  "sense_client"                                 # sense_client (any interpreter / sinain-sense)
  "sidecar.py"                                    # chat sidecar (sinain-chat / python)
  "kg_daemon.py"                                  # warm KG retrieval daemon (sinain-kg)
  "sinain-proxy"                                 # OpenRouter proxy (process.title)
  "openrouter-proxy"                             # OpenRouter proxy (pre-title fallback)
  "sck-capture"                                   # ScreenCaptureKit binary
)

# Snapshot the PIDs to stop ONCE, up front — every process matching a pattern
# or holding the core port, minus this script itself. We SIGTERM these, wait,
# then SIGKILL only the same PIDs. Crucially we never re-scan at SIGKILL time:
# a backend that (re)starts during the grace window has a brand-new PID (and is
# the new owner of :$PORT) that was never in the snapshot, so we leave it alone.
# Without this, a first-run-wizard relaunch (stop old backend → start new one)
# races the SIGKILL pass and the freshly-started core + sck-capture get killed
# by pattern + port — the backend "never comes online" after setup.
collect_pids() {
  {
    for pat in "${PATTERNS[@]}"; do
      pgrep -f "$pat" 2>/dev/null || true
    done
    # Anything listening on the core port (covers an orphaned core whose command
    # line drifted from the patterns above).
    lsof -i ":$PORT" -sTCP:LISTEN -t 2>/dev/null || true
  } | grep -E '^[0-9]+$' | sort -u | grep -vx "$$" || true
}

SNAPSHOT_PIDS="$(collect_pids | tr '\n' ' ')"

if [ -n "${SNAPSHOT_PIDS// /}" ]; then
  # SIGTERM first so core's graceful-shutdown hook can flush/distill the session.
  kill -TERM $SNAPSHOT_PIDS 2>/dev/null || true
  # Give core a moment to exit cleanly before the hammer.
  sleep 2
  # SIGKILL only the still-alive snapshot PIDs — never a fresh re-scan, so a
  # backend that (re)started during the grace window survives.
  for pid in $SNAPSHOT_PIDS; do
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  done
fi

rm -f /tmp/sinain-pids.txt 2>/dev/null || true
exit 0
