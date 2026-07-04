"""Shared utilities for sinain-memory scripts.

Centralizes LLM calls (via the shared sinain-llm package), memory/ file
readers, and JSON output.
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

MODEL_FAST = "google/gemini-3-flash-preview"
MODEL_SMART = "anthropic/claude-sonnet-4.6"


class LLMError(Exception):
    """Raised when the LLM API call fails (timeout, network, bad response)."""
    pass


# ---------------------------------------------------------------------------
# sinain-llm (DESIGN-SHARED-MODULES L1) — the LLM transport
# ---------------------------------------------------------------------------
# The transport lives in packages/sinain-llm, shared across surfaces. This
# module contributes only sinain-memory config (llm-config.json per-script
# model/token resolution) on top of it.

@lru_cache(maxsize=1)
def _sinain_llm():
    """Import the shared sinain_llm package.

    Layouts: dev monorepo (<repo>/packages/sinain-llm, common.py two levels
    down) and npm-flat (<pkg>/packages/sinain-llm, one level down).
    SINAIN_LLM_DIR overrides both.
    """
    try:
        import sinain_llm
        return sinain_llm
    except ImportError:
        pass
    here = Path(__file__).resolve()
    candidates = [os.environ.get("SINAIN_LLM_DIR")]
    for depth in (2, 1):
        if len(here.parents) > depth:
            candidates.append(str(here.parents[depth] / "packages" / "sinain-llm"))
    for cand in candidates:
        if cand and (Path(cand) / "sinain_llm" / "__init__.py").exists():
            if cand not in sys.path:
                sys.path.insert(0, cand)
            try:
                import sinain_llm
                return sinain_llm
            except ImportError:
                continue
    raise ImportError(
        "sinain-llm package not found (expected packages/sinain-llm next to the "
        "repo or npm package root; override with SINAIN_LLM_DIR)"
    )


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

    Canonical implementation lives in sinain_llm.json_utils (three-stage:
    direct parse, code fences, balanced-brace scan with truncation repair).
    Raises ValueError if no valid JSON can be extracted.
    """
    return _sinain_llm().extract_json(text)


# ---------------------------------------------------------------------------
# External config (llm-config.json)
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _load_config() -> dict:
    """Load llm-config.json from the same directory as this module. Cached."""
    config_path = Path(__file__).resolve().parent / "llm-config.json"
    try:
        return json.loads(config_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        print(f"[warn] llm-config.json not loaded: {exc}", file=sys.stderr)
        return {}


def _resolve_model(logical_name: str) -> str:
    """Map a logical model name ('fast'/'smart') to an actual model ID.

    Env-var overrides take precedence over llm-config.json so the bench
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
    """Chat-completions call via the shared sinain-llm package. Returns
    assistant message text.

    When *script* is provided, model and max_tokens are overridden from
    llm-config.json (external config the bot cannot modify).

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

    # Delegate the transport to the shared sinain-llm package. Script config
    # resolution above stays HERE — it's sinain-memory deployment config, not
    # provider logic. RuntimeError (missing API key) passes through unchanged;
    # the package's LLMError is re-raised as ours so existing
    # `except common.LLMError` sites keep working.
    lib = _sinain_llm()
    try:
        return lib.call_llm(
            system_prompt, user_prompt, model, max_tokens,
            json_mode=json_mode, json_schema=json_schema,
            temperature=temperature, seed=seed, timeout=timeout_s,
        )
    except lib.LLMError as e:
        raise LLMError(str(e)) from e


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
