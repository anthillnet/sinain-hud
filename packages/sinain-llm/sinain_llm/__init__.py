"""sinain-llm — unified LLM provider shim for sinain surfaces (L1 of DESIGN-SHARED-MODULES).

Providers by model id prefix: "ollama/<tag>" (local, keyless), "cerebras/<name>"
(CEREBRAS_API_KEY), anything else → OpenRouter (OPENROUTER_API_KEY).
"""

from .client import (
    LLMError,
    OLLAMA_MIN_TIMEOUT_S,
    CEREBRAS_URL,
    OPENROUTER_URL,
    call_llm,
    call_llm_with_fallback,
    chat,
)
from .json_utils import extract_json

__version__ = "0.1.0"

__all__ = [
    "LLMError",
    "call_llm",
    "call_llm_with_fallback",
    "chat",
    "extract_json",
    "OPENROUTER_URL",
    "CEREBRAS_URL",
    "OLLAMA_MIN_TIMEOUT_S",
    "__version__",
]
