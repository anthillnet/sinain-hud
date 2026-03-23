"""Vision Provider — abstract interface for local and cloud image analysis.

Routes vision requests to either Ollama (local) or OpenRouter (cloud) based
on configuration, privacy mode, and API key availability.

Usage:
    from .vision import create_vision
    provider = create_vision(config)
    if provider:
        scene = provider.describe(image, "What's on this screen?")
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import time
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from PIL import Image

logger = logging.getLogger("sinain.vision")


class VisionProvider(ABC):
    """Abstract base for vision inference backends."""

    name: str = "unknown"

    @abstractmethod
    def describe(self, image: "Image.Image", prompt: Optional[str] = None) -> Optional[str]:
        """Describe image content. Returns None on failure."""
        ...

    @abstractmethod
    def is_available(self) -> bool:
        """Check if the backend is reachable."""
        ...


class OllamaVisionProvider(VisionProvider):
    """Local vision via Ollama HTTP API."""

    def __init__(self, model: str = "llava", base_url: str = "http://localhost:11434",
                 timeout: float = 10.0, max_tokens: int = 200):
        from .ollama_vision import OllamaVision
        self._client = OllamaVision(model=model, base_url=base_url,
                                     timeout=timeout, max_tokens=max_tokens)
        self.name = f"ollama ({model})"

    def describe(self, image: "Image.Image", prompt: Optional[str] = None) -> Optional[str]:
        return self._client.describe(image, prompt)

    def is_available(self) -> bool:
        return self._client.is_available()


class OpenRouterVisionProvider(VisionProvider):
    """Cloud vision via OpenRouter API."""

    name = "openrouter"

    def __init__(self, api_key: str, model: str = "google/gemini-2.5-flash-lite",
                 timeout: float = 15.0, max_tokens: int = 200):
        self._api_key = api_key
        self._model = model
        self._timeout = timeout
        self._max_tokens = max_tokens
        self.name = f"openrouter ({model})"

    def describe(self, image: "Image.Image", prompt: Optional[str] = None) -> Optional[str]:
        if not self._api_key:
            return None

        try:
            import requests

            # Encode image
            img_b64 = self._encode(image)
            if not img_b64:
                return None

            prompt_text = prompt or "Describe what's on this screen concisely (2-3 sentences)."

            resp = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self._model,
                    "max_tokens": self._max_tokens,
                    "messages": [{
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt_text},
                            {"type": "image_url", "image_url": {
                                "url": f"data:image/jpeg;base64,{img_b64}",
                                "detail": "low",
                            }},
                        ],
                    }],
                },
                timeout=self._timeout,
            )
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"].strip()
            logger.debug("openrouter vision: model=%s tokens=%s",
                         self._model, data.get("usage", {}).get("total_tokens", "?"))
            return content if content else None

        except Exception as e:
            logger.debug("openrouter vision failed: %s", e)
            return None

    def is_available(self) -> bool:
        return bool(self._api_key)

    @staticmethod
    def _encode(image: "Image.Image", max_dim: int = 512, quality: int = 80) -> Optional[str]:
        try:
            from PIL import Image as PILImage

            w, h = image.size
            if max(w, h) > max_dim:
                scale = max_dim / max(w, h)
                image = image.resize((int(w * scale), int(h * scale)), PILImage.LANCZOS)

            if image.mode == "RGBA":
                bg = PILImage.new("RGB", image.size, (255, 255, 255))
                bg.paste(image, mask=image.split()[3])
                image = bg
            elif image.mode != "RGB":
                image = image.convert("RGB")

            buf = io.BytesIO()
            image.save(buf, format="JPEG", quality=quality)
            return base64.b64encode(buf.getvalue()).decode("ascii")
        except Exception:
            return None


def create_vision(config: dict) -> Optional[VisionProvider]:
    """Factory: create the appropriate vision provider based on config and environment.

    Priority:
    1. Paranoid privacy or no API key → local only (Ollama)
    2. LOCAL_VISION_ENABLED=true → local (Ollama)
    3. API key available → cloud (OpenRouter)
    4. Nothing available → None (vision disabled, OCR still works)
    """
    privacy = os.environ.get("PRIVACY_MODE", "off")
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    vision_cfg = config.get("vision", {})

    local_enabled = (
        vision_cfg.get("enabled", False)
        or os.environ.get("LOCAL_VISION_ENABLED", "").lower() == "true"
    )
    local_model = os.environ.get("LOCAL_VISION_MODEL", vision_cfg.get("model", "llava"))
    local_url = vision_cfg.get("ollamaUrl", "http://localhost:11434")
    local_timeout = vision_cfg.get("timeout", 10.0)

    cloud_blocked = privacy in ("paranoid", "strict") or not api_key

    # Local vision preferred when enabled or when cloud is blocked
    if local_enabled:
        provider = OllamaVisionProvider(
            model=local_model, base_url=local_url, timeout=local_timeout,
        )
        if provider.is_available():
            return provider
        logger.info("Ollama not available, %s",
                     "vision disabled (cloud blocked)" if cloud_blocked else "falling back to OpenRouter")
        if cloud_blocked:
            return None

    # Cloud vision (only if not blocked)
    if not cloud_blocked:
        return OpenRouterVisionProvider(api_key=api_key)

    return None
