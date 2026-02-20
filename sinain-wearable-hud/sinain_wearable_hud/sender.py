"""WebSocket sender to OpenClaw gateway via agent RPC.

Formats camera frames and audio chunks as text messages for the agent RPC
protocol, maintaining an in-flight guard (one RPC at a time) and latency stats.
"""

from __future__ import annotations

import logging
import time
import uuid

from .gateway import OpenClawGateway
from .observation import ObservationBuffer, build_observation_message
from .protocol import AudioChunk, DisplayState, RoomFrame

log = logging.getLogger(__name__)


class Sender:
    """Sends camera frames and audio chunks via the OpenClaw WebSocket gateway.

    Features:
    - In-flight guard: skips new sends while a previous RPC is pending
    - Rolling P50/P95 latency stats logged every 60s
    - Text-only messages (no base64 image) to keep bandwidth low on Pi Zero
    """

    def __init__(self, config: dict, gateway: OpenClawGateway,
                 observation_buffer: ObservationBuffer | None = None,
                 display_state: DisplayState | None = None):
        self.gateway = gateway
        self._buffer = observation_buffer
        self._display_state = display_state
        self._in_flight = False
        self._latencies: list[float] = []
        self._last_stats_ts = time.time()
        self._sends_ok = 0
        self._sends_failed = 0
        self._sends_skipped = 0

    async def send_frame(self, frame: RoomFrame) -> bool:
        """Send a camera frame description via agent RPC. Returns True on success."""
        if self._in_flight:
            self._sends_skipped += 1
            log.debug("Skipping frame send (in-flight)")
            return False

        if not self.gateway.is_connected:
            self._sends_skipped += 1
            log.debug("Skipping frame send (gateway not connected)")
            return False

        self._in_flight = True
        try:
            if self._buffer is not None:
                self._buffer.add_frame(frame)
                message = build_observation_message(frame, self._buffer)
            else:
                # Legacy fallback — no observation buffer
                size_kb = len(frame.jpeg_bytes) // 1024
                message = (
                    f"[sinain-wearable:camera] {frame.classification.value}"
                    f" | ssim={frame.ssim:.2f} motion={frame.motion_pct:.0f}%"
                    f" text_hints={frame.text_hint_count}"
                    f" | {size_kb}KB {frame.width}x{frame.height}"
                )

            # Update debug display with observation + vision streams
            if self._display_state is not None:
                self._display_state.set_observation(message)
                if frame.description:
                    self._display_state.scene_description = frame.description
                if frame.ocr_text:
                    self._display_state.set_ocr(frame.ocr_text, 0.0)

            idem_key = f"frame-{uuid.uuid4().hex[:12]}"
            t0 = time.time()
            resp = await self.gateway.send_agent_rpc(message, idem_key)
            elapsed_ms = (time.time() - t0) * 1000
            self._latencies.append(elapsed_ms)

            if resp and resp.get("ok"):
                self._sends_ok += 1
                return True
            else:
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
        """Send an audio chunk description via agent RPC. Returns True on success."""
        if self._in_flight:
            self._sends_skipped += 1
            return False

        if not self.gateway.is_connected:
            self._sends_skipped += 1
            return False

        self._in_flight = True
        try:
            message = f"[sinain-wearable:audio] speech {chunk.duration_s:.1f}s"

            idem_key = f"audio-{uuid.uuid4().hex[:12]}"
            t0 = time.time()
            resp = await self.gateway.send_agent_rpc(message, idem_key)
            elapsed_ms = (time.time() - t0) * 1000
            self._latencies.append(elapsed_ms)

            if resp and resp.get("ok"):
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

    def add_audio_transcript(self, text: str, duration_s: float) -> None:
        """Record an audio transcript in the observation buffer."""
        if self._buffer is not None:
            self._buffer.add_audio(text, duration_s)

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
