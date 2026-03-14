"""Screen capture on Windows via mss (DXGI Desktop Duplication)."""
from __future__ import annotations

import time
from typing import Generator

from PIL import Image

try:
    import mss
except ImportError:
    mss = None


class WinScreenCapture:
    """Captures screen frames on Windows using mss (DXGI Desktop Duplication).

    Same interface as ScreenCapture/ScreenKitCapture on macOS:
    capture_frame() -> (Image, float) and capture_loop() -> Generator.
    """

    def __init__(self, mode: str = "screen", target: int = 0,
                 fps: float = 1, scale: float = 0.5):
        if mss is None:
            raise RuntimeError("mss library required for Windows capture: pip install mss")
        self.mode = mode
        self.target = target  # monitor index (0 = all, 1 = primary, etc.)
        self.fps = fps
        self.scale = scale
        self.stats_ok = 0
        self.stats_fail = 0
        self._last_stats_time = time.time()
        self._stats_interval = 60
        self._sct = mss.mss()

    def capture_frame(self) -> tuple[Image.Image, float]:
        """Returns (PIL Image, timestamp).
        Uses mss for DXGI-based capture. Downscales by self.scale factor.
        """
        ts = time.time()

        # mss monitors: index 0 = all monitors combined, 1+ = individual
        monitor_idx = self.target + 1 if self.target >= 0 else 1
        if monitor_idx >= len(self._sct.monitors):
            monitor_idx = 1  # fallback to primary

        monitor = self._sct.monitors[monitor_idx]
        screenshot = self._sct.grab(monitor)

        # Convert to PIL Image (mss returns BGRA)
        img = Image.frombytes("RGB", screenshot.size, screenshot.rgb)

        if self.scale != 1.0:
            new_w = int(img.width * self.scale)
            new_h = int(img.height * self.scale)
            img = img.resize((new_w, new_h), Image.LANCZOS)

        self.stats_ok += 1
        if self.stats_ok == 1:
            print(f"[capture-win] first frame: {img.width}x{img.height} "
                  f"(monitor={monitor['width']}x{monitor['height']}, scale={self.scale})",
                  flush=True)
        return img, ts

    def capture_loop(self) -> Generator[tuple[Image.Image, float], None, None]:
        """Yields frames at self.fps rate."""
        interval = 1.0 / self.fps
        while True:
            start = time.time()
            try:
                yield self.capture_frame()
            except Exception as e:
                self.stats_fail += 1
                print(f"[capture-win] error: {e}", flush=True)
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
            print(f"[capture-win] stats: {self.stats_ok} ok, {self.stats_fail} fail"
                  f" ({rate:.0f}% success, {total} total)", flush=True)
            self._last_stats_time = now
