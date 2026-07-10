# sinain-llm

Unified LLM provider shim for all sinain surfaces — extraction step 1 (L1) of
[DESIGN-SHARED-MODULES](../../docs/DESIGN-SHARED-MODULES.md). Unifies:

- sinain-hud-2 `sinain-memory/common.py::call_llm` (OpenRouter + Ollama routing, strict/loose
  JSON modes, temperature/seed reproducibility, retry-with-backoff)
- ARSinain `vision.py` provider block (Cerebras, prompt prefix caching, OpenRouter provider routing)
- ARSinain `memory_v2/llm.py` (thin shim — superseded by this package)

## Provider selection

By model id prefix — no global provider switch:

| Model id | Provider | Auth |
|---|---|---|
| `ollama/<tag>` | local Ollama OpenAI-compat (`OLLAMA_BASE_URL`, default `http://localhost:11434`) | none |
| `cerebras/<name>` | Cerebras API | `CEREBRAS_API_KEY` |
| anything else | OpenRouter | `OPENROUTER_API_KEY` (or `OPENROUTER_API_KEY_REFLECTION`) |

## API

```python
from sinain_llm import call_llm, call_llm_with_fallback, chat, extract_json, LLMError

text = call_llm("system", "user", model="google/gemini-3-flash-preview")

# Full result with usage/cost (OpenRouter reports usage.cost when enabled):
res = chat("system", "user", model="cerebras/gemma-4-31b", cache_key="arsinain-help-v2")
res["text"], res["model"], res["usage"]  # usage: prompt/completion/total tokens + cost

# Retry the primary, then walk a fallback chain (ANALYSIS_FALLBACK_MODELS semantics):
text = call_llm_with_fallback("system", "user", model="google/gemini-3-flash-preview",
                              retries=1, fallback_models=["anthropic/claude-3.5-haiku"])

data = extract_json(text)  # tolerant JSON extraction from messy LLM output
```

Options: `json_schema` (strict structured output; also sets Ollama-native `format`),
`json_mode` (loose `json_object` — OpenAI/Google/Ollama/Cerebras), `temperature`, `seed`,
`timeout` (floored at 120 s for local Ollama), `cache_key` (Cerebras `prompt_cache_key`),
`provider_routing` (OpenRouter `provider` dict), `messages` (full message-array override,
e.g. multimodal content — replaces the system/user convenience pair).

## Consumers

- `sinain-hud-plugin/sinain-memory/common.py` — this package IS its transport (dev monorepo
  and npm layouts are auto-resolved; `SINAIN_LLM_DIR` overrides). common.py adds only
  sinain-memory config on top: `llm-config.json` per-script model/token resolution.
- ARSinain: replaces `memory_v2/llm.py` and the ad-hoc calls in `search_agent.py` (adoption
  tracked in DESIGN-SHARED-MODULES §6).
