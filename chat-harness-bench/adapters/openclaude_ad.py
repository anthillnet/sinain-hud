"""openclaude (Gitlawb/openclaude) — REFERENCE ONLY, NOT SHIPPABLE (license: Claude
Code reskin, NOASSERTION; MIT covers diffs only; redistributes Anthropic proprietary
source w/o authorization). Benched purely as a black-box capability/latency reference.

RUN MODE = RESIDENT (the responsive way; the whole point of this investigation):
  openclaude -p --input-format stream-json --output-format stream-json
             --include-partial-messages --verbose --allowedTools <read-only>
One long-lived process: Claude-Code init + MCP server connections (incl. the user's
already-connected sinain MCP) are paid ONCE at setup (setup_ms). Each turn = a user
message written to stdin → streamed stream-json events on stdout → per-turn cost is
the model round-trip, NOT a 18s reload. Contrast: one-shot `-p` per message reloads
everything each call (~18s) — that's the anti-pattern (== today's chat path).

SAFETY: runs on the user's real machine with their ~/.claude tools; restricted via
--allowedTools to read-only sinain MCP + Read (no Bash/Write/Edit).
"""
from __future__ import annotations

import asyncio
import json
import os
from typing import AsyncIterator

from contract import Adapter, ChatContext, Event

_ALLOWED = "mcp__sinain__sinain_memory_query mcp__sinain__sinain_context mcp__sinain__sinain_health Read"


def _norm(name: str) -> str:
    n = name.replace("mcp__sinain__", "")
    return {"Read": "read_file", "Bash": "bash"}.get(n, n)


class OpenClaudeAdapter(Adapter):
    name = "openclaude"

    def __init__(self) -> None:
        self._proc: asyncio.subprocess.Process | None = None

    async def setup(self) -> None:
        bin_ = os.path.join(os.path.dirname(__file__), "..", "sidecars", "ts",
                            "node_modules", ".bin", "openclaude")
        if not os.path.exists(bin_):
            raise RuntimeError("openclaude not installed (npm i @gitlawb/openclaude in sidecars/ts)")
        env = {**os.environ, "CLAUDE_CODE_USE_OPENAI": "1",
               "OPENAI_API_KEY": os.environ["OPENROUTER_API_KEY"],
               "OPENAI_BASE_URL": "https://openrouter.ai/api/v1",
               "OPENAI_MODEL": os.environ.get("BENCH_MODEL", "deepseek/deepseek-v4-flash")}
        self._proc = await asyncio.create_subprocess_exec(
            bin_, "-p", "--input-format", "stream-json", "--output-format", "stream-json",
            "--include-partial-messages", "--verbose", "--allowedTools", _ALLOWED,
            cwd=os.path.join(os.path.dirname(__file__), ".."), env=env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE)
        # In stream-json INPUT mode, init is deferred until the first message arrives.
        # Do a warm-up turn now so init + MCP-connect cost lands in setup_ms; real runs warm.
        warm = {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]}}
        self._proc.stdin.write((json.dumps(warm) + "\n").encode())
        await self._proc.stdin.drain()
        while True:
            line = await asyncio.wait_for(self._proc.stdout.readline(), 120)
            if not line:
                raise RuntimeError("openclaude exited during warm-up: " +
                                   (await self._proc.stderr.read(500)).decode("utf-8", "replace"))
            try:
                if json.loads(line).get("type") == "result":
                    break
            except json.JSONDecodeError:
                continue

    async def cancel(self) -> None:
        if self._proc and self._proc.returncode is None:
            try: self._proc.kill()
            except ProcessLookupError: pass

    async def run(self, message: str, context: ChatContext) -> AsyncIterator[Event]:
        assert self._proc and self._proc.stdin
        text = message if not context.seed else f"[{context.kind} context]\n{context.seed}\n\n{message}"
        msg = {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}}
        self._proc.stdin.write((json.dumps(msg) + "\n").encode())
        await self._proc.stdin.drain()
        final = ""
        while True:
            line = await self._proc.stdout.readline()
            if not line:
                yield Event("error", text="openclaude closed stdout"); return
            try:
                m = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = m.get("type")
            if t == "stream_event":  # partial token deltas (--include-partial-messages)
                ev = m.get("event", {})
                if ev.get("type") == "content_block_delta":
                    d = ev.get("delta", {})
                    if d.get("type") == "text_delta" and d.get("text"):
                        yield Event("token", text=d["text"])
            elif t == "assistant":
                for b in (m.get("message", {}).get("content") or []):
                    if b.get("type") == "tool_use":
                        yield Event("tool_call", tool_name=_norm(b.get("name", "")),
                                    tool_args=b.get("input", {}) or {})
            elif t == "user":
                for b in (m.get("message", {}).get("content") or []):
                    if b.get("type") == "tool_result":
                        c = b.get("content")
                        yield Event("tool_result", tool_result=(c if isinstance(c, str) else json.dumps(c))[:500])
            elif t == "result":
                final = m.get("result", "")
                yield Event("done", text=final); return

    async def teardown(self) -> None:
        if self._proc and self._proc.returncode is None:
            try:
                self._proc.stdin.close()
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), 5)
            except (asyncio.TimeoutError, ProcessLookupError):
                try: self._proc.kill()
                except ProcessLookupError: pass
