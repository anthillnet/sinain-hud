"""Vision provider — abstract interface for image analysis backends.

VisionResult/VisionProvider are the shared contract; OpenRouterVisionProvider
rides sinain-llm for transport (one provider layer, cost extraction included).
Surface-specific backends (e.g. sense_client's Ollama /api/generate client)
subclass VisionProvider in their own repos.
"""

from __future__ import annotations

import base64
import io
import logging
import uuid
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from PIL import Image

logger = logging.getLogger("sinain.vision")


class VisionResult:
    """Result of a vision call: text + optional cost info."""
    __slots__ = ("text", "cost")

    def __init__(self, text: Optional[str], cost: Optional[dict] = None):
        self.text = text
        self.cost = cost  # {cost, tokens_in, tokens_out, model, cost_id}


class VisionProvider(ABC):
    """Abstract base for vision inference backends."""

    name: str = "unknown"

    @abstractmethod
    def describe(self, image: "Image.Image", prompt: Optional[str] = None) -> VisionResult:
        """Describe image content. Returns VisionResult (text may be None on failure)."""
        ...

    @abstractmethod
    def is_available(self) -> bool:
        """Check if the backend is reachable."""
        ...


class OpenRouterVisionProvider(VisionProvider):
    """Cloud vision via OpenRouter, transported by sinain-llm."""

    name = "openrouter"

    def __init__(self, api_key: str, model: str = "google/gemini-2.5-flash-lite",
                 timeout: float = 15.0, max_tokens: int = 200):
        self._api_key = api_key
        self._model = model
        self._timeout = timeout
        self._max_tokens = max_tokens
        self.name = f"openrouter ({model})"

    def describe(self, image: "Image.Image", prompt: Optional[str] = None) -> VisionResult:
        if not self._api_key:
            return VisionResult(None)

        try:
            import sinain_llm

            img_b64 = encode_image_b64(image)
            if not img_b64:
                return VisionResult(None)

            prompt_text = prompt or "Describe what's on this screen concisely (2-3 sentences)."

            result = sinain_llm.chat(
                model=self._model,
                max_tokens=self._max_tokens,
                timeout=self._timeout,
                api_key=self._api_key,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt_text},
                        {"type": "image_url", "image_url": {
                            "url": f"data:image/jpeg;base64,{img_b64}",
                            "detail": "low",
                        }},
                    ],
                }],
            )
            content = result["text"].strip()
            usage = result["usage"]
            logger.debug("openrouter vision: model=%s tokens=%s cost=%s",
                         self._model, usage.get("total_tokens", "?"), usage.get("cost", "?"))
            cost_info = None
            if usage.get("cost") is not None:
                cost_info = {
                    "cost": usage["cost"],
                    "tokens_in": usage.get("prompt_tokens") or 0,
                    "tokens_out": usage.get("completion_tokens") or 0,
                    "model": self._model,
                    "cost_id": uuid.uuid4().hex[:16],
                }
            return VisionResult(content if content else None, cost_info)

        except Exception as e:
            logger.debug("openrouter vision failed: %s", e)
            return VisionResult(None)

    def is_available(self) -> bool:
        return bool(self._api_key)


def encode_image_b64(image: "Image.Image", max_dim: int = 512, quality: int = 80) -> Optional[str]:
    """Downscale + JPEG-encode a PIL image to base64 for vision payloads."""
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
