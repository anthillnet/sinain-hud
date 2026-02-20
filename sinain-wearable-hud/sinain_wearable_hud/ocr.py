"""Server-side OCR via OpenRouter vision API.

Sends camera frames as base64 JPEG to a fast vision model (Gemini Flash)
for text extraction. Falls back to no-op if API key is missing.

This replaces the original local Tesseract approach which was too slow
on Pi Zero 2W (~20s per 1280x720 frame).
"""

from __future__ import annotations

import asyncio
import base64
import logging
import time

import aiohttp
import cv2
import numpy as np

log = logging.getLogger(__name__)

_OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

_OCR_PROMPT = (
    "Extract all visible text from this image exactly as it appears. "
    "Preserve line breaks and layout. Output only the extracted text, "
    "nothing else. If no text is visible, respond with an empty string."
)


class OCREngine:
    """Async OCR via OpenRouter vision API."""

    def __init__(self, config: dict):
        ocr_cfg = config.get("ocr", {})
        self.enabled = ocr_cfg.get("enabled", True)
        self.api_key = ocr_cfg.get("api_key", "")
        self.model = ocr_cfg.get("model", "google/gemini-2.5-flash")
        self.timeout_s = ocr_cfg.get("timeout_s", 15)
        self._session: aiohttp.ClientSession | None = None
        self._total_calls = 0
        self._total_chars = 0

        if not self.api_key:
            self.enabled = False
            log.info("OCR engine inactive (no api_key configured)")
        elif self.enabled:
            log.info("OCR engine ready (model=%s, timeout=%ds)",
                     self.model, self.timeout_s)
        else:
            log.info("OCR engine disabled in config")

    def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            # Use certifi CA bundle if available (fixes macOS SSL issues)
            connector = None
            try:
                import certifi
                import ssl
                ssl_ctx = ssl.create_default_context(cafile=certifi.where())
                connector = aiohttp.TCPConnector(ssl=ssl_ctx)
            except ImportError:
                pass  # system certs work fine on Linux/Pi
            self._session = aiohttp.ClientSession(
                connector=connector,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
            )
        return self._session

    async def extract(self, frame: np.ndarray) -> str:
        """Extract text from a BGR frame via vision API.

        Returns empty string on failure/timeout/disabled.
        """
        if not self.enabled:
            return ""

        t0 = time.monotonic()
        try:
            text = await asyncio.wait_for(
                self._call_vision(frame),
                timeout=self.timeout_s,
            )
            elapsed = time.monotonic() - t0
            self._total_calls += 1
            self._total_chars += len(text)
            if text:
                log.info("OCR extracted %d chars in %.1fs (via %s)",
                         len(text), elapsed, self.model)
            return text
        except asyncio.TimeoutError:
            log.warning("OCR timed out after %ds", self.timeout_s)
            return ""
        except Exception as e:
            log.warning("OCR error: %s", e)
            return ""

    async def _call_vision(self, frame: np.ndarray) -> str:
        """Send frame to OpenRouter vision API and return extracted text."""
        # Downscale to save bandwidth + API cost (detail: "low" anyway)
        h, w = frame.shape[:2]
        if w > 800:
            scale = 640 / w
            frame = cv2.resize(frame, (640, int(h * scale)),
                               interpolation=cv2.INTER_AREA)

        # Encode to JPEG
        _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
        b64 = base64.b64encode(buf.tobytes()).decode("ascii")

        payload = {
            "model": self.model,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": _OCR_PROMPT},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/jpeg;base64,{b64}",
                            "detail": "low",
                        },
                    },
                ],
            }],
            "max_tokens": 500,
            "temperature": 0,
        }

        session = self._get_session()
        async with session.post(_OPENROUTER_URL, json=payload) as resp:
            if resp.status != 200:
                body = await resp.text()
                log.warning("OCR API error %d: %s", resp.status, body[:200])
                return ""
            data = await resp.json()

        text = (data.get("choices", [{}])[0]
                .get("message", {})
                .get("content", "")
                .strip())
        return text

    async def shutdown(self) -> None:
        """Close the HTTP session."""
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None
        if self._total_calls > 0:
            log.info("OCR shutdown: %d calls, %d total chars extracted",
                     self._total_calls, self._total_chars)
