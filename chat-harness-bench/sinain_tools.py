"""The shared tool surface every candidate is wired to — so the bake-off measures
whether each harness actually OPERATES sinain's tools, not just loads them.

The sinain MCP server (sinain-mcp-server/index.ts) is a thin wrapper over sinain-core
HTTP endpoints, so for the bench we execute sinain_* tools by calling those endpoints
directly (lower latency, no Node stdio dependency — and it mirrors the eventual
in-process option). bash/read_file are executed locally so the agent can "orient on
the machine like Claude Code".

Exposes:
  TOOL_SPECS    — OpenAI-format function schemas (works for any OpenAI-compatible loop)
  dispatch(name, args) -> str   — execute a tool call, return a string result

Set SINAIN_CORE_URL; if core is unreachable, sinain_* tools return a clear MOCK
marker so the runner still exercises the loop without a live core.
"""
from __future__ import annotations

import json
import os
import subprocess
import urllib.request
import urllib.error

CORE_URL = os.environ.get("SINAIN_CORE_URL", "http://localhost:9500")

TOOL_SPECS = [
    {"type": "function", "function": {
        "name": "sinain_memory_query",
        "description": "Query the user's knowledge graph (facts/entities) by natural-language query.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"}, "limit": {"type": "integer", "default": 8}},
            "required": ["query"]}}},
    {"type": "function", "function": {
        "name": "sinain_context",
        "description": "Get the user's CURRENT situation: digest + context window (screen OCR / vision, audio transcript, app history).",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "sinain_notify",
        "description": "Post a short note to the user's feed.",
        "parameters": {"type": "object", "properties": {"text": {"type": "string"}},
                       "required": ["text"]}}},
    {"type": "function", "function": {
        "name": "sinain_health",
        "description": "Check sinain-core health/status.",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "sinain_memory_store",
        "description": "Save a fact/note to the user's long-term memory.",
        "parameters": {"type": "object", "properties": {"text": {"type": "string"}},
                       "required": ["text"]}}},
    {"type": "function", "function": {
        "name": "bash",
        "description": "Run a read-only shell command to orient on the machine (ls, cat, pwd, git status). Avoid destructive commands.",
        "parameters": {"type": "object", "properties": {"command": {"type": "string"}},
                       "required": ["command"]}}},
    {"type": "function", "function": {
        "name": "read_file",
        "description": "Read a UTF-8 text file by absolute path.",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}},
                       "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "grep",
        "description": "Search file contents (ripgrep-style) for a pattern under a path.",
        "parameters": {"type": "object", "properties": {
            "pattern": {"type": "string"}, "path": {"type": "string"}},
            "required": ["pattern"]}}},
    {"type": "function", "function": {
        "name": "glob",
        "description": "Find files matching a glob pattern (e.g. '**/*.py').",
        "parameters": {"type": "object", "properties": {"pattern": {"type": "string"}},
                       "required": ["pattern"]}}},
]


def _http_get(path: str) -> str:
    try:
        with urllib.request.urlopen(CORE_URL + path, timeout=10) as r:
            return r.read().decode("utf-8", "replace")[:4000]
    except (urllib.error.URLError, OSError) as e:
        return f"[MOCK: sinain-core unreachable at {CORE_URL} ({e})]"


def _http_post(path: str, body: dict) -> str:
    try:
        req = urllib.request.Request(
            CORE_URL + path, data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.read().decode("utf-8", "replace")[:2000]
    except (urllib.error.URLError, OSError) as e:
        return f"[MOCK: sinain-core unreachable at {CORE_URL} ({e})]"


def dispatch(name: str, args: dict) -> str:
    """Execute a tool call by name. Returns a string observation."""
    if name == "sinain_memory_query":
        q = urllib.parse.quote(args.get("query", ""))
        return _http_get(f"/knowledge/facts?q={q}&limit={args.get('limit', 8)}")
    if name == "sinain_context":
        return _http_get("/agent/digest") + "\n---\n" + _http_get("/agent/context")
    if name == "sinain_notify":
        return _http_post("/feed", {"text": args.get("text", "")})
    if name == "sinain_health":
        return _http_get("/health")
    if name == "sinain_memory_store":
        return _http_post("/knowledge/import", {"content": args.get("text", "")})
    if name == "bash":
        return _run_bash(args.get("command", ""))
    if name == "read_file":
        try:
            with open(args["path"], encoding="utf-8") as fh:
                return fh.read()[:4000]
        except OSError as e:
            return f"[read_file error: {e}]"
    if name == "grep":
        path = args.get("path", ".")
        return _run_bash(f"grep -rn -- {json.dumps(args.get('pattern',''))} {json.dumps(path)} | head -50")
    if name == "glob":
        import glob as _glob
        matches = _glob.glob(args.get("pattern", ""), recursive=True)[:50]
        return "\n".join(matches) or "[no matches]"
    return f"[unknown tool: {name}]"


_BANNED = ("rm ", "rm -", "mkfs", "dd ", ":(){", "shutdown", "reboot", "> /dev", "sudo ")


def _run_bash(cmd: str) -> str:
    if any(b in cmd for b in _BANNED):
        return "[refused: potentially destructive command]"
    try:
        out = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=15)
        return (out.stdout + out.stderr)[:4000] or "[no output]"
    except subprocess.TimeoutExpired:
        return "[bash timeout 15s]"


import urllib.parse  # noqa: E402  (used in dispatch)
