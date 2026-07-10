"""Vision Provider — surface wiring over the shared sinain-sense vision layer.

The contract (VisionResult, VisionProvider) and the OpenRouter backend live in
sinain-sense (transported by sinain-llm). This module keeps what is
sense_client-specific: the local Ollama backend and the create_vision factory
(privacy mode / env / config policy).

Usage:
    from .vision import create_vision
    provider = create_vision(config)
    if provider:
        scene = provider.describe(image, "What's on this screen?")
"""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING, Optional

from . import _pkg_boot  # noqa: F401 — puts sinain_sense on sys.path
from sinain_sense.vision import OpenRouterVisionProvider, VisionProvider, VisionResult

if TYPE_CHECKING:
    from PIL import Image

logger = logging.getLogger("sinain.vision")

__all__ = ["VisionResult", "VisionProvider", "OpenRouterVisionProvider",
           "OllamaVisionProvider", "create_vision"]


class OllamaVisionProvider(VisionProvider):
    """Local vision via Ollama HTTP API."""

    def __init__(self, model: str = "qwen2.5vl:7b", base_url: str = "http://localhost:11434",
                 timeout: float = 10.0, max_tokens: int = 200):
        from .ollama_vision import OllamaVision
        self._client = OllamaVision(model=model, base_url=base_url,
                                     timeout=timeout, max_tokens=max_tokens)
        self.name = f"ollama ({model})"

    def describe(self, image: "Image.Image", prompt: Optional[str] = None) -> VisionResult:
        return VisionResult(self._client.describe(image, prompt))

    def is_available(self) -> bool:
        return self._client.is_available()


def create_vision(config: dict) -> Optional[VisionProvider]:
    """Factory: create the appropriate vision provider based on config and environment.

    Priority:
    1. Paranoid privacy or no API key → local only (Ollama)
    2. SINAIN_LOCAL_MODE=true / SINAIN_LOCAL_VISION set → local (Ollama)
    3. API key available → cloud (OpenRouter)
    4. Nothing available → None (vision disabled, OCR still works)

    Env-var namespace: SINAIN_LOCAL_* is primary. The legacy LOCAL_VISION_*
    vars are still honored as a fallback for older .env files; sinain-core's
    config.ts also bridges SINAIN_LOCAL_* → LOCAL_VISION_* for compatibility.
    """
    privacy = os.environ.get("PRIVACY_MODE", "off")
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    vision_cfg = config.get("vision", {})

    # Primary: SINAIN_LOCAL_MODE / SINAIN_LOCAL_VISION. Legacy: LOCAL_VISION_*.
    local_enabled = (
        vision_cfg.get("enabled", False)
        or os.environ.get("SINAIN_LOCAL_MODE", "").lower() == "true"
        or bool(os.environ.get("SINAIN_LOCAL_VISION", ""))
        or os.environ.get("LOCAL_VISION_ENABLED", "").lower() == "true"
    )
    local_model = (
        os.environ.get("SINAIN_LOCAL_VISION")
        or os.environ.get("LOCAL_VISION_MODEL")
        or vision_cfg.get("model", "qwen2.5vl:7b")
    )
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
