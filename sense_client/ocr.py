"""Tesseract OCR wrapper for UI text extraction."""

import re
from dataclasses import dataclass

from PIL import Image

try:
    import pytesseract
except ImportError:
    pytesseract = None


@dataclass
class OCRResult:
    text: str
    confidence: float
    word_count: int


class LocalOCR:
    """Tesseract OCR wrapper for UI text extraction."""

    def __init__(self, lang: str = "eng", psm: int = 11,
                 min_confidence: int = 30, enabled: bool = True):
        self.lang = lang
        self.psm = psm
        self.min_confidence = min_confidence
        self.enabled = enabled

    def extract(self, image: Image.Image) -> OCRResult:
        """Returns extracted text with confidence."""
        if not self.enabled or pytesseract is None:
            return OCRResult(text="", confidence=0, word_count=0)

        try:
            data = pytesseract.image_to_data(
                image,
                lang=self.lang,
                config=f"--psm {self.psm}",
                output_type=pytesseract.Output.DICT,
            )
        except Exception as e:
            print(f"[ocr] error: {e}")
            return OCRResult(text="", confidence=0, word_count=0)

        words = []
        confidences = []
        for i, conf in enumerate(data["conf"]):
            try:
                c = int(conf)
            except (ValueError, TypeError):
                continue
            if c >= self.min_confidence:
                word = data["text"][i].strip()
                if word:
                    words.append(word)
                    confidences.append(c)

        text = " ".join(words)
        text = self._clean(text)
        avg_conf = sum(confidences) / len(confidences) if confidences else 0

        return OCRResult(
            text=text,
            confidence=avg_conf,
            word_count=len(words),
        )

    @staticmethod
    def _clean(text: str) -> str:
        """Strip control chars, collapse whitespace, remove noise lines."""
        text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)
        text = re.sub(r"[ \t]+", " ", text)
        lines = text.split("\n")
        cleaned = []
        for line in lines:
            line = line.strip()
            # Skip lines that are all symbols/noise
            if line and re.search(r"[a-zA-Z0-9]", line):
                cleaned.append(line)
        return "\n".join(cleaned)
