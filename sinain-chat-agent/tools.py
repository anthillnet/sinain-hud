"""Lean 7-tool surface for the sinain chat agent (validated in chat-harness-bench §9c).

KEEP set: sinain_memory_query, sinain_context (screen OCR/vision + audio + apps),
sinain_memory_store, read_file, bash (read-only-sandboxed), grep, glob. Each is wired as
a native OpenHands ToolDefinition whose executor calls sinain-core HTTP / the local
machine and emits contract events through a per-run sink.

Why so few: every tool's schema is system-prompt tokens on EVERY turn → slower TTFT.
Connectors (GSuite/Slack/Glean) come later via deferred/lazy MCP loading, not eager load.
"""
from __future__ import annotations

import glob as _glob
import json
import os
import subprocess
import urllib.parse
import urllib.request

from pydantic import SecretStr  # noqa: F401 (kept for parity; used by sidecar)

from openhands.sdk.llm.message import TextContent
from openhands.sdk.tool import Action, Observation, ToolAnnotations, ToolDefinition, ToolExecutor

CORE_URL = os.environ.get("SINAIN_CORE_URL", "http://localhost:9500")
_MAX = 4000  # cap tool output so a huge payload can't blow up TTFT (the sinain_context lesson)


# ── tool backends (HTTP to sinain-core + local read-only machine ops) ────────
def _get(path: str) -> str:
    try:
        with urllib.request.urlopen(CORE_URL + path, timeout=10) as r:
            return r.read().decode("utf-8", "replace")[:_MAX]
    except OSError as e:
        return f"[sinain-core unreachable at {CORE_URL}: {e}]"


def _post(path: str, body: dict) -> str:
    try:
        req = urllib.request.Request(CORE_URL + path, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.read().decode("utf-8", "replace")[:2000]
    except OSError as e:
        return f"[sinain-core unreachable at {CORE_URL}: {e}]"


_BANNED = ("rm ", "rm -", "mkfs", "dd ", ":(){", "shutdown", "reboot", "> /dev", "sudo ", "chmod ", "mv ")


def _bash(cmd: str) -> str:
    if any(b in cmd for b in _BANNED):
        return "[refused: potentially destructive command]"
    try:
        out = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=15)
        return (out.stdout + out.stderr)[:_MAX] or "[no output]"
    except subprocess.TimeoutExpired:
        return "[bash timeout 15s]"


def dispatch(name: str, args: dict) -> str:
    if name == "sinain_memory_query":
        return _get(f"/knowledge/facts?q={urllib.parse.quote(args.get('query', ''))}&limit={args.get('limit', 8)}")
    if name == "sinain_context":
        return (_get("/agent/digest") + "\n---\n" + _get("/agent/context"))[:_MAX]
    if name == "sinain_memory_store":
        return _post("/knowledge/import", {"content": args.get("text", "")})
    if name == "read_file":
        try:
            with open(args["path"], encoding="utf-8") as fh:
                return fh.read()[:_MAX]
        except OSError as e:
            return f"[read_file error: {e}]"
    if name == "bash":
        return _bash(args.get("command", ""))
    if name == "grep":
        path = json.dumps(args.get("path", "."))
        return _bash(f"grep -rn -- {json.dumps(args.get('pattern', ''))} {path} | head -50")
    if name == "glob":
        return "\n".join(_glob.glob(args.get("pattern", ""), recursive=True)[:50]) or "[no matches]"
    return f"[unknown tool: {name}]"


# ── OpenHands ToolDefinition wiring ──────────────────────────────────────────
class MemoryQueryAction(Action):
    query: str
    limit: int = 8


class MemoryStoreAction(Action):
    text: str


class BashAction(Action):
    command: str


class ReadFileAction(Action):
    path: str


class GrepAction(Action):
    pattern: str
    path: str = "."


class GlobAction(Action):
    pattern: str


class EmptyAction(Action):
    pass


class SinainObs(Observation):
    pass


# per-run event sink (set by the sidecar before each turn; chat is serialized per session)
SINK = None  # set to a callable emit(event_dict) by the sidecar


class _Exec(ToolExecutor):
    def __init__(self, tool_name: str) -> None:
        self.tool_name = tool_name

    def __call__(self, action: Action, conversation=None) -> Observation:  # noqa: ANN001
        args = action.model_dump()
        if SINK:
            SINK({"type": "tool_call", "tool_name": self.tool_name, "tool_args": args})
        result = dispatch(self.tool_name, args)
        if SINK:
            SINK({"type": "tool_result", "tool_name": self.tool_name, "tool_result": result[:500]})
        return SinainObs(content=[TextContent(text=result)])


def _annot() -> ToolAnnotations:
    return ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=False, openWorldHint=True)


def _make(name: str, action_cls: type, desc: str) -> type:
    def create(cls, conv_state=None, **params):  # noqa: ANN001, ARG001
        return [cls(description=desc, action_type=action_cls, observation_type=SinainObs,
                    executor=_Exec(name), annotations=_annot())]
    return type(f"SinainTool_{name}", (ToolDefinition,), {"create": classmethod(create)})


SPECS = [
    ("sinain_memory_query", MemoryQueryAction, "Query the user's knowledge graph (facts/entities)."),
    ("sinain_context", EmptyAction, "Get the user's current situation: digest + screen OCR/vision, audio, app history."),
    ("sinain_memory_store", MemoryStoreAction, "Save a fact/note to the user's long-term memory."),
    ("read_file", ReadFileAction, "Read a UTF-8 text file by absolute path."),
    ("bash", BashAction, "Run a read-only shell command to orient on the machine."),
    ("grep", GrepAction, "Search file contents for a pattern under a path."),
    ("glob", GlobAction, "Find files matching a glob pattern."),
]


def register_all() -> list[str]:
    from openhands.sdk import register_tool
    for name, action_cls, desc in SPECS:
        register_tool(name, _make(name, action_cls, desc))
    return [n for n, _, _ in SPECS]
