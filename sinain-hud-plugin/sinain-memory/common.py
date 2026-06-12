"""Shared utilities for sinain-koog heartbeat scripts.

Centralizes OpenRouter API calls, memory/ file readers, and JSON output.
"""

import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from glob import glob
from pathlib import Path

import requests

MODEL_FAST = "google/gemini-3-flash-preview"
MODEL_SMART = "anthropic/claude-sonnet-4.6"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

# Local Ollama OpenAI-compatible endpoint. Model IDs prefixed with "ollama/"
# route here instead of OpenRouter (no API key needed). See docs/local-mode.md
# for the paranoid-mode wiring; this is the bench-side equivalent that lets
# SINAIN_BENCH_MODEL=ollama/phi4-mini route the distiller + QA locally.
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_CHAT_URL = f"{OLLAMA_BASE_URL.rstrip('/')}/v1/chat/completions"


class LLMError(Exception):
    """Raised when the LLM API call fails (timeout, network, bad response)."""
    pass


def load_sentence_transformer(name: str = "all-MiniLM-L6-v2"):
    """Load a sentence-transformers model without contacting the HF Hub.

    Privacy: huggingface_hub pings the Hub for repo metadata on every model
    load (the "unauthenticated requests to the HF Hub" warning) even when the
    weights are fully cached. When the model is already in the local cache we
    force offline mode so nothing leaves the machine; the first-ever run
    still downloads normally. The env vars must be set BEFORE huggingface_hub
    is imported — some versions read them into constants at import time — so
    call this instead of importing sentence_transformers directly.
    """
    repo = name if "/" in name else f"sentence-transformers/{name}"
    cache_root = Path(os.environ.get("HF_HOME") or Path.home() / ".cache" / "huggingface")
    cached = (cache_root / "hub" / ("models--" + repo.replace("/", "--"))).exists()
    if cached:
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    # Progress bars are noise when these scripts run as sinain-core children
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    from sentence_transformers import SentenceTransformer
    return SentenceTransformer(name)


# ---------------------------------------------------------------------------
# Robust JSON extraction from LLM responses
# ---------------------------------------------------------------------------

def extract_json(text: str) -> dict | list:
    """Extract a JSON object or array from potentially messy LLM output.

    Three-stage extraction:
      1. Direct json.loads (clean case)
      2. Regex extraction from markdown code fences
      3. Balanced-brace scanner for JSON embedded in prose

    Raises ValueError if no valid JSON can be extracted.
    """
    text = text.strip()

    # Stage 1: direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Stage 2: markdown code fences  ```json ... ```  or  ``` ... ```
    fence_match = re.search(r"```(?:json)?\s*\n?(.*?)```", text, re.DOTALL)
    if fence_match:
        try:
            return json.loads(fence_match.group(1).strip())
        except json.JSONDecodeError:
            pass

    # Stage 3+4: balanced-brace scanner with truncated JSON repair
    # Uses a full bracket stack so nested {/[ are tracked together.
    for open_ch, close_ch in (("{", "}"), ("[", "]")):
        start = text.find(open_ch)
        if start == -1:
            continue
        stack: list[str] = []
        in_string = False
        escape = False
        string_start = -1
        for i in range(start, len(text)):
            ch = text[i]
            if escape:
                escape = False
                continue
            if ch == "\\":
                if in_string:
                    escape = True
                continue
            if ch == '"':
                if not in_string:
                    string_start = i
                in_string = not in_string
                continue
            if in_string:
                continue
            if ch in ("{", "["):
                stack.append("}" if ch == "{" else "]")
            elif ch in ("}", "]"):
                if stack:
                    stack.pop()
                if not stack:
                    try:
                        return json.loads(text[start : i + 1])
                    except json.JSONDecodeError:
                        break  # malformed — try next bracket type
        else:
            # Reached end of text with unclosed brackets — attempt repair
            if not stack:
                continue
            closers = "".join(reversed(stack))
            fragment = text[start:]

            # Strategy A: if mid-string, close it then close all brackets
            if in_string:
                try:
                    return json.loads(fragment + '"' + closers)
                except json.JSONDecodeError:
                    pass

            # Strategy B: strip trailing incomplete tokens, close brackets
            stripped = re.sub(r'[,:\s]+$', '', fragment)
            try:
                return json.loads(stripped + closers)
            except json.JSONDecodeError:
                pass

            # Strategy C: if mid-string, cut before the unclosed string,
            # strip trailing tokens, close brackets
            if in_string and string_start >= start:
                before_str = text[start:string_start]
                before_str = re.sub(r'[,:\s]+$', '', before_str)
                try:
                    return json.loads(before_str + closers)
                except json.JSONDecodeError:
                    pass

    raise ValueError(f"No valid JSON found in LLM response ({len(text)} chars): {text[:120]}...")


