"""HTTP POST sender to OpenClaw gateway with in-flight guard and latency tracking.

Modeled after sense_client's SenseSender but adapted for the wearable HUD's
camera/audio payloads rather than screen OCR events.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import time

import aiohttp

from .protocol import AudioChunk, RoomFrame

log = logging.getLogger(__name__)


class Sender:
    """Sends camera frames and audio chunks to the OpenClaw gateway.

    Features:
    - In-flight guard: skips new sends while a previous POST is pending
    - Rolling P50/P95 latency stats logged every 60s
    - Configurable timeout and source identification
    """

    def __init__(self, config: dict):
        gw = config.get("gateway", {})
        self.url = gw.get("url", "http://85.214.180.247:18789").rstrip("/")
        self.token = gw.get("token", "")
        self.session = gw.get("session", "sinain")

        self._in_flight = False
        self._session: aiohttp.ClientSession | None = None
        self._latencies: list[float] = []
        self._last_stats_ts = time.time()
        self._sends_ok = 0
        self._sends_failed = 0
        self._sends_skipped = 0

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            headers = {"Content-Type": "application/json"}
            if self.token:
                headers["Authorization"] = f"Bearer {self.token}"
            self._session = aiohttp.ClientSession(headers=headers)
        return self._session

    async def send_frame(self, frame: RoomFrame) -> bool:
        """POST a camera frame to OpenClaw. Returns True on success."""
        if self._in_flight:
            self._sends_skipped += 1
            log.debug("Skipping frame send (in-flight)")
            return False

        self._in_flight = True
        try:
            session = await self._ensure_session()
            payload = {
                "type": "room_camera",
                "source": "sinain-wearable-hud",
                "session": self.session,
                "data": {
                    "image": base64.b64encode(frame.jpeg_bytes).decode(),
                    "classification": frame.classification.value,
                    "ssim": frame.ssim,
                    "motion_pct": frame.motion_pct,
                    "text_hint_count": frame.text_hint_count,
                    "width": frame.width,
                    "height": frame.height,
                    "timestamp": frame.timestamp,
                },
            }

            t0 = time.time()
            async with session.post(f"{self.url}/sense",
                                    json=payload, timeout=10) as resp:
                elapsed_ms = (time.time() - t0) * 1000
                self._latencies.append(elapsed_ms)

                if resp.status == 200:
                    self._sends_ok += 1
                    return True
                else:
                    body = await resp.text()
                    log.warning("Send frame failed: %d %s", resp.status,
                                body[:200])
                    self._sends_failed += 1
                    return False

        except asyncio.TimeoutError:
            log.warning("Send frame timed out")
            self._sends_failed += 1
            return False
        except Exception as e:
            log.warning("Send frame error: %s", e)
            self._sends_failed += 1
            return False
        finally:
            self._in_flight = False
            self._maybe_log_stats()

    async def send_audio(self, chunk: AudioChunk) -> bool:
        """POST an audio chunk to OpenClaw. Returns True on success."""
        if self._in_flight:
            self._sends_skipped += 1
            return False

        self._in_flight = True
        try:
            session = await self._ensure_session()
            payload = {
                "type": "room_audio",
                "source": "sinain-wearable-hud",
                "session": self.session,
                "data": {
                    "audio": base64.b64encode(chunk.pcm_data).decode(),
                    "sample_rate": chunk.sample_rate,
                    "duration_s": chunk.duration_s,
                    "timestamp": chunk.timestamp,
                },
            }

            t0 = time.time()
            async with session.post(f"{self.url}/sense",
                                    json=payload, timeout=10) as resp:
                elapsed_ms = (time.time() - t0) * 1000
                self._latencies.append(elapsed_ms)

                if resp.status == 200:
                    self._sends_ok += 1
                    return True
                else:
                    self._sends_failed += 1
                    return False

        except Exception as e:
            log.warning("Send audio error: %s", e)
            self._sends_failed += 1
            return False
        finally:
            self._in_flight = False
            self._maybe_log_stats()

    def _maybe_log_stats(self) -> None:
        now = time.time()
        if now - self._last_stats_ts < 60:
            return
        if self._latencies:
            sorted_lat = sorted(self._latencies)
            p50 = sorted_lat[len(sorted_lat) // 2]
            p95 = sorted_lat[int(len(sorted_lat) * 0.95)]
            log.info("[sender] p50=%.0fms p95=%.0fms ok=%d fail=%d skip=%d",
                     p50, p95, self._sends_ok, self._sends_failed,
                     self._sends_skipped)
            self._latencies.clear()
        self._sends_ok = 0
        self._sends_failed = 0
        self._sends_skipped = 0
        self._last_stats_ts = now

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
