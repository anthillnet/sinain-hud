"""Screen capture using macOS screencapture CLI."""

import os
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

    def capture_frame(self) -> tuple[Image.Image, float]:
        """Returns (PIL Image, timestamp).
        Uses macOS screencapture -x -C -t png to a temp file.
        Downscales by self.scale factor before returning.
        """
        ts = time.time()
        fd, tmp = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            cmd = f"screencapture -x -C -t png {tmp}"
            os.system(cmd)
            img = Image.open(tmp)
            if self.scale != 1.0:
                new_w = int(img.width * self.scale)
                new_h = int(img.height * self.scale)
                img = img.resize((new_w, new_h), Image.LANCZOS)
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
            elapsed = time.time() - start
            sleep_time = interval - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)
