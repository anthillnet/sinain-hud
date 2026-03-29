"""POST sense events to the relay server."""

import base64
import io
import time

import requests
from PIL import Image

from .gate import SenseEvent

# Retry config for /sense POST
_MAX_RETRIES = 3
_RETRY_BASE_DELAY_S = 1.0  # 1s, 2s, 4s (exponential)


class SenseSender:
    """POSTs sense events to the relay server with retry and backoff."""

    def __init__(self, url: str = "http://localhost:9500",
                 max_image_kb: int = 500, send_thumbnails: bool = True):
        self.url = url.rstrip("/")
        self.max_image_kb = max_image_kb
        self.send_thumbnails = send_thumbnails
        self._latencies: list[float] = []
        self._last_stats_ts: float = time.time()
        self._consecutive_failures: int = 0

    def send(self, event: SenseEvent) -> bool:
        """POST /sense with JSON payload. Returns True on success."""
        payload = {
            "type": event.type,
            "ts": event.ts,
            "ocr": event.ocr,
            "meta": {
                "ssim": event.meta.ssim,
                "app": event.meta.app,
                "windowTitle": event.meta.window_title,
                "screen": event.meta.screen,
            },
        }
        if event.roi:
            payload["roi"] = event.roi
        if event.diff:
            payload["diff"] = event.diff
        if event.observation and event.observation.title:
            payload["observation"] = {
                "title": event.observation.title,
                "subtitle": event.observation.subtitle,
                "facts": event.observation.facts,
                "narrative": event.observation.narrative,
                "concepts": event.observation.concepts,
            }
        if event.vision_cost:
            payload["vision_cost"] = event.vision_cost

        for attempt in range(_MAX_RETRIES):
            try:
                start = time.time()
                resp = requests.post(
                    f"{self.url}/sense",
                    json=payload,
                    timeout=5,
                )
                elapsed_ms = (time.time() - start) * 1000
                self._latencies.append(elapsed_ms)
                self._maybe_log_stats()

                if resp.status_code == 200:
                    if self._consecutive_failures > 0:
                        print(f"[sender] reconnected after {self._consecutive_failures} failure(s)", flush=True)
                    self._consecutive_failures = 0
                    return True

                # Non-200 but not an exception — log and retry
                print(f"[sender] HTTP {resp.status_code} on attempt {attempt + 1}/{_MAX_RETRIES}", flush=True)

            except requests.exceptions.ConnectionError as e:
                print(f"[sender] connection error (attempt {attempt + 1}/{_MAX_RETRIES}): {e}", flush=True)
            except requests.exceptions.Timeout:
                print(f"[sender] timeout (attempt {attempt + 1}/{_MAX_RETRIES})", flush=True)
            except Exception as e:
                print(f"[sender] unexpected error (attempt {attempt + 1}/{_MAX_RETRIES}): {e}", flush=True)

            # Don't sleep after the last attempt
            if attempt < _MAX_RETRIES - 1:
                delay = _RETRY_BASE_DELAY_S * (2 ** attempt)
                print(f"[sender] retrying in {delay:.1f}s...", flush=True)
                time.sleep(delay)

        self._consecutive_failures += 1
        if self._consecutive_failures == 1 or self._consecutive_failures % 10 == 0:
            print(f"[sender] all {_MAX_RETRIES} attempts failed (consecutive failures: {self._consecutive_failures})", flush=True)
        return False

    def _maybe_log_stats(self):
        """Log P50/P95 send latencies every 60s."""
        now = time.time()
        if now - self._last_stats_ts < 60:
            return
        if not self._latencies:
            return
        sorted_lat = sorted(self._latencies)
        p50 = sorted_lat[len(sorted_lat) // 2]
        p95 = sorted_lat[int(len(sorted_lat) * 0.95)]
        print(f"[sender] relay latency: p50={p50:.0f}ms p95={p95:.0f}ms (n={len(sorted_lat)})", flush=True)
        self._latencies.clear()
        self._last_stats_ts = now


def encode_image(img: Image.Image, max_kb: int, max_px: int = 0) -> str:
    """Encode PIL Image to base64 JPEG, reducing quality until under max_kb."""
    if max_px:
        ratio = max_px / max(img.size)
        if ratio < 1:
            img = img.resize(
                (int(img.width * ratio), int(img.height * ratio)),
                Image.LANCZOS,
            )

    if img.mode == "RGBA":
        img = img.convert("RGB")

    # Try high quality first — often fits
    max_bytes = max_kb * 1024
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    if buf.tell() <= max_bytes:
        return base64.b64encode(buf.getvalue()).decode()

    # Binary search for the highest quality that fits
    lo, hi = 20, 80
    best_buf = None
    while lo <= hi:
        mid = (lo + hi) // 2
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=mid)
        if buf.tell() <= max_bytes:
            best_buf = buf
            lo = mid + 1
        else:
            hi = mid - 1

    if best_buf is not None:
        return base64.b64encode(best_buf.getvalue()).decode()

    # Last resort: return at lowest quality
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=20)
    return base64.b64encode(buf.getvalue()).decode()


def package_full_frame(frame: Image.Image, max_px: int = 384) -> dict:
    """Package a full frame as a small thumbnail for context events."""
    return {
        "data": encode_image(frame, max_kb=200, max_px=max_px),
        "bbox": [0, 0, frame.width, frame.height],
        "thumb": True,
    }


def package_roi(roi, thumb: bool = True) -> dict:
    """Package an ROI as a small thumbnail for text/visual events."""
    return {
        "data": encode_image(roi.image, max_kb=60, max_px=384),
        "bbox": list(roi.bbox),
        "thumb": True,
    }


def package_diff(diff_image: Image.Image) -> dict:
    """Package a diff image."""
    return {
        "data": encode_image(diff_image, max_kb=200),
    }
