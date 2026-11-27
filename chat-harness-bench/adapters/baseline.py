"""Reference adapter: a raw OpenAI-compatible streaming tool loop. No external
harness — this validates the runner + sinain tool wiring and is the latency FLOOR
every real harness is measured against (a harness can only add overhead on top of
the model's own tool loop).

Critically: it distinguishes deepseek `reasoning` deltas from `content` deltas, so
time-to-first-CONTENT-token is measured correctly on a reasoning model.
"""
from __future__ import annotations

import json
import os
from typing import AsyncIterator

import requests

from contract import Adapter, ChatContext, Event
from sinain_tools import TOOL_SPECS, dispatch

SYSTEM = (
    "You are Sinain's chat assistant. You can use tools to consult the user's memory, "
    "see their current screen/audio context, and orient on their machine. Prefer using "
    "a tool over guessing. Be concise."
)


class BaselineAdapter(Adapter):
    name = "baseline-rawloop"

    def __init__(self) -> None:
        self._cancel = False
        self._key = ""
        self._base = ""
        self._model = ""

    async def setup(self) -> None:
        self._key = os.environ["OPENROUTER_API_KEY"]
        self._base = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
        self._model = os.environ.get("BENCH_MODEL", "deepseek/deepseek-v4-flash")

    async def cancel(self) -> None:
        self._cancel = True

    async def run(self, message: str, context: ChatContext) -> AsyncIterator[Event]:
        self._cancel = False
        messages = [{"role": "system", "content": SYSTEM}]
        if context.seed:
            messages.append({"role": "system",
                             "content": f"[{context.kind} context]\n{context.seed}"})
        messages.append({"role": "user", "content": message})

        for _hop in range(8):  # tool-loop hop budget
            if self._cancel:
                yield Event("error", text="cancelled"); return
            content, tool_calls, err = "", {}, None
            body = {"model": self._model, "messages": messages,
                    "tools": TOOL_SPECS, "stream": True}
            if os.environ.get("BENCH_NO_REASONING"):  # disable reasoning for fast models
                body["reasoning"] = {"enabled": False}
            try:
                resp = requests.post(
                    f"{self._base}/chat/completions",
                    headers={"Authorization": f"Bearer {self._key}",
                             "Content-Type": "application/json"},
                    json=body, stream=True, timeout=120)
            except requests.RequestException as e:
                yield Event("error", text=str(e)); return

            for line in resp.iter_lines():
                if self._cancel:
                    yield Event("error", text="cancelled"); return
                if not line or not line.startswith(b"data: "):
                    continue
                data = line[6:]
                if data == b"[DONE]":
                    break
                try:
                    delta = json.loads(data)["choices"][0]["delta"]
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue
                # reasoning deltas are NOT content — do not count as first token
                if delta.get("reasoning"):
                    yield Event("progress", text="reasoning")
                if delta.get("content"):
                    content += delta["content"]
                    yield Event("token", text=delta["content"])
                for tc in delta.get("tool_calls", []) or []:
                    i = tc.get("index", 0)
                    slot = tool_calls.setdefault(i, {"name": "", "args": ""})
                    fn = tc.get("function", {})
                    if fn.get("name"):
                        slot["name"] = fn["name"]
                    if fn.get("arguments"):
                        slot["args"] += fn["arguments"]

            if not tool_calls:
                yield Event("done", text=content); return

            # execute tool calls, append results, loop
            assistant_tcs = [
                {"id": f"call_{i}", "type": "function",
                 "function": {"name": s["name"], "arguments": s["args"] or "{}"}}
                for i, s in sorted(tool_calls.items())]
            messages.append({"role": "assistant", "content": content or None,
                             "tool_calls": assistant_tcs})
            for i, s in sorted(tool_calls.items()):
                try:
                    args = json.loads(s["args"] or "{}")
                except json.JSONDecodeError:
                    args = {}
                yield Event("tool_call", tool_name=s["name"], tool_args=args)
                result = dispatch(s["name"], args)
                yield Event("tool_result", tool_name=s["name"], tool_result=result[:500])
                messages.append({"role": "tool", "tool_call_id": f"call_{i}",
                                 "content": result})

        yield Event("done", text="[hop budget exhausted]")
