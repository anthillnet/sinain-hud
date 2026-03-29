"""OCR backends for UI text extraction: macOS Vision, Windows.Media.Ocr, and Tesseract."""

from __future__ import annotations

import io
import re
import sys
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

    def __init__(
        self,
        lang: str = "eng",
        psm: int = 11,
        min_confidence: int = 30,
        enabled: bool = True,
    ):
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
            print(f"[ocr] error: {e}", flush=True)
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

    def __init__(
        self,
        languages: list[str] | None = None,
        min_confidence: float = 0.5,
        enabled: bool = True,
    ):
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

            objc.loadBundle(
                "Vision",
                bundle_path="/System/Library/Frameworks/Vision.framework",
                module_globals=globals(),
            )
            self._available = True
        except Exception as e:
            print(f"[ocr] Vision framework unavailable: {e}", flush=True)

    def extract(self, image: Image.Image) -> OCRResult:
        """Returns extracted text using macOS Vision framework."""
        if not self.enabled or not self._available:
            return OCRResult(text="", confidence=0, word_count=0)

        try:
            return self._do_extract(image)
        except Exception as e:
            print(f"[ocr] Vision error: {e}", flush=True)
            return OCRResult(text="", confidence=0, word_count=0)

    def _do_extract(self, image: Image.Image) -> OCRResult:
        import objc
        import Quartz
        from Foundation import NSData

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
        request = VNRecognizeTextRequest.alloc().init()
        request.setRecognitionLevel_(0)  # VNRequestTextRecognitionLevelAccurate
        request.setRecognitionLanguages_(self.languages)
        request.setUsesLanguageCorrection_(True)

        # Execute
        handler = VNImageRequestHandler.alloc().initWithCGImage_options_(cg_image, None)
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


class WinOCR:
    """Windows.Media.Ocr backend via winrt-python (Windows 10+)."""

    def __init__(
        self, language: str = "en", min_confidence: float = 0.5, enabled: bool = True
    ):
        self.language = language
        self.min_confidence = min_confidence
        self.enabled = enabled
        self._available = False
        self._engine = None

        if not enabled:
            return

        try:
            from winrt.windows.globalization import Language
            from winrt.windows.media.ocr import OcrEngine

            lang = Language(language)
            if OcrEngine.is_language_supported(lang):
                self._engine = OcrEngine.try_create_from_language(lang)
                self._available = self._engine is not None
            else:
                print(f"[ocr] WinOCR: language '{language}' not supported", flush=True)
        except Exception as e:
            print(f"[ocr] WinOCR unavailable: {e}", flush=True)

    def extract(self, image: Image.Image) -> OCRResult:
        """Returns extracted text using Windows.Media.Ocr."""
        if not self.enabled or not self._available:
            return OCRResult(text="", confidence=0, word_count=0)

        try:
            return self._do_extract(image)
        except Exception as e:
            print(f"[ocr] WinOCR error: {e}", flush=True)
            return OCRResult(text="", confidence=0, word_count=0)

    def _do_extract(self, image: Image.Image) -> OCRResult:
        import asyncio

        from winrt.windows.graphics.imaging import (
            BitmapAlphaMode,
            BitmapPixelFormat,
            SoftwareBitmap,
        )
        from winrt.windows.storage.streams import (
            DataWriter,
            InMemoryRandomAccessStream,
        )

        # Convert PIL to BMP bytes and load as SoftwareBitmap
        buf = io.BytesIO()
        image.convert("RGBA").save(buf, format="BMP")
        bmp_bytes = buf.getvalue()

        async def _run():
            stream = InMemoryRandomAccessStream()
            writer = DataWriter(stream)
            writer.write_bytes(bmp_bytes)
            await writer.store_async()
            stream.seek(0)

            from winrt.windows.graphics.imaging import BitmapDecoder

            decoder = await BitmapDecoder.create_async(stream)
            bitmap = await decoder.get_software_bitmap_async()

            # Convert to supported pixel format if needed
            if bitmap.bitmap_pixel_format != BitmapPixelFormat.BGRA8:
                bitmap = SoftwareBitmap.convert(
                    bitmap, BitmapPixelFormat.BGRA8, BitmapAlphaMode.PREMULTIPLIED
                )

            result = await self._engine.recognize_async(bitmap)
            return result

        loop = asyncio.new_event_loop()
        try:
            result = loop.run_until_complete(_run())
        finally:
            loop.close()

        lines = []
        word_count = 0
        for line in result.lines:
            text = line.text.strip()
            if text:
                lines.append(text)
                word_count += len(text.split())

        text = "\n".join(lines)
        text = self._clean(text)

        return OCRResult(text=text, confidence=80.0, word_count=word_count)

    @staticmethod
    def _clean(text: str) -> str:
        text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)
        lines = text.split("\n")
        cleaned = []
        for line in lines:
            line = re.sub(r"[ \t]+", " ", line).strip()
            if line and re.search(r"[a-zA-Z0-9а-яА-ЯёЁ]", line):
                cleaned.append(line)
        return "\n".join(cleaned)


def create_ocr(config: dict):
    """Factory: create the best available OCR backend based on config + platform.

    config["ocr"] keys:
        backend: "auto" | "vision" | "tesseract" | "winocr"
        languages: list[str]  (BCP-47 for Vision / WinOCR, e.g. ["en", "ru"])
        lang: str             (Tesseract lang code, e.g. "eng")
        minConfidence: int    (0-100 scale)
        enabled: bool
    """
    ocr_cfg = config.get("ocr", {})
    backend = ocr_cfg.get("backend", "auto")
    enabled = ocr_cfg.get("enabled", True)

    # macOS: try Vision framework
    if sys.platform == "darwin" and backend in ("auto", "vision"):
        vision = VisionOCR(
            languages=ocr_cfg.get("languages", ["en", "ru"]),
            min_confidence=ocr_cfg.get("minConfidence", 50) / 100.0,
            enabled=enabled,
        )
        if vision._available:
            print(
                f"[ocr] using Vision backend (languages={vision.languages})", flush=True
            )
            return vision
        if backend == "vision":
            print(
                "[ocr] Vision requested but unavailable, falling back to Tesseract",
                flush=True,
            )

    # Windows: try Windows.Media.Ocr
    if sys.platform == "win32" and backend in ("auto", "winocr"):
        languages = ocr_cfg.get("languages", ["en"])
        winocr = WinOCR(
            language=languages[0] if languages else "en",
            min_confidence=ocr_cfg.get("minConfidence", 50) / 100.0,
            enabled=enabled,
        )
        if winocr._available:
            print(
                f"[ocr] using WinOCR backend (language={winocr.language})", flush=True
            )
            return winocr
        if backend == "winocr":
            print(
                "[ocr] WinOCR requested but unavailable, falling back to Tesseract",
                flush=True,
            )

    # Fallback to Tesseract (cross-platform)
    print("[ocr] using Tesseract backend", flush=True)
    return LocalOCR(
        lang=ocr_cfg.get("lang", "eng"),
        psm=ocr_cfg.get("psm", 11),
        min_confidence=ocr_cfg.get("minConfidence", 50),
        enabled=enabled,
    )
