"""Communication layer: WebSocket (primary) and HTTP POST (fallback).

Provides priority-based sending with backpressure handling.
"""

import asyncio
import base64
import io
import json
import queue
import threading
import time
from dataclasses import dataclass
from enum import IntEnum
from typing import Optional, Callable

import requests
from PIL import Image

from .gate import SenseEvent


class Priority(IntEnum):
    """Event priority levels."""
    URGENT = 0   # App switch, error detected - send immediately
    HIGH = 1     # Significant text change
    NORMAL = 2   # Minor updates, scroll


@dataclass
class QueuedEvent:
    """Event in the send queue."""
    priority: Priority
    ts: float
    payload: dict
    attempts: int = 0


class WebSocketSender:
    """WebSocket-based sender with priority queue.

    Uses a persistent WebSocket connection for lower latency and
    supports priority-based sending with backpressure handling.
    """

    def __init__(self, url: str = "ws://localhost:9500/sense/ws",
                 reconnect_delay: float = 2.0,
                 max_queue_size: int = 100):
        """
        Args:
            url: WebSocket endpoint URL.
            reconnect_delay: Seconds between reconnection attempts.
            max_queue_size: Maximum queued events before dropping.
        """
        self.url = url
        self.reconnect_delay = reconnect_delay
        self.max_queue_size = max_queue_size

        # Priority queue: (priority, timestamp, event)
        self._queue: queue.PriorityQueue = queue.PriorityQueue()
        self._ws = None
        self._connected = False
        self._running = False
        self._thread: Optional[threading.Thread] = None

        # Backpressure state
        self._backpressure_until = 0.0

        # Stats
        self.events_sent = 0
        self.events_dropped = 0
        self.reconnect_count = 0
        self._latencies: list[float] = []
        self._last_stats_ts = time.time()

    def start(self) -> None:
        """Start the WebSocket sender thread."""
        if self._running:
            return

        self._running = True
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Stop the sender thread."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=2.0)

    def send(self, event: SenseEvent, priority: Priority = Priority.NORMAL) -> bool:
        """Queue an event for sending.

        Args:
            event: SenseEvent to send.
            priority: Event priority level.

        Returns:
            True if queued, False if queue is full.
        """
        if self._queue.qsize() >= self.max_queue_size:
            self.events_dropped += 1
            return False

        payload = self._build_payload(event)
        queued = QueuedEvent(
            priority=priority,
            ts=time.time(),
            payload=payload,
        )
        self._queue.put((priority.value, time.time(), queued))
        return True

    def _build_payload(self, event: SenseEvent) -> dict:
        """Build JSON payload from SenseEvent."""
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
        return payload

    def _run_loop(self) -> None:
        """Main sender loop (runs in background thread)."""
        import asyncio

        try:
            import websockets
            HAS_WEBSOCKETS = True
        except ImportError:
            HAS_WEBSOCKETS = False
            print("[sender] websockets not available, using HTTP fallback")

        if HAS_WEBSOCKETS:
            asyncio.run(self._async_loop())
        else:
            self._sync_loop()

    async def _async_loop(self) -> None:
        """Async WebSocket loop."""
        import websockets

        while self._running:
            try:
                async with websockets.connect(self.url) as ws:
                    self._ws = ws
                    self._connected = True
                    print(f"[sender] WebSocket connected to {self.url}")

                    await self._process_queue(ws)

            except Exception as e:
                print(f"[sender] WebSocket error: {e}")
                self._connected = False
                self.reconnect_count += 1
                await asyncio.sleep(self.reconnect_delay)

    async def _process_queue(self, ws) -> None:
        """Process queued events via WebSocket."""
        while self._running and self._connected:
            # Check backpressure
            now = time.time()
            if now < self._backpressure_until:
                await asyncio.sleep(0.1)
                continue

            try:
                # Get event with timeout
                _, _, queued = self._queue.get(timeout=0.1)
            except queue.Empty:
                await asyncio.sleep(0.05)
                continue

            try:
                start = time.time()
                await ws.send(json.dumps(queued.payload))

                # Wait for ack
                try:
                    ack = await asyncio.wait_for(ws.recv(), timeout=2.0)
                    ack_data = json.loads(ack)

                    # Handle backpressure signal
                    if ack_data.get("backpressure", 0) > 0:
                        self._backpressure_until = time.time() + ack_data["backpressure"] / 1000

                    elapsed_ms = (time.time() - start) * 1000
                    self._latencies.append(elapsed_ms)
                    self.events_sent += 1

                except asyncio.TimeoutError:
                    # No ack, but message sent
                    self.events_sent += 1

            except Exception as e:
                print(f"[sender] send error: {e}")
                queued.attempts += 1
                if queued.attempts < 3:
                    # Re-queue for retry
                    self._queue.put((queued.priority.value + 1, time.time(), queued))
                else:
                    self.events_dropped += 1

            self._maybe_log_stats()

    def _sync_loop(self) -> None:
        """Synchronous HTTP fallback loop."""
        http_sender = SenseSender(url=self.url.replace("ws://", "http://").replace("/sense/ws", ""))

        while self._running:
            try:
                _, _, queued = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue

            # Convert payload back to SenseEvent for HTTP sender
            from .gate import SenseEvent, SenseMeta
            event = SenseEvent(
                type=queued.payload["type"],
                ts=queued.payload["ts"],
                ocr=queued.payload.get("ocr", ""),
                roi=queued.payload.get("roi"),
                meta=SenseMeta(
                    ssim=queued.payload["meta"]["ssim"],
                    app=queued.payload["meta"]["app"],
                    window_title=queued.payload["meta"]["windowTitle"],
                    screen=queued.payload["meta"]["screen"],
                ),
            )
            if http_sender.send(event):
                self.events_sent += 1
            else:
                self.events_dropped += 1

    def _maybe_log_stats(self) -> None:
        """Log stats periodically."""
        now = time.time()
        if now - self._last_stats_ts < 60:
            return

        if self._latencies:
            sorted_lat = sorted(self._latencies)
            p50 = sorted_lat[len(sorted_lat) // 2]
            p95 = sorted_lat[int(len(sorted_lat) * 0.95)]
            print(f"[sender] ws latency: p50={p50:.0f}ms p95={p95:.0f}ms "
                  f"sent={self.events_sent} dropped={self.events_dropped}")
            self._latencies.clear()

        self._last_stats_ts = now

    @property
    def is_connected(self) -> bool:
        """Whether WebSocket is currently connected."""
        return self._connected

    def get_stats(self) -> dict:
        """Get sender statistics."""
        return {
            "connected": self._connected,
            "events_sent": self.events_sent,
            "events_dropped": self.events_dropped,
            "queue_size": self._queue.qsize(),
            "reconnect_count": self.reconnect_count,
        }


class SenseSender:
    """HTTP POST-based sender (fallback/compatibility)."""

    def __init__(self, url: str = "http://localhost:9500",
                 max_image_kb: int = 500, send_thumbnails: bool = True):
        self.url = url.rstrip("/")
        self.max_image_kb = max_image_kb
        self.send_thumbnails = send_thumbnails
        self._latencies: list[float] = []
        self._last_stats_ts: float = time.time()

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
            return resp.status_code == 200
        except Exception as e:
            print(f"[sender] error: {e}")
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
        print(f"[sender] relay latency: p50={p50:.0f}ms p95={p95:.0f}ms (n={len(sorted_lat)})")
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


def create_sender(config: dict, use_websocket: bool = True):
    """Factory to create appropriate sender based on config.

    Args:
        config: Configuration dict with relay settings.
        use_websocket: Whether to use WebSocket (default True).

    Returns:
        WebSocketSender or SenseSender instance.
    """
    relay_cfg = config.get("relay", {})
    url = relay_cfg.get("url", "http://localhost:9500")

    if use_websocket:
        ws_url = url.replace("http://", "ws://").replace("https://", "wss://")
        ws_url = ws_url.rstrip("/") + "/sense/ws"
        sender = WebSocketSender(url=ws_url)
        sender.start()
        return sender

    return SenseSender(
        url=url,
        max_image_kb=relay_cfg.get("maxImageKB", 500),
        send_thumbnails=relay_cfg.get("sendThumbnails", True),
    )
