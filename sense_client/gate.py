"""Decision gate — classifies sense events and decides what to send."""

import difflib
import time
from collections import deque
from dataclasses import dataclass, field

from .change_detector import ChangeResult
from .ocr import OCRResult


@dataclass
class SenseMeta:
    ssim: float = 0.0
    app: str = ""
    window_title: str = ""
    screen: int = 0


@dataclass
class SenseEvent:
    type: str  # "text" | "visual" | "context"
    ts: float = 0.0
    ocr: str = ""
    roi: dict | None = None
    diff: dict | None = None
    meta: SenseMeta = field(default_factory=SenseMeta)


class DecisionGate:
    """Classifies sense events and decides what to send."""

    def __init__(self, min_ocr_chars: int = 20,
                 major_change_threshold: float = 0.85,
                 cooldown_ms: int = 5000,
                 context_cooldown_ms: int = 10000):
        self.min_ocr_chars = min_ocr_chars
        self.major_change_threshold = major_change_threshold
        self.cooldown_ms = cooldown_ms
        self.context_cooldown_ms = context_cooldown_ms
        self.last_send_ts: float = 0
        self.last_context_ts: float = 0
        # Fuzzy dedup: ring buffer of last 5 OCR texts
        self._recent_texts: deque[str] = deque(maxlen=5)

    def _is_duplicate(self, text: str) -> bool:
        """Check if text is too similar to any recently sent text."""
        for prev in self._recent_texts:
            ratio = difflib.SequenceMatcher(None, prev, text).ratio()
            if ratio > 0.7:
                return True
        return False

    @staticmethod
    def _ocr_quality_ok(text: str) -> bool:
        """Reject garbage OCR: >50% single-char tokens or <50% alphanumeric."""
        tokens = text.split()
        if not tokens:
            return False
        single_char = sum(1 for t in tokens if len(t) == 1)
        if single_char / len(tokens) > 0.5:
            return False
        alnum = sum(1 for ch in text if ch.isalnum())
        total = len(text.replace(" ", ""))
        if total > 0 and alnum / total < 0.5:
            return False
        return True

    def classify(self, change: ChangeResult | None,
                 ocr: OCRResult, app_changed: bool,
                 window_changed: bool = False) -> SenseEvent | None:
        """Returns SenseEvent to send, or None to drop."""
        now = time.time() * 1000

        # Context events (app/window change) bypass normal cooldown
        if app_changed or window_changed:
            if now - self.last_context_ts >= self.context_cooldown_ms:
                self.last_context_ts = now
                self.last_send_ts = now
                return SenseEvent(type="context", ts=now)

        # Normal cooldown check
        if now - self.last_send_ts < self.cooldown_ms:
            return None

        if change is None:
            return None

        # OCR text sufficient -> text event
        if ocr.text and len(ocr.text) >= self.min_ocr_chars:
            if self._is_duplicate(ocr.text):
                return None
            if not self._ocr_quality_ok(ocr.text):
                return None
            self._recent_texts.append(ocr.text)
            self.last_send_ts = now
            return SenseEvent(type="text", ts=now, ocr=ocr.text,
                              meta=SenseMeta(ssim=change.ssim_score))

        # Major visual change -> visual event
        if change.ssim_score < self.major_change_threshold:
            self.last_send_ts = now
            return SenseEvent(type="visual", ts=now, ocr=ocr.text,
                              meta=SenseMeta(ssim=change.ssim_score))

        return None
