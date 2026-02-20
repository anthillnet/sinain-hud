"""Tesseract OCR wrapper with async thread-pool execution.

Gracefully degrades to no-op if pytesseract or the tesseract binary is missing.
Uses a single-worker ThreadPoolExecutor to prevent saturating the Pi Zero CPU.
"""

from __future__ import annotations

import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np

log = logging.getLogger(__name__)

# Graceful import — OCR is optional
_TESSERACT_AVAILABLE = False
_TESSERACT_VERSION = ""
try:
    import pytesseract
    _TESSERACT_VERSION = pytesseract.get_tesseract_version().public
    _TESSERACT_AVAILABLE = True
    log.info("Tesseract OCR available: %s", _TESSERACT_VERSION)
except ImportError:
    log.warning("pytesseract not installed — OCR disabled")
except Exception as e:
    log.warning("Tesseract binary not found (%s) — OCR disabled", e)


class OCREngine:
    """Async Tesseract OCR with preprocessing and timeout guard."""

    def __init__(self, config: dict):
        ocr_cfg = config.get("ocr", {})
        self.enabled = ocr_cfg.get("enabled", True) and _TESSERACT_AVAILABLE
        self.lang = ocr_cfg.get("lang", "eng")
        self.timeout_s = ocr_cfg.get("timeout_s", 10)
        self.preprocess = ocr_cfg.get("preprocess", True)
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ocr")
        self._total_calls = 0
        self._total_chars = 0

        if self.enabled:
            log.info("OCR engine ready (lang=%s, timeout=%ds, preprocess=%s)",
                     self.lang, self.timeout_s, self.preprocess)
        else:
            reason = "disabled in config" if _TESSERACT_AVAILABLE else "tesseract unavailable"
            log.info("OCR engine inactive (%s)", reason)

    async def extract(self, frame: np.ndarray) -> str:
        """Extract text from a BGR frame. Returns empty string on failure/timeout."""
        if not self.enabled:
            return ""

        loop = asyncio.get_event_loop()
        try:
            text = await asyncio.wait_for(
                loop.run_in_executor(self._pool, self._extract_sync, frame),
                timeout=self.timeout_s,
            )
            self._total_calls += 1
            self._total_chars += len(text)
            if text:
                log.debug("OCR extracted %d chars in call #%d",
                          len(text), self._total_calls)
            return text
        except asyncio.TimeoutError:
            log.warning("OCR timed out after %ds", self.timeout_s)
            return ""
        except Exception as e:
            log.warning("OCR error: %s", e)
            return ""

    def _extract_sync(self, frame: np.ndarray) -> str:
        """Synchronous OCR — runs in thread pool."""
        t0 = time.monotonic()

        if self.preprocess:
            frame = self._preprocess(frame)

        # --psm 6: assume uniform block of text
        # --oem 3: best available OCR engine mode
        custom_config = f"--psm 6 --oem 3 -l {self.lang}"
        text = pytesseract.image_to_string(frame, config=custom_config)
        text = text.strip()

        elapsed = time.monotonic() - t0
        if text:
            log.info("OCR extracted %d chars in %.1fs", len(text), elapsed)
        return text

    def _preprocess(self, frame: np.ndarray) -> np.ndarray:
        """Adaptive threshold preprocessing for variable lighting."""
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        # Adaptive threshold handles mixed indoor/outdoor lighting
        processed = cv2.adaptiveThreshold(
            gray, 255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            blockSize=11,
            C=2,
        )
        return processed

    def shutdown(self) -> None:
        """Clean up the thread pool."""
        self._pool.shutdown(wait=False)
        if self._total_calls > 0:
            log.info("OCR shutdown: %d calls, %d total chars extracted",
                     self._total_calls, self._total_chars)
