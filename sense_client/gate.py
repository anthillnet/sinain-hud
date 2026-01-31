"""Decision gate — classifies sense events and decides what to send."""

import hashlib
import time
from dataclasses import dataclass, field

from .change_detector import ChangeResult
from .ocr import OCRResult


@dataclass
class SenseMeta:
    ssim: float = 0.0
    app: str = ""
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

    def __init__(self, min_ocr_chars: int = 10,
                 major_change_threshold: float = 0.85,
                 cooldown_ms: int = 2000):
        self.min_ocr_chars = min_ocr_chars
        self.major_change_threshold = major_change_threshold
        self.cooldown_ms = cooldown_ms
        self.last_send_ts: float = 0
        self.last_ocr_hash: str = ""

    def classify(self, change: ChangeResult | None,
                 ocr: OCRResult, app_changed: bool) -> SenseEvent | None:
        """Returns SenseEvent to send, or None to drop."""
        now = time.time() * 1000

        # Cooldown check
        if now - self.last_send_ts < self.cooldown_ms:
            return None

        # App switch -> context event
        if app_changed:
            self.last_send_ts = now
            return SenseEvent(type="context", ts=now)

        if change is None:
            return None

        # OCR text sufficient -> text event
        if ocr.text and len(ocr.text) >= self.min_ocr_chars:
            text_hash = hashlib.md5(ocr.text.encode()).hexdigest()
            if text_hash == self.last_ocr_hash:
                return None  # dedup
            self.last_ocr_hash = text_hash
            self.last_send_ts = now
            return SenseEvent(type="text", ts=now, ocr=ocr.text,
                              meta=SenseMeta(ssim=change.ssim_score))

        # Major visual change -> visual event
        if change.ssim_score < self.major_change_threshold:
            self.last_send_ts = now
            return SenseEvent(type="visual", ts=now, ocr=ocr.text,
                              meta=SenseMeta(ssim=change.ssim_score))

        return None
