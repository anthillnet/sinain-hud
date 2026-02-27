"""Shared utilities for sinain-koog heartbeat scripts.

Centralizes OpenRouter API calls, memory/ file readers, and JSON output.
"""

import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from glob import glob
from pathlib import Path

import requests

MODEL_FAST = "openai/gpt-oss-120b"
MODEL_SMART = "anthropic/claude-sonnet-4.6"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


class LLMError(Exception):
    """Raised when the LLM API call fails (timeout, network, bad response)."""
    pass


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
    """Map a logical model name ('fast'/'smart') to an actual model ID via config."""
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
) -> str:
    """Call OpenRouter chat completions API. Returns assistant message text.

    When *script* is provided, model and max_tokens are overridden from
    koog-config.json (external config the bot cannot modify).

    When *json_mode* is True and the resolved model starts with ``openai/``,
    ``response_format: {"type": "json_object"}`` is added to the request body.
    """
    timeout_s = 60
    if script:
        cfg = _load_config()
        script_cfg = cfg.get("scripts", {}).get(script, cfg.get("defaults", {}))
        model = _resolve_model(script_cfg.get("model", "fast"))
        max_tokens = script_cfg.get("maxTokens", max_tokens)
        timeout_s = script_cfg.get("timeout", cfg.get("defaults", {}).get("timeout", 60))

    api_key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_API_KEY_REFLECTION")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY or OPENROUTER_API_KEY_REFLECTION env var is not set")

    body: dict = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    if json_mode and model.startswith("openai/"):
        body["response_format"] = {"type": "json_object"}

    try:
        resp = requests.post(
            OPENROUTER_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
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
