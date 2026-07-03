"""Capture ownership — sense_client owns sck-capture (video AND audio).

Single-owner model: exactly one process (this one) spawns and supervises the
capture binary. Screen frames flow to the IPC dir as before (we are their
consumer); audio PCM is forwarded to sinain-core through a named pipe, which
core's AudioPipeline reads with a trivial `cat` spawner (AUDIO_CAPTURE_CMD=
fifo). Consequences:
  - `--no-sense` genuinely means NO capture of any kind (core no longer
    spawns sck-capture behind the user's back), and
  - no more wasted screen encoding when the frame consumer is absent — if
    sense_client isn't running, nothing captures.

Enabled via SINAIN_CAPTURE_OWNER=sense (start.sh sets it whenever sense runs;
standalone `python -m sense_client` without the env keeps the legacy
core-owned capture untouched). macOS only — Windows capture is a separate
binary owned by core.

PCM forwarding: the FIFO is opened O_RDWR|O_NONBLOCK (never blocks on a
missing reader). While core is attached the pipe drains and writes succeed;
with no reader the pipe fills and we DROP chunks (correct: no consumer, no
buffering ambition — live audio has no replay value here anyway).
"""

from __future__ import annotations

import os
import stat
import subprocess
import sys
import threading
import time

FIFO_PATH = os.path.expanduser("~/.sinain/capture/audio.pcm.fifo")
CAPTURE_DIR = os.path.expanduser("~/.sinain/capture")
CHUNK = 4096
RESTART_BACKOFF_S = (1, 2, 5, 10, 30)


def _find_binary() -> str | None:
    candidates = [
        os.environ.get("SCK_CAPTURE_BIN") or "",
        os.path.expanduser("~/.sinain/sck-capture/sck-capture"),
        os.path.join(os.path.dirname(__file__), "..", "tools", "sck-capture", "sck-capture"),
    ]
    for c in candidates:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return os.path.abspath(c)
    return None


class CaptureOwner:
    """Spawns sck-capture (audio+screen), pumps PCM stdout → FIFO, restarts
    on exit with backoff. stop() tears everything down."""

    def __init__(self) -> None:
        self._proc: subprocess.Popen | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._fifo_fd: int | None = None
        # Version-skew compat (same pattern as core's spawner): a stale
        # installed binary rejects newer optional flags with an instant exit.
        # After one instant death, retry without optional flags.
        self._compat = False

    def start(self) -> bool:
        if sys.platform != "darwin":
            return False
        binary = _find_binary()
        if not binary:
            print("[capture-owner] sck-capture binary not found — no capture "
                  "(run: npx @geravant/sinain setup-sck-capture)", flush=True)
            return False
        os.makedirs(CAPTURE_DIR, mode=0o700, exist_ok=True)
        try:
            if not (os.path.exists(FIFO_PATH) and stat.S_ISFIFO(os.stat(FIFO_PATH).st_mode)):
                if os.path.exists(FIFO_PATH):
                    os.unlink(FIFO_PATH)
                os.mkfifo(FIFO_PATH, 0o600)
        except OSError as e:
            print(f"[capture-owner] fifo setup failed: {e}", flush=True)
            return False
        # O_RDWR: opening never blocks and the pipe survives reader restarts
        # (core's `cat` can come and go without EOF-ing us).
        self._fifo_fd = os.open(FIFO_PATH, os.O_RDWR | os.O_NONBLOCK)
        self._thread = threading.Thread(target=self._run, args=(binary,), daemon=True,
                                        name="capture-owner")
        self._thread.start()
        return True

    def _spawn(self, binary: str) -> subprocess.Popen:
        fps = os.environ.get("CAPTURE_FPS", "4")
        scale = os.environ.get("CAPTURE_SCALE", "1.0")
        args = [
            binary,
            "--sample-rate", os.environ.get("AUDIO_SAMPLE_RATE", "16000"),
            "--channels", "1",
            "--screen-dir", CAPTURE_DIR,
            "--fps", fps, "--scale", scale,
        ]
        if os.environ.get("CAPTURE_FOLLOW_DISPLAY") != "true" and not self._compat:
            args.append("--pin-display")
        print(f"[capture-owner] spawning: {' '.join(args)}", flush=True)
        return subprocess.Popen(args, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, bufsize=0)

    def _run(self, binary: str) -> None:
        backoff_i = 0
        while not self._stop.is_set():
            try:
                self._proc = self._spawn(binary)
            except OSError as e:
                print(f"[capture-owner] spawn failed: {e}", flush=True)
                return
            started = time.monotonic()
            out = self._proc.stdout
            dropped = 0
            while not self._stop.is_set():
                chunk = out.read(CHUNK) if out else b""
                if not chunk:
                    break  # child exited
                try:
                    os.write(self._fifo_fd, chunk)  # type: ignore[arg-type]
                except BlockingIOError:
                    dropped += 1  # no reader / pipe full — drop live audio
                except OSError:
                    break
            if self._stop.is_set():
                break
            ran_s = time.monotonic() - started
            if ran_s < 2 and not self._compat:
                self._compat = True
                print("[capture-owner] instant exit — stale binary? retrying without "
                      "optional flags (update: npx @geravant/sinain setup-sck-capture)",
                      flush=True)
                continue
            backoff_i = 0 if ran_s > 60 else min(backoff_i + 1, len(RESTART_BACKOFF_S) - 1)
            delay = RESTART_BACKOFF_S[backoff_i]
            print(f"[capture-owner] sck-capture exited after {ran_s:.0f}s "
                  f"(dropped {dropped} chunks) — restart in {delay}s", flush=True)
            self._stop.wait(delay)

    def stop(self) -> None:
        self._stop.set()
        if self._proc and self._proc.poll() is None:
            try:
                self._proc.terminate()
                self._proc.wait(timeout=3)
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass
        if self._fifo_fd is not None:
            try:
                os.close(self._fifo_fd)
            except OSError:
                pass


def maybe_start() -> "CaptureOwner | None":
    """Start capture ownership when configured (SINAIN_CAPTURE_OWNER=sense)."""
    if os.environ.get("SINAIN_CAPTURE_OWNER") != "sense":
        return None
    owner = CaptureOwner()
    return owner if owner.start() else None
