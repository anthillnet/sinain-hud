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
) -> str:
    """Call OpenRouter chat completions API. Returns assistant message text.

    When *script* is provided, model and max_tokens are overridden from
    koog-config.json (external config the bot cannot modify).
    """
    if script:
        cfg = _load_config()
        script_cfg = cfg.get("scripts", {}).get(script, cfg.get("defaults", {}))
        model = _resolve_model(script_cfg.get("model", "fast"))
        max_tokens = script_cfg.get("maxTokens", max_tokens)

    api_key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_API_KEY_REFLECTION")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY or OPENROUTER_API_KEY_REFLECTION env var is not set")

    resp = requests.post(
        OPENROUTER_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": model,
            "max_tokens": max_tokens,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        },
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()

    # Log token usage to stderr for cost tracking
    usage = data.get("usage", {})
    if usage:
        print(
            f"[tokens] model={model} prompt={usage.get('prompt_tokens', '?')} "
            f"completion={usage.get('completion_tokens', '?')} "
            f"total={usage.get('total_tokens', '?')}",
            file=sys.stderr,
        )

    return data["choices"][0]["message"]["content"]


# ---------------------------------------------------------------------------
# Memory file readers
# ---------------------------------------------------------------------------

def read_playbook(memory_dir: str) -> str:
    """Read sinain-playbook.md, return empty string if missing."""
    p = Path(memory_dir) / "sinain-playbook.md"
    return p.read_text(encoding="utf-8") if p.exists() else ""


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
