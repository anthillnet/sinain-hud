"""Unified chat-completions client for OpenRouter / Cerebras / Ollama.

Provider is selected by model id prefix ("ollama/", "cerebras/", else OpenRouter)
so one call site can be pointed at any provider by configuration alone. Behavior
is a strict superset of the two donor implementations (sinain-memory common.py,
ARSinain vision.py) — see README for the mapping.
"""

from __future__ import annotations

import json
import os
import sys

import requests

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
CEREBRAS_URL = "https://api.cerebras.ai/v1/chat/completions"

# Local Ollama timeouts are longer than cloud — small models can stall.
OLLAMA_MIN_TIMEOUT_S = 120.0


class LLMError(Exception):
    """Raised when the LLM API call fails (timeout, network, bad/empty response)."""


def _ollama_chat_url() -> str:
    base = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
    return f"{base.rstrip('/')}/v1/chat/completions"


def _resolve_provider(model: str, api_key: str | None = None) -> tuple[str, str, str, dict]:
    """Return (provider, url, target_model, headers) for a model id.

    *api_key* overrides the provider's env var (callers that carry their own
    credential, e.g. vision providers constructed with an explicit key)."""
    if model.startswith("ollama/"):
        return "ollama", _ollama_chat_url(), model[len("ollama/"):], {
            "Content-Type": "application/json",
        }
    if model.startswith("cerebras/"):
        key = api_key or os.environ.get("CEREBRAS_API_KEY")
        if not key:
            raise RuntimeError("CEREBRAS_API_KEY env var is not set")
        return "cerebras", CEREBRAS_URL, model[len("cerebras/"):], {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }
    key = api_key or os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_API_KEY_REFLECTION")
    if not key:
        raise RuntimeError("OPENROUTER_API_KEY or OPENROUTER_API_KEY_REFLECTION env var is not set")
    return "openrouter", OPENROUTER_URL, model, {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


# Bound keywords Cerebras structured outputs reject with a 400 ("Invalid
# fields for schema with types ['string']: {'minLength', 'maxLength'}",
# "... ['array']: {'maxItems'}"). Dropping bounds only loosens validation —
# the shape constraint (the part callers rely on) survives.
_CEREBRAS_UNSUPPORTED = frozenset((
    "minLength", "maxLength",
    "minItems", "maxItems",
    "minimum", "maximum",
    "minProperties", "maxProperties",
))


def _cerebras_schema(schema: dict) -> dict:
    """Deep-copy *schema* without the bound keywords Cerebras rejects.

    Also rewrites ``oneOf`` → ``anyOf`` ("Unsupported JSON schema fields ...
    dict_keys(['oneOf'])"): for constrained generation the two are equivalent
    — the generator emits one branch either way."""
    if isinstance(schema, dict):
        return {
            ("anyOf" if k == "oneOf" else k): _cerebras_schema(v)
            for k, v in schema.items()
            if k not in _CEREBRAS_UNSUPPORTED
        }
    if isinstance(schema, list):
        return [_cerebras_schema(v) for v in schema]
    return schema


def chat(
    system_prompt: str = "",
    user_prompt: str = "",
    model: str = "",
    max_tokens: int = 1500,
    *,
    json_mode: bool = False,
    json_schema: dict | None = None,
    temperature: float | None = None,
    seed: int | None = None,
    timeout: float = 60.0,
    cache_key: str | None = None,
    provider_routing: dict | None = None,
    messages: list[dict] | None = None,
    extra_body: dict | None = None,
    api_key: str | None = None,
) -> dict:
    """One chat-completions call. Returns {"text", "model", "usage"}.

    ``usage`` is {"prompt_tokens", "completion_tokens", "total_tokens", "cost"}
    (cost is None unless the provider reports it — OpenRouter does with usage
    accounting enabled). ``messages`` overrides the system/user convenience pair
    for full message arrays (e.g. multimodal image content).

    JSON control: *json_schema* forces STRICT structured output
    (``response_format: {"type": "json_schema", ...}``; Ollama additionally gets
    the schema via its native top-level ``format`` field so the constraint
    sticks whichever path the runtime takes). *json_mode* (loose
    ``json_object``) applies on OpenAI/Google models, Ollama, and Cerebras.

    *cache_key* → Cerebras ``prompt_cache_key`` (ignored elsewhere).
    *provider_routing* → OpenRouter ``provider`` routing dict (ignored elsewhere).
    *extra_body* → merged into the request body last (provider extensions the
    shim doesn't model, e.g. OpenRouter ``plugins`` for web search).
    *seed* + *temperature*=0 make greedy decoding repeatable where honored.
    """
    if not model:
        raise ValueError("model is required")
    provider, url, target_model, headers = _resolve_provider(model, api_key)

    if provider == "ollama" and timeout < OLLAMA_MIN_TIMEOUT_S:
        timeout = OLLAMA_MIN_TIMEOUT_S

    body: dict = {
        "model": target_model,
        "max_tokens": max_tokens,
        "messages": messages if messages is not None else [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    if temperature is not None:
        body["temperature"] = temperature
    if seed is not None:
        body["seed"] = seed

    if provider == "openrouter" and provider_routing:
        body["provider"] = provider_routing
    if provider == "cerebras" and cache_key:
        body["prompt_cache_key"] = cache_key

    if json_schema is not None:
        sent_schema = _cerebras_schema(json_schema) if provider == "cerebras" else json_schema
        body["response_format"] = {
            "type": "json_schema",
            "json_schema": {
                "name": json_schema.get("title", "output"),
                "schema": sent_schema,
                "strict": True,
            },
        }
        if provider == "ollama":
            body["format"] = json_schema
    elif json_mode and (
        provider in ("ollama", "cerebras")
        or model.startswith("openai/")
        or model.startswith("google/")
    ):
        body["response_format"] = {"type": "json_object"}

    if extra_body:
        body.update(extra_body)

    try:
        resp = requests.post(url, headers=headers, json=body, timeout=timeout)
        resp.raise_for_status()
        data = resp.json()
    except requests.exceptions.RequestException as e:
        raise LLMError(f"LLM call failed ({type(e).__name__}): {e}") from e
    except json.JSONDecodeError as e:
        raise LLMError(f"LLM returned non-JSON response body: {e}") from e

    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise LLMError(f"LLM response missing choices/message (model={model}): {e}") from e
    if not content:
        raise LLMError(f"LLM returned empty response (model={model})")

    raw_usage = data.get("usage") or {}
    usage = {
        "prompt_tokens": raw_usage.get("prompt_tokens"),
        "completion_tokens": raw_usage.get("completion_tokens"),
        "total_tokens": raw_usage.get("total_tokens"),
        "cost": raw_usage.get("cost"),
    }
    return {"text": content, "model": model, "usage": usage}


def call_llm(
    system_prompt: str,
    user_prompt: str,
    model: str,
    max_tokens: int = 1500,
    *,
    json_mode: bool = False,
    json_schema: dict | None = None,
    temperature: float | None = None,
    seed: int | None = None,
    timeout: float = 60.0,
    cache_key: str | None = None,
    provider_routing: dict | None = None,
    messages: list[dict] | None = None,
    extra_body: dict | None = None,
) -> str:
    """chat() returning just the assistant text, with the ``[tokens]`` stderr
    line consumers already scrape for cost tracking."""
    result = chat(
        system_prompt, user_prompt, model, max_tokens,
        json_mode=json_mode, json_schema=json_schema,
        temperature=temperature, seed=seed, timeout=timeout,
        cache_key=cache_key, provider_routing=provider_routing, messages=messages,
        extra_body=extra_body,
    )
    usage = result["usage"]
    if any(v is not None for v in usage.values()):
        print(
            f"[tokens] model={model} prompt={usage['prompt_tokens'] if usage['prompt_tokens'] is not None else '?'} "
            f"completion={usage['completion_tokens'] if usage['completion_tokens'] is not None else '?'} "
            f"total={usage['total_tokens'] if usage['total_tokens'] is not None else '?'}",
            file=sys.stderr,
        )
    return result["text"]


def call_llm_with_fallback(
    system_prompt: str,
    user_prompt: str,
    model: str,
    max_tokens: int = 1500,
    *,
    retries: int = 1,
    fallback_models: list[str] | None = None,
    **kwargs,
) -> str:
    """call_llm with retry + fallback chain (ANALYSIS_FALLBACK_MODELS semantics).

    The primary model gets 1 + *retries* attempts with exponential backoff
    (1 s, 2 s, 4 s…); on exhaustion each fallback model is tried once, in order.
    Raises the last LLMError if the whole chain fails. RuntimeError from a
    missing API key is NOT retried — configuration won't fix itself.
    """
    import time

    last_err: LLMError | None = None
    for attempt in range(1 + retries):
        try:
            return call_llm(system_prompt, user_prompt, model, max_tokens, **kwargs)
        except LLMError as e:
            last_err = e
            if attempt < retries:
                wait = 2 ** attempt
                print(f"[retry] attempt {attempt + 1} failed: {e} — retrying in {wait}s",
                      file=sys.stderr)
                time.sleep(wait)
    for fb in fallback_models or []:
        print(f"[fallback] {model} exhausted — trying {fb}", file=sys.stderr)
        try:
            return call_llm(system_prompt, user_prompt, fb, max_tokens, **kwargs)
        except LLMError as e:
            last_err = e
    assert last_err is not None
    raise last_err
