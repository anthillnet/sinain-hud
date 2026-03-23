"""Ollama Vision — local multimodal inference for screen scene understanding.

Provides a thin client for Ollama's vision models (llava, llama3.2-vision,
moondream, nanollava). Used by sense_client for scene descriptions and
optionally by sinain-core's agent analyzer for local vision analysis.

Falls back gracefully when Ollama is unavailable — never crashes the pipeline.
"""

import base64
import io
import json
import logging
import time
from typing import Optional

try:
    from PIL import Image
except ImportError:
    Image = None  # type: ignore

logger = logging.getLogger("sinain.vision")

DEFAULT_PROMPT = (
    "Describe what's on this screen: the application, UI state, any errors "
    "or notable content. Be concise (2-3 sentences)."
)


class OllamaVision:
    """Local vision inference via Ollama HTTP API.

    Uses the /api/chat endpoint with image support. Auto-encodes PIL images
    to base64 JPEG. Returns None on any failure (timeout, connection error,
    model not loaded).
    """

    def __init__(
        self,
        model: str = "llava",
        base_url: str = "http://localhost:11434",
        timeout: float = 10.0,
        max_tokens: int = 200,
    ):
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_tokens = max_tokens
        self._available: Optional[bool] = None
        self._last_check: float = 0
        self._check_interval = 30.0  # re-check availability every 30s

    def is_available(self) -> bool:
        """Check if Ollama server is reachable. Caches result for 30s."""
        now = time.time()
        if self._available is not None and now - self._last_check < self._check_interval:
            return self._available

        try:
            import urllib.request
            req = urllib.request.Request(f"{self.base_url}/api/tags", method="GET")
            with urllib.request.urlopen(req, timeout=2) as resp:
                self._available = resp.status == 200
        except Exception:
            self._available = False

        self._last_check = now
        return self._available

    def describe(
        self,
        image: "Image.Image",
        prompt: Optional[str] = None,
    ) -> Optional[str]:
        """Describe image content using the local vision model.

        Args:
            image: PIL Image to analyze
            prompt: Custom prompt (defaults to screen description prompt)

        Returns:
            Text description or None on failure/timeout.
        """
        if not self.is_available():
            return None

        try:
            # Encode image to base64 JPEG
            img_b64 = self._encode_image(image)
            if not img_b64:
                return None

            # Build Ollama /api/chat request
            payload = {
                "model": self.model,
                "messages": [
                    {
                        "role": "user",
                        "content": prompt or DEFAULT_PROMPT,
                        "images": [img_b64],
                    }
                ],
                "stream": False,
                "options": {
                    "num_predict": self.max_tokens,
                },
            }

            import urllib.request
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                f"{self.base_url}/api/chat",
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )

            t0 = time.time()
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                result = json.loads(resp.read().decode("utf-8"))

            content = result.get("message", {}).get("content", "").strip()
            latency_ms = int((time.time() - t0) * 1000)
            logger.debug(
                "ollama vision: model=%s latency=%dms tokens=%s",
                self.model,
                latency_ms,
                result.get("eval_count", "?"),
            )
            return content if content else None

        except Exception as e:
            logger.debug("ollama vision failed: %s", e)
            # Mark unavailable on connection errors so we don't retry every frame
            if "Connection refused" in str(e) or "timed out" in str(e):
                self._available = False
                self._last_check = time.time()
            return None

    def _encode_image(self, image: "Image.Image", max_dim: int = 512, quality: int = 80) -> Optional[str]:
        """Encode PIL Image to base64 JPEG string for Ollama."""
        try:
            # Resize if too large
            w, h = image.size
            if max(w, h) > max_dim:
                scale = max_dim / max(w, h)
                image = image.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

            # Convert RGBA to RGB
            if image.mode == "RGBA":
                bg = Image.new("RGB", image.size, (255, 255, 255))
                bg.paste(image, mask=image.split()[3])
                image = bg
            elif image.mode != "RGB":
                image = image.convert("RGB")

            buf = io.BytesIO()
            image.save(buf, format="JPEG", quality=quality)
            return base64.b64encode(buf.getvalue()).decode("ascii")
        except Exception as e:
            logger.debug("image encoding failed: %s", e)
            return None
