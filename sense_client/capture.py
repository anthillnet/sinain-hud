"""Screen capture using macOS screencapture CLI."""

import os
import subprocess
import tempfile
import time
from typing import Generator

from PIL import Image


class ScreenCapture:
    """Captures screen frames at configurable rate."""

    def __init__(self, mode: str = "screen", target: int = 0,
                 fps: float = 1, scale: float = 0.5):
        self.mode = mode
        self.target = target
        self.fps = fps
        self.scale = scale
        self.stats_ok = 0
        self.stats_fail = 0
        self._last_stats_time = time.time()
        self._stats_interval = 60  # log stats every 60s

    def capture_frame(self) -> tuple[Image.Image, float]:
        """Returns (PIL Image, timestamp).
        Uses macOS screencapture -x -C -t png to a temp file.
        Downscales by self.scale factor before returning.
        """
        ts = time.time()
        fd, tmp = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            result = subprocess.run(
                ["screencapture", "-x", "-C", "-t", "png", tmp],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode != 0:
                stderr = result.stderr.strip()
                self.stats_fail += 1
                raise RuntimeError(f"screencapture exit {result.returncode}: {stderr}")
            if not os.path.exists(tmp) or os.path.getsize(tmp) == 0:
                self.stats_fail += 1
                raise RuntimeError("screencapture produced empty file")
            img = Image.open(tmp)
            if self.scale != 1.0:
                new_w = int(img.width * self.scale)
                new_h = int(img.height * self.scale)
                img = img.resize((new_w, new_h), Image.LANCZOS)
            self.stats_ok += 1
            return img, ts
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def capture_loop(self) -> Generator[tuple[Image.Image, float], None, None]:
        """Yields frames at self.fps rate."""
        interval = 1.0 / self.fps
        while True:
            start = time.time()
            try:
                yield self.capture_frame()
            except Exception as e:
                print(f"[capture] error: {e}")
            self._maybe_log_stats()
            elapsed = time.time() - start
            sleep_time = interval - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)

    def _maybe_log_stats(self):
        now = time.time()
        if now - self._last_stats_time >= self._stats_interval:
            total = self.stats_ok + self.stats_fail
            rate = (self.stats_ok / total * 100) if total > 0 else 0
            print(f"[capture] stats: {self.stats_ok} ok, {self.stats_fail} fail"
                  f" ({rate:.0f}% success, {total} total)")
            if self.stats_fail > 0 and self.stats_ok == 0:
                print("[capture] WARNING: all captures failing — check screen recording permissions")
            self._last_stats_time = now
