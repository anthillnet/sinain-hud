"""smolagents adapter (HuggingFace, Apache-2.0). install: pip install smolagents litellm

smolagents' ToolCallingAgent delivers its answer through a synthetic `final_answer`
tool rather than token-streaming natural language, so for this harness ttfc ≈ final
(no progressive answer streaming) — a real UX datum the bench captures honestly.
sinain tools are wrapped as @tool fns over sinain_tools.dispatch.
"""
from __future__ import annotations

import json
import os
from typing import AsyncIterator

from smolagents import LiteLLMModel, ToolCallingAgent, tool

from contract import Adapter, ChatContext, Event
from sinain_tools import dispatch


@tool
def sinain_memory_query(query: str, limit: int = 8) -> str:
    """Query the user's knowledge graph (facts/entities).

    Args:
        query: natural-language query.
        limit: max results.
    """
    return dispatch("sinain_memory_query", {"query": query, "limit": limit})


@tool
def sinain_context() -> str:
    """Get the user's current situation: digest + screen OCR/vision, audio, app history."""
    return dispatch("sinain_context", {})


@tool
def sinain_notify(text: str) -> str:
    """Post a short note to the user's feed.

    Args:
        text: the note.
    """
    return dispatch("sinain_notify", {"text": text})


@tool
def sinain_health() -> str:
    """Check sinain-core health/status."""
    return dispatch("sinain_health", {})


@tool
def bash(command: str) -> str:
    """Run a read-only shell command to orient on the machine.

    Args:
        command: the shell command.
    """
    return dispatch("bash", {"command": command})


@tool
def read_file(path: str) -> str:
    """Read a UTF-8 text file by absolute path.

    Args:
        path: absolute file path.
    """
    return dispatch("read_file", {"path": path})


_TOOLS = [sinain_memory_query, sinain_context, sinain_notify, sinain_health, bash, read_file]


class SmolagentsAdapter(Adapter):
    name = "smolagents"

    def __init__(self) -> None:
        self._cancel = False
        self._agent: ToolCallingAgent | None = None

    async def setup(self) -> None:
        model = LiteLLMModel(model_id="openrouter/" + os.environ.get("BENCH_MODEL", "deepseek/deepseek-v4-flash"),
                             api_key=os.environ["OPENROUTER_API_KEY"])
        self._agent = ToolCallingAgent(tools=_TOOLS, model=model, stream_outputs=True)

    async def cancel(self) -> None:
        self._cancel = True

    async def run(self, message: str, context: ChatContext) -> AsyncIterator[Event]:
        self._cancel = False
        task = message if not context.seed else f"[{context.kind} context]\n{context.seed}\n\n{message}"
        try:
            for ev in self._agent.run(task, stream=True, reset=True, max_steps=8):
                if self._cancel:
                    yield Event("error", text="cancelled"); return
                cls = type(ev).__name__
                if cls == "ToolCall":
                    name = getattr(ev, "name", "") or ""
                    if name and name != "final_answer":
                        args = getattr(ev, "arguments", {}) or {}
                        if isinstance(args, str):
                            try: args = json.loads(args)
                            except json.JSONDecodeError: args = {"_raw": args}
                        yield Event("tool_call", tool_name=name, tool_args=args)
                elif cls == "ActionStep":
                    obs = getattr(ev, "observations", None)
                    if obs:
                        yield Event("tool_result", tool_result=str(obs)[:500])
                elif cls == "FinalAnswerStep":
                    out = getattr(ev, "output", "")
                    yield Event("token", text=str(out))
                    yield Event("done", text=str(out)); return
        except Exception as e:  # noqa: BLE001
            yield Event("error", text=f"{type(e).__name__}: {e}"); return
        yield Event("done", text="")
