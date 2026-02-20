"""Server-side vision analysis via OpenRouter vision API.

Sends camera frames as base64 JPEG to a fast vision model (Gemini Flash)
for combined scene description + text extraction. Falls back to no-op if
API key is missing.

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

_VISION_PROMPT = (
    "Analyze this image from a wearable camera.\n\n"
    "1. SCENE: Describe what you see. Include the setting, environment, "
    "notable objects, people, activities, signage, screens, colors, lighting, "
    "and anything noteworthy. Be detailed and specific.\n\n"
    "2. TEXT: Extract any visible text exactly as it appears, preserving "
    "line breaks and layout. If no text is visible, write: none\n\n"
    "Format your response exactly as:\n"
    "SCENE: [your description]\n"
    "TEXT: [extracted text or none]"
)


class OCREngine:
    """Async vision analysis via OpenRouter vision API."""

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
            log.info("Vision engine inactive (no api_key configured)")
        elif self.enabled:
            log.info("Vision engine ready (model=%s, timeout=%ds)",
                     self.model, self.timeout_s)
        else:
            log.info("Vision engine disabled in config")

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

    async def extract(self, frame: np.ndarray) -> tuple[str, str]:
        """Analyze frame via vision API. Returns (description, ocr_text).

        Returns ("", "") on failure/timeout/disabled.
        """
        if not self.enabled:
            return "", ""

        t0 = time.monotonic()
        try:
            raw = await asyncio.wait_for(
                self._call_vision(frame),
                timeout=self.timeout_s,
            )
            elapsed = time.monotonic() - t0
            self._total_calls += 1
            self._total_chars += len(raw)
            description, ocr_text = self._parse_response(raw)
            if description:
                log.info("Vision: %d chars in %.1fs (via %s)",
                         len(raw), elapsed, self.model)
            return description, ocr_text
        except asyncio.TimeoutError:
            log.warning("Vision timed out after %ds", self.timeout_s)
            return "", ""
        except Exception as e:
            log.warning("Vision error: %s", e)
            return "", ""

    @staticmethod
    def _parse_response(raw: str) -> tuple[str, str]:
        """Parse structured SCENE:/TEXT: response into (description, ocr_text)."""
        if not raw:
            return "", ""

        description, ocr_text = "", ""

        # Try to find SCENE: and TEXT: markers
        scene_idx = raw.find("SCENE:")
        text_idx = raw.find("TEXT:")

        if scene_idx != -1 and text_idx != -1 and text_idx > scene_idx:
            description = raw[scene_idx + 6:text_idx].strip()
            ocr_text = raw[text_idx + 5:].strip()
        elif scene_idx != -1:
            description = raw[scene_idx + 6:].strip()
        else:
            # Fallback: treat entire response as description
            description = raw.strip()

        # Normalize "none" OCR text to empty
        if ocr_text.lower() in ("none", "none."):
            ocr_text = ""

        return description, ocr_text

    async def _call_vision(self, frame: np.ndarray) -> str:
        """Send frame to OpenRouter vision API and return raw response."""
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
                    {"type": "text", "text": _VISION_PROMPT},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/jpeg;base64,{b64}",
                            "detail": "low",
                        },
                    },
                ],
            }],
            "max_tokens": 1000,
            "temperature": 0,
        }

        session = self._get_session()
        async with session.post(_OPENROUTER_URL, json=payload) as resp:
            if resp.status != 200:
                body = await resp.text()
                log.warning("Vision API error %d: %s", resp.status, body[:200])
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
            log.info("Vision shutdown: %d calls, %d total chars",
                     self._total_calls, self._total_chars)
