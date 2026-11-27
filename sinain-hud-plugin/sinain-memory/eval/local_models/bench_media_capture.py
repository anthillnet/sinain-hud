"""Real end-to-end meeting bench (Path C) — orchestrates live capture.

This is the load-bearing Outcome 2 bench surface. Unlike `bench_media.py`
(idealized: feeds the pre-transcribed transcript directly into the distiller
subprocess), this orchestrator runs sinain's full capture pipeline against a
played video so transcription, audio segmentation, vision OCR, and timing
all enter the measurement.

Pipeline (per run):
  1. Verify pre-flight (no sinain on :9500, ffmpeg + audio device present)
  2. Create a fresh bench memory dir at ~/.sinain-bench/<timestamp>/memory
  3. Start sinain-core + sense_client with SINAIN_MEMORY_DIR pointed there
  4. Wait for sinain to be ready (poll :9500)
  5. Open the video in QuickTime — sense_client captures the screen, audio
     routes through whatever the system default is (recommend BlackHole 2ch)
  6. Sleep video_duration + 60s buffer for distillation catch-up
  7. Send SIGTERM to sinain so it finalizes pending sessions cleanly
  8. Run `meeting_runner.py --db <bench-dir>/knowledge-graph.db --meeting <stem>`
     to query the captured graph and score against the pre-authored QA pairs

Each invocation produces a fresh, isolated knowledge graph — no contamination
of the operator's production ~/.sinain/memory.

Usage:
    # 5-minute iteration loop (fastest):
    python3 -m eval.local_models.bench_media_capture \\
        --video al-futaim-prep-5min --meeting al-futaim-prep-5min --duration 300

    # Full 27-minute reference run:
    python3 -m eval.local_models.bench_media_capture \\
        --video al-futaim-prep --meeting al-futaim-prep --duration 1620
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path


# Path constants — derived from this module's location.
# parents: [0]local_models [1]eval [2]sinain-memory [3]sinain-hud-plugin [4]sinain-hud (project root)
REPO_ROOT = Path(__file__).resolve().parents[4]
SINAIN_CORE_DIR = REPO_ROOT / "sinain-core"
SINAIN_MEMORY_DIR = REPO_ROOT / "sinain-hud-plugin" / "sinain-memory"
MEETING_DATA_DIR = SINAIN_MEMORY_DIR / "eval" / "benchmarks" / "data" / "meeting"
BENCH_BASE = Path.home() / ".sinain-bench"

SINAIN_HTTP_PORT = 9500
PORT_READY_TIMEOUT_S = 60
DISTILLATION_DRAIN_S = 60     # extra wait after video ends so distillation finalizes


# ----------------------------------------------------------------------
# Pre-flight checks
# ----------------------------------------------------------------------

def _port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return False
        except OSError:
            return True


def _check_default_audio_device() -> str | None:
    """Return name of current default OUTPUT device (best-effort)."""
    try:
        result = subprocess.run(
            ["system_profiler", "SPAudioDataType", "-json"],
            capture_output=True, text=True, timeout=5,
        )
        data = json.loads(result.stdout)
        for item in data.get("SPAudioDataType", []):
            for dev in item.get("_items", []):
                if dev.get("coreaudio_default_audio_output_device") == "spaudio_yes":
                    return dev.get("_name")
    except Exception:
        return None
    return None


def _resolve_video(video_arg: str) -> Path:
    """Accept either an absolute path or a stem under data/meeting/."""
    p = Path(video_arg).expanduser()
    if p.exists():
        return p
    # Try as stem under MEETING_DATA_DIR — look for .mp4
    candidate = MEETING_DATA_DIR / f"{video_arg}.mp4"
    if candidate.exists():
        return candidate
    raise FileNotFoundError(
        f"Video not found at {p} or {candidate}. "
        "Pass either an absolute path or a stem under "
        "sinain-hud-plugin/sinain-memory/eval/benchmarks/data/meeting/"
    )


def preflight() -> None:
    issues: list[str] = []

    if subprocess.run(["which", "ffmpeg"], capture_output=True).returncode != 0:
        issues.append("ffmpeg not on PATH")

    if _port_in_use(SINAIN_HTTP_PORT):
        issues.append(
            f"port {SINAIN_HTTP_PORT} is busy — stop your running sinain "
            "before launching the bench instance"
        )

    audio_dev = _check_default_audio_device()
    # Accept any device whose name suggests it routes to BlackHole:
    #  - "BlackHole 2ch" (direct — operator hears nothing through speakers)
    #  - "Multi-Output Device <N>" (typical macOS pattern — combines BlackHole
    #    with real speakers so operator hears audio AND sinain captures it)
    # If your multi-output device has a custom name not matching either pattern,
    # set SINAIN_AUDIO_DEVICE_OVERRIDE=1 to silence this warning.
    is_routable = (
        audio_dev
        and (
            "blackhole" in audio_dev.lower()
            or "multi-output" in audio_dev.lower()
            or os.environ.get("SINAIN_AUDIO_DEVICE_OVERRIDE") == "1"
        )
    )
    if audio_dev and not is_routable:
        print(
            f"⚠️  Default audio output is '{audio_dev}'. Sinain's audio pipeline "
            "expects audio routed through BlackHole (bare or as part of a "
            "Multi-Output Device). Bench may capture silence. Set "
            "SINAIN_AUDIO_DEVICE_OVERRIDE=1 if your setup is correct under a "
            "non-standard device name.",
            file=sys.stderr,
        )

    if issues:
        raise RuntimeError("Pre-flight failed:\n  - " + "\n  - ".join(issues))


# ----------------------------------------------------------------------
# Sinain process lifecycle
# ----------------------------------------------------------------------

def _wait_for_port(port: int, timeout_s: int) -> None:
    start = time.monotonic()
    while time.monotonic() - start < timeout_s:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(1.0)
            try:
                s.connect(("127.0.0.1", port))
                return
            except (OSError, socket.timeout):
                pass
        time.sleep(1)
    raise TimeoutError(f"sinain-core did not bind :{port} within {timeout_s}s")


def start_sinain(bench_memory: Path, log_dir: Path) -> dict:
    """Spawn sinain-core + sense_client pointed at the bench memory dir."""
    bench_memory.mkdir(parents=True, exist_ok=True)
    log_dir.mkdir(parents=True, exist_ok=True)

    env = {
        **os.environ,
        "SINAIN_MEMORY_DIR": str(bench_memory),
        # Force a known-good privacy mode so capture content actually reaches the LLM.
        # `paranoid` would starve the distiller (per privacy/presets.ts).
        "PRIVACY_MODE": os.environ.get("PRIVACY_MODE", "standard"),
    }

    print(f"[capture] starting sinain-core with SINAIN_MEMORY_DIR={bench_memory}",
          file=sys.stderr)
    core_log = open(log_dir / "core.log", "w")
    core = subprocess.Popen(
        ["npm", "run", "dev"],
        cwd=str(SINAIN_CORE_DIR),
        env=env,
        stdout=core_log,
        stderr=subprocess.STDOUT,
        preexec_fn=os.setsid,  # new process group so SIGTERM hits children
    )

    print(f"[capture] waiting for :{SINAIN_HTTP_PORT}...", file=sys.stderr)
    try:
        _wait_for_port(SINAIN_HTTP_PORT, PORT_READY_TIMEOUT_S)
    except TimeoutError:
        # Show tail of core log to help diagnosis
        try:
            core_log.flush()
            tail = (log_dir / "core.log").read_text().splitlines()[-30:]
            print("[capture] sinain-core last 30 lines:", file=sys.stderr)
            print("\n".join(tail), file=sys.stderr)
        except Exception:
            pass
        core.terminate()
        raise

    print(f"[capture] starting sense_client", file=sys.stderr)
    sense_log = open(log_dir / "sense.log", "w")
    sense = subprocess.Popen(
        ["python3", "-m", "sense_client"],
        cwd=str(REPO_ROOT),
        env=env,
        stdout=sense_log,
        stderr=subprocess.STDOUT,
        preexec_fn=os.setsid,
    )
    # No port to poll for sense_client; give it a short warm-up
    time.sleep(3)

    return {"core": (core, core_log), "sense": (sense, sense_log)}


def stop_sinain(procs: dict) -> None:
    """Send SIGTERM to all processes; wait up to 15s for clean exit; SIGKILL fallback."""
    for name, (p, _log) in procs.items():
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGTERM)
            print(f"[capture] sent SIGTERM to {name} (pid {p.pid})", file=sys.stderr)
        except ProcessLookupError:
            pass
    for name, (p, log) in procs.items():
        try:
            p.wait(timeout=15)
        except subprocess.TimeoutExpired:
            print(f"[capture] {name} did not exit gracefully — SIGKILL", file=sys.stderr)
            try:
                os.killpg(os.getpgid(p.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
        finally:
            log.close()


def play_video(video: Path) -> None:
    """Open video in QuickTime Player AND auto-start playback.

    `open -a` opens the file but does NOT start playback — QuickTime UX quirk.
    AppleScript drives the play action so the bench actually captures content.
    """
    print(f"[capture] opening + auto-playing video: {video}", file=sys.stderr)
    # Single AppleScript call: open the file in QuickTime, then play it.
    # Path is single-quote-escaped for AppleScript string literal.
    quoted = str(video).replace('"', '\\"')
    script = (
        f'tell application "QuickTime Player"\n'
        f'  activate\n'
        f'  set theMovie to open POSIX file "{quoted}"\n'
        f'  delay 1\n'
        f'  play theMovie\n'
        f'end tell'
    )
    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(
            f"[capture] WARNING: AppleScript play failed: {result.stderr.strip()}\n"
            "  Video may have opened but not started. If you see no playback, "
            "manually press space in QuickTime within a few seconds.",
            file=sys.stderr,
        )


# ----------------------------------------------------------------------
# Orchestration
# ----------------------------------------------------------------------

def orchestrate(video: Path, duration_s: int) -> tuple[Path, Path]:
    """Run one capture cycle. Returns (db_path, bench_dir)."""
    bench_dir = BENCH_BASE / datetime.now().strftime("%Y%m%dT%H%M%S")
    bench_memory = bench_dir / "memory"
    log_dir = bench_dir / "logs"

    procs = start_sinain(bench_memory, log_dir)
    try:
        play_video(video)
        wait_total = duration_s + DISTILLATION_DRAIN_S
        print(
            f"[capture] sleeping {duration_s}s (video) + {DISTILLATION_DRAIN_S}s "
            f"(distillation drain) = {wait_total}s total",
            file=sys.stderr,
        )
        # Sleep in chunks with a heartbeat — easier to see progress in logs
        slept = 0
        chunk = 30
        while slept < wait_total:
            interval = min(chunk, wait_total - slept)
            time.sleep(interval)
            slept += interval
            print(f"[capture] ... {slept}/{wait_total}s elapsed", file=sys.stderr)
    finally:
        print(f"[capture] stopping sinain processes...", file=sys.stderr)
        stop_sinain(procs)

    db = bench_memory / "knowledge-graph.db"
    if not db.exists():
        raise RuntimeError(
            f"No knowledge-graph.db produced in {bench_memory}. "
            f"Check {log_dir}/core.log and {log_dir}/sense.log."
        )
    return db, bench_dir


# ----------------------------------------------------------------------
# Scoring (delegated to meeting_runner)
# ----------------------------------------------------------------------

def score_via_meeting_runner(
    db: Path,
    meeting_stem: str,
    subset: int | None,
) -> int:
    """Run meeting_runner.py as a subprocess pointing at the captured DB."""
    cmd = [
        "python3", "-m", "eval.benchmarks.meeting_runner",
        "--db", str(db),
        "--meeting", meeting_stem,
        "--conditions", "sinain-memory,full-context",
        "--format", "json,markdown",
    ]
    if subset:
        cmd.extend(["--subset", str(subset)])
    print(f"[capture] scoring: {' '.join(cmd)}", file=sys.stderr)
    result = subprocess.run(cmd, cwd=str(SINAIN_MEMORY_DIR))
    return result.returncode


# ----------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="Real end-to-end meeting bench (Path C)")
    parser.add_argument("--video", required=True,
                        help="Absolute path OR stem under data/meeting/ (e.g. 'al-futaim-prep-5min')")
    parser.add_argument("--meeting", required=True,
                        help="QA set stem under data/meeting/ (e.g. 'al-futaim-prep-5min')")
    parser.add_argument("--duration", type=int, required=True,
                        help="Video duration in seconds (used to time the capture sleep)")
    parser.add_argument("--subset", type=int, default=None,
                        help="Score only first N questions (default: all)")
    parser.add_argument("--no-score", action="store_true",
                        help="Capture only; don't run meeting_runner")
    args = parser.parse_args()

    video = _resolve_video(args.video)
    preflight()

    print(f"[capture] === Bench: video={video.name} duration={args.duration}s ===",
          file=sys.stderr)
    db, bench_dir = orchestrate(video, args.duration)
    print(f"[capture] === Captured DB: {db} ({db.stat().st_size} bytes) ===",
          file=sys.stderr)
    print(f"[capture] === Bench artifacts: {bench_dir} ===", file=sys.stderr)

    if args.no_score:
        print(f"\nCaptured DB at: {db}")
        return 0

    print(f"[capture] === Scoring ===", file=sys.stderr)
    rc = score_via_meeting_runner(db, args.meeting, args.subset)
    return rc


if __name__ == "__main__":
    sys.exit(main())
