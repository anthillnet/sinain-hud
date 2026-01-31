"""OCR backends for UI text extraction: macOS Vision (preferred) and Tesseract (fallback)."""

import io
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
            if line and re.search(r"[a-zA-Z0-9]", line):
                cleaned.append(line)
        return "\n".join(cleaned)


class VisionOCR:
    """macOS Vision framework OCR using pyobjc."""

    def __init__(self, languages: list[str] | None = None,
                 min_confidence: float = 0.5, enabled: bool = True):
        self.languages = languages or ["en", "ru"]
        self.min_confidence = min_confidence
        self.enabled = enabled
        self._available = False

        if not enabled:
            return

        try:
            import objc  # noqa: F401
            import Quartz  # noqa: F401
            from Foundation import NSURL, NSData  # noqa: F401
            objc.loadBundle('Vision', bundle_path='/System/Library/Frameworks/Vision.framework',
                            module_globals=globals())
            self._available = True
        except Exception as e:
            print(f"[ocr] Vision framework unavailable: {e}")

    def extract(self, image: Image.Image) -> OCRResult:
        """Returns extracted text using macOS Vision framework."""
        if not self.enabled or not self._available:
            return OCRResult(text="", confidence=0, word_count=0)

        try:
            return self._do_extract(image)
        except Exception as e:
            print(f"[ocr] Vision error: {e}")
            return OCRResult(text="", confidence=0, word_count=0)

    def _do_extract(self, image: Image.Image) -> OCRResult:
        import objc
        import Vision
        from Foundation import NSData
        import Quartz

        # Convert PIL Image to CGImage via PNG bytes
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        png_data = buf.getvalue()

        ns_data = NSData.dataWithBytes_length_(png_data, len(png_data))
        ci_image = Quartz.CIImage.imageWithData_(ns_data)
        context = Quartz.CIContext.context()
        cg_image = context.createCGImage_fromRect_(ci_image, ci_image.extent())

        if cg_image is None:
            return OCRResult(text="", confidence=0, word_count=0)

        # Create and configure request
        request = Vision.VNRecognizeTextRequest.alloc().init()
        request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
        request.setRecognitionLanguages_(self.languages)
        request.setUsesLanguageCorrection_(True)

        # Execute
        handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg_image, None)
        success = handler.performRequests_error_([request], objc.nil)
        if not success[0]:
            return OCRResult(text="", confidence=0, word_count=0)

        results = request.results()
        if not results:
            return OCRResult(text="", confidence=0, word_count=0)

        lines = []
        confidences = []
        word_count = 0

        for observation in results:
            candidate = observation.topCandidates_(1)
            if not candidate:
                continue
            text = candidate[0].string()
            conf = candidate[0].confidence()

            if conf < self.min_confidence:
                continue
            if text and text.strip():
                lines.append(text.strip())
                confidences.append(conf)
                word_count += len(text.split())

        text = "\n".join(lines)
        text = self._clean(text)
        avg_conf = (sum(confidences) / len(confidences) * 100) if confidences else 0

        return OCRResult(
            text=text,
            confidence=avg_conf,
            word_count=word_count,
        )

    @staticmethod
    def _clean(text: str) -> str:
        """Collapse whitespace, remove noise lines."""
        text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)
        lines = text.split("\n")
        cleaned = []
        for line in lines:
            line = re.sub(r"[ \t]+", " ", line).strip()
            if line and re.search(r"[a-zA-Z0-9а-яА-ЯёЁ]", line):
                cleaned.append(line)
        return "\n".join(cleaned)


def create_ocr(config: dict) -> LocalOCR | VisionOCR:
    """Factory: create the best available OCR backend based on config.

    config["ocr"] keys:
        backend: "auto" | "vision" | "tesseract"
        languages: list[str]  (BCP-47 for Vision, e.g. ["en", "ru"])
        lang: str             (Tesseract lang code, e.g. "eng")
        minConfidence: int    (0-100 scale)
        enabled: bool
    """
    ocr_cfg = config.get("ocr", {})
    backend = ocr_cfg.get("backend", "auto")
    enabled = ocr_cfg.get("enabled", True)

    if backend in ("auto", "vision"):
        vision = VisionOCR(
            languages=ocr_cfg.get("languages", ["en", "ru"]),
            min_confidence=ocr_cfg.get("minConfidence", 50) / 100.0,
            enabled=enabled,
        )
        if vision._available:
            print(f"[ocr] using Vision backend (languages={vision.languages})")
            return vision
        if backend == "vision":
            print("[ocr] Vision requested but unavailable, falling back to Tesseract")

    # Fallback to Tesseract
    print("[ocr] using Tesseract backend")
    return LocalOCR(
        lang=ocr_cfg.get("lang", "eng"),
        psm=ocr_cfg.get("psm", 11),
        min_confidence=ocr_cfg.get("minConfidence", 50),
        enabled=enabled,
    )