# ---------------------------------------------------------------------------
# External config (koog-config.json)
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _load_config() -> dict:
    """Load koog-config.json from the same directory as this module. Cached."""
    config_path = Path(__file__).resolve().parent / "koog-config.json"
    try:
        return json.loads(config_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        print(f"[warn] koog-config.json not loaded: {exc}", file=sys.stderr)
        return {}


def _resolve_model(logical_name: str) -> str:
    """Map a logical model name ('fast'/'smart') to an actual model ID.

    Env-var overrides take precedence over koog-config.json so the bench
    harness can route a single script-call site (e.g. session_distiller's
    `script="session_distiller"` → model="fast") to a different model per
    run. Used by ingest.py to thread SINAIN_BENCH_MODEL through to the
    distiller subprocess as SINAIN_FAST_MODEL.
    """
    env_key = f"SINAIN_{logical_name.upper()}_MODEL"
    env_override = os.environ.get(env_key)
    if env_override:
        return env_override
    cfg = _load_config()
    models = cfg.get("models", {})
    return models.get(logical_name, logical_name)


def call_llm(
    system_prompt: str,
    user_prompt: str,
    model: str = MODEL_FAST,
    max_tokens: int = 1500,
    *,
    script: str | None = None,
    json_mode: bool = False,
    json_schema: dict | None = None,
    temperature: float | None = None,
    seed: int | None = None,
) -> str:
    """Call OpenRouter chat completions API. Returns assistant message text.

    When *script* is provided, model and max_tokens are overridden from
    koog-config.json (external config the bot cannot modify).

    When *json_schema* is provided, the request uses STRICT structured-output
    mode (``response_format: {"type": "json_schema", ...}``) — model output is
    forced to conform to the schema. Used to prevent local distillers
    (phi4-mini, gemma4:e2b, qwen2.5:7b) from emitting session summaries when
    asked for a facts[] list. Falls back gracefully if the provider rejects
    the schema (Ollama may not support all JSON Schema features).

    When *json_mode* is True (and no schema given), uses the older loose
    ``response_format: {"type": "json_object"}`` mode for OpenAI/Google/Ollama.

    *temperature*: deterministic-judging knob used by the LongMemEval paper-
    standard judge (temperature=0.0 for reproducibility). When omitted, the
    provider default applies (no temperature key in the request body).
    """
    timeout_s = 60
    if script:
        cfg = _load_config()
        script_cfg = cfg.get("scripts", {}).get(script, cfg.get("defaults", {}))
        model = _resolve_model(script_cfg.get("model", "fast"))
        max_tokens = script_cfg.get("maxTokens", max_tokens)
        timeout_s = script_cfg.get("timeout", cfg.get("defaults", {}).get("timeout", 60))

    # Route based on model id. "ollama/<model>" → local Ollama; else OpenRouter.
    is_ollama = model.startswith("ollama/")
    if is_ollama:
        target_url = OLLAMA_CHAT_URL
        target_model = model[len("ollama/"):]  # strip prefix for Ollama API
        request_headers = {"Content-Type": "application/json"}
        # Local Ollama timeouts are longer than cloud — small models can stall.
        if timeout_s < 120:
            timeout_s = 120
    else:
        api_key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_API_KEY_REFLECTION")
        if not api_key:
            raise RuntimeError("OPENROUTER_API_KEY or OPENROUTER_API_KEY_REFLECTION env var is not set")
        target_url = OPENROUTER_URL
        target_model = model
        request_headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

    body: dict = {
        "model": target_model,
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    if temperature is not None:
        body["temperature"] = temperature
    # Reproducibility: a fixed seed + temperature=0 makes greedy decoding
    # repeatable (OpenRouter passes seed to providers that honor it; Ollama's
    # OpenAI-compat endpoint maps it to options.seed). Without it, eval QA
    # answers jitter run-to-run on borderline questions even at temp=0, which
    # makes n=6 paper_label deltas indistinguishable from noise.
    if seed is not None:
        body["seed"] = seed
    # Structured output. json_schema (strict) takes precedence over json_mode
    # (loose). OpenAI / Google / Ollama OpenAI-compat all accept the
    # response_format.json_schema shape. Strict mode bounces the response off
    # the schema so local models can't drift into narrative output when the
    # caller asked for a facts[] array — the empirically-observed failure
    # mode for qwen2.5:7b and gemma4:e2b on LongMemEval-S.
    if json_schema is not None:
        body["response_format"] = {
            "type": "json_schema",
            "json_schema": {
                "name": json_schema.get("title", "output"),
                "schema": json_schema,
                "strict": True,
            },
        }
        # Ollama-native accepts the schema directly via top-level `format`;
        # set both so whichever path the runtime takes, the constraint sticks.
        if is_ollama:
            body["format"] = json_schema
    elif json_mode and (model.startswith("openai/") or model.startswith("google/") or is_ollama):
        body["response_format"] = {"type": "json_object"}

    try:
        resp = requests.post(
            target_url,
            headers=request_headers,
            json=body,
            timeout=timeout_s,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.exceptions.RequestException as e:
        raise LLMError(f"LLM call failed ({type(e).__name__}): {e}") from e

    # Log token usage to stderr for cost tracking
    usage = data.get("usage", {})
    if usage:
        print(
            f"[tokens] model={model} prompt={usage.get('prompt_tokens', '?')} "
            f"completion={usage.get('completion_tokens', '?')} "
            f"total={usage.get('total_tokens', '?')}",
            file=sys.stderr,
        )

    content = data["choices"][0]["message"]["content"]
    if not content:
        raise LLMError(f"LLM returned empty response (model={model})")
    return content


def call_llm_with_fallback(
    system_prompt: str,
    user_prompt: str,
    *,
    script: str | None = None,
    json_mode: bool = False,
    json_schema: dict | None = None,
    retries: int = 1,
    temperature: float | None = None,
    seed: int | None = None,
) -> str:
    """call_llm with automatic retry on failure (same model).

    Tries the configured model. On LLMError (timeout, HTTP error, empty
    response), retries up to *retries* times with the same model.

    *temperature* / *seed* forward to call_llm for reproducible greedy decoding.
    The distiller passes temperature=0.0 + a fixed seed so re-ingesting the same
    haystack yields the SAME facts run-to-run (was provider-default temperature →
    the dominant source of LongMemEval run-to-run variance, mis-attributed to the
    QA model). QA already does this in eval/benchmarks/query.py.
    """
    last_err: LLMError | None = None
    for attempt in range(1 + retries):
        try:
            return call_llm(
                system_prompt, user_prompt,
                script=script, json_mode=json_mode, json_schema=json_schema,
                temperature=temperature, seed=seed,
            )
        except LLMError as e:
            last_err = e
            if attempt < retries:
                wait = 2 ** attempt  # 1s, 2s, 4s...
                print(f"[retry] attempt {attempt + 1} failed: {e} — retrying in {wait}s",
                      file=sys.stderr)
                time.sleep(wait)
            else:
                print(f"[retry] all {1 + retries} attempts failed: {e}", file=sys.stderr)
    raise last_err


# ---------------------------------------------------------------------------
# Memory file readers
# ---------------------------------------------------------------------------

def read_playbook(memory_dir: str) -> str:
    """Read sinain-playbook.md, return empty string if missing."""
    p = Path(memory_dir) / "sinain-playbook.md"
    return p.read_text(encoding="utf-8") if p.exists() else ""


def read_effective_playbook(memory_dir: str) -> str:
    """Read the merged effective playbook, falling back to the base playbook.

    The effective playbook (sinain-playbook-effective.md) is generated by the
    plugin at each agent start by merging active module patterns with the base
    playbook.  If it doesn't exist yet, this transparently falls back to the
    base sinain-playbook.md so scripts work before the module system is active.
    """
    effective = Path(memory_dir) / "sinain-playbook-effective.md"
    if effective.exists():
        return effective.read_text(encoding="utf-8")
    return read_playbook(memory_dir)


def parse_module_stack(playbook_text: str) -> list[dict]:
    """Extract module stack from ``<!-- module-stack: id(prio), ... -->`` comment.

    Returns a list of ``{"id": str, "priority": int}`` dicts sorted by priority
    descending (highest first), or an empty list if the comment is absent.
    """
    m = re.search(r"<!--\s*module-stack:\s*([^>]+?)\s*-->", playbook_text)
    if not m:
        return []
    raw = m.group(1)
    stack: list[dict] = []
    for token in raw.split(","):
        token = token.strip()
        if not token:
            continue
        # Parse "module-id(priority)" format
        paren = re.match(r"^(.+?)\((\d+)\)$", token)
        if paren:
            stack.append({"id": paren.group(1).strip(), "priority": int(paren.group(2))})
        else:
            stack.append({"id": token, "priority": 0})
    stack.sort(key=lambda e: e["priority"], reverse=True)
    return stack


def _read_jsonl(path: Path) -> list[dict]:
    """Read a JSONL file into a list of dicts, skipping bad lines."""
    if not path.exists():
        return []
    entries = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return entries


def read_recent_logs(memory_dir: str, days: int = 7) -> list[dict]:
    """Read playbook-logs from the last N days, newest first."""
    log_dir = Path(memory_dir) / "playbook-logs"
    if not log_dir.is_dir():
        return []

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    entries: list[dict] = []

    for jsonl_file in sorted(log_dir.glob("*.jsonl"), reverse=True):
        # Filename is YYYY-MM-DD.jsonl
        try:
            file_date = datetime.strptime(jsonl_file.stem, "%Y-%m-%d").replace(
                tzinfo=timezone.utc
            )
        except ValueError:
            continue
        if file_date < cutoff:
            break
        entries.extend(_read_jsonl(jsonl_file))

    # Sort by timestamp descending
    entries.sort(key=lambda e: e.get("ts", ""), reverse=True)
    return entries


def read_today_log(memory_dir: str) -> list[dict]:
    """Read today's playbook-log entries."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    log_file = Path(memory_dir) / "playbook-logs" / f"{today}.jsonl"
    return _read_jsonl(log_file)


def list_daily_memory_files(memory_dir: str) -> list[str]:
    """List YYYY-MM-DD.md files in memory/, sorted newest first."""
    pattern = str(Path(memory_dir) / "????-??-??.md")
    files = sorted(glob(pattern), reverse=True)
    return files


def parse_mining_index(playbook_text: str) -> list[str]:
    """Extract mined dates from <!-- mining-index: ... --> comment."""
    m = re.search(r"<!--\s*mining-index:\s*([^>]+?)\s*-->", playbook_text)
    if not m:
        return []
    return [d.strip() for d in m.group(1).split(",") if d.strip()]


def parse_effectiveness(playbook_text: str) -> dict | None:
    """Extract effectiveness metrics from <!-- effectiveness: ... --> comment.

    Returns dict with keys: outputs, positive, negative, neutral, rate, updated.
    """
    m = re.search(r"<!--\s*effectiveness:\s*([^>]+?)\s*-->", playbook_text)
    if not m:
        return None
    raw = m.group(1)
    result = {}
    for pair in raw.split(","):
        pair = pair.strip()
        if "=" not in pair:
            continue
        key, val = pair.split("=", 1)
        key = key.strip()
        val = val.strip()
        # Try numeric conversion
        try:
            result[key] = int(val)
        except ValueError:
            try:
                result[key] = float(val)
            except ValueError:
                result[key] = val
    return result if result else None


def read_file_safe(path: str) -> str:
    """Read a file, return empty string if missing."""
    p = Path(path)
    return p.read_text(encoding="utf-8") if p.exists() else ""


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def output_json(data: dict) -> None:
    """Print compact JSON to stdout (for main agent to capture)."""
    print(json.dumps(data, ensure_ascii=False))
