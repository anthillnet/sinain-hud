"""Adapter registry.

In-process (main .venv): baseline, smolagents, openhands — implemented + validated.
Subprocess/isolated (SubprocessAdapter, NDJSON over stdio): gptme, hermes (own
Python venvs — gptme's openai<2 conflicts with litellm's openai>=2.20), cline,
open_harness (Node). These are WIRED but their sidecar scripts are not yet
implemented — each raises with the discovered recipe. See sidecars/ and
docs/chat-harness-evaluation.md §9a.
"""
import os

from contract import Adapter

_DIR = os.path.dirname(__file__)
_BENCH = os.path.abspath(os.path.join(_DIR, ".."))
_REPO = os.path.abspath(os.path.join(_BENCH, ".."))


def _sinain_mcp() -> list:
    """ACP McpServerStdio spec for the real sinain MCP server (memory/context/etc.),
    so ACP harnesses (Goose, Hermes) get sinain tools the production way."""
    tsx = os.path.join(_REPO, "sinain-core", "node_modules", ".bin", "tsx")
    idx = os.path.join(_REPO, "sinain-mcp-server", "index.ts")
    if not (os.path.exists(tsx) and os.path.exists(idx)):
        return []
    return [{"name": "sinain", "command": tsx, "args": [idx],
             "env": [{"name": "SINAIN_CORE_URL", "value": "http://localhost:9500"},
                     {"name": "SINAIN_WORKSPACE", "value": os.path.expanduser("~/.openclaw/workspace")}]}]


def get_adapter(name: str) -> Adapter:
    if name == "baseline":
        from adapters.baseline import BaselineAdapter
        return BaselineAdapter()
    if name == "smolagents":
        from adapters.smolagents_ad import SmolagentsAdapter
        return SmolagentsAdapter()
    if name == "openhands":
        from adapters.openhands import OpenHandsAdapter
        return OpenHandsAdapter()
    # ── subprocess sidecars (isolated env) — implement the sidecar script then
    #    flip these to return SubprocessAdapter(name, cmd=[...], cwd=...). ──────
    if name == "gptme":
        from adapters.gptme_ad import GptmeAdapter
        return GptmeAdapter()
    if name == "hermes":
        # ACP bridge (user endorsed): drive Hermes via `hermes-acp` stdio ACP server.
        from adapters.acp_adapter import ACPAdapter
        hermes_acp = os.path.join(_BENCH, ".venv", "bin", "hermes-acp")
        # HERMES_HOME → isolated bench config (deepseek-v4-flash + our funded key);
        # the user's ~/.hermes had a stale/unfunded OpenRouter key that made Hermes
        # silently return empty responses. Never mutate the user's real config.
        return ACPAdapter("hermes", cmd=[hermes_acp], cwd=_BENCH,
                          env={"OPENROUTER_API_KEY": os.environ.get("OPENROUTER_API_KEY", ""),
                               "HERMES_HOME": os.path.join(_BENCH, ".hermes-bench")},
                          mcp_servers=_sinain_mcp())
    if name == "cline":
        from adapters.cline_ad import ClineAdapter
        return ClineAdapter()
    if name == "open_harness":
        from adapters.open_harness_ad import OpenHarnessAdapter
        return OpenHarnessAdapter()
    if name == "openclaude":  # REFERENCE ONLY — not shippable (license)
        from adapters.openclaude_ad import OpenClaudeAdapter
        return OpenClaudeAdapter()
    if name == "goose":  # Apache-2.0, Rust; ACP-native (`goose acp`)
        from adapters.acp_adapter import ACPAdapter
        import shutil
        goose = shutil.which("goose") or os.path.expanduser("~/.local/bin/goose")
        return ACPAdapter("goose", cmd=[goose, "acp"], cwd=_BENCH,
                          env={"GOOSE_PROVIDER": "openrouter",
                               "GOOSE_MODEL": os.environ.get("BENCH_MODEL", "deepseek/deepseek-v4-flash"),
                               "OPENROUTER_API_KEY": os.environ.get("OPENROUTER_API_KEY", "")},
                          mcp_servers=_sinain_mcp())
    raise ValueError(f"unknown adapter: {name}")


# Implemented + runnable today:
ALL = ["baseline", "smolagents", "openhands"]
# Wired, sidecar impl pending:
PENDING = ["gptme", "hermes", "cline", "open_harness"]
