"""Generic adapter for harnesses that must run in their OWN environment (dependency
isolation) or another language (the TS controls). It spawns a RESIDENT sidecar
process and speaks one NDJSON protocol — the same shape as the production WS contract:

  → stdin  (one JSON request per line):
      {"message": "...", "context": {"kind": "main", "seed": ""}}
  ← stdout (NDJSON event stream, terminated by a done/error event):
      {"type":"token","text":"..."}
      {"type":"tool_call","tool_name":"...","tool_args":{...}}
      {"type":"tool_result","tool_name":"...","tool_result":"..."}
      {"type":"progress","text":"..."}
      {"type":"done","text":"..."}
      {"type":"error","text":"..."}
  stderr: free-form logs (surfaced only on setup failure).

This is why dependency conflicts (gptme's openai<2 vs litellm's openai>=2.20) don't
block the bench: each sidecar brings its own venv / node_modules. setup() spawns the
process once (resident → warm), so per-turn latency excludes interpreter/import cost.
"""
from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator

from contract import Adapter, ChatContext, Event


class SubprocessAdapter(Adapter):
    def __init__(self, name: str, cmd: list[str], cwd: str | None = None,
                 env: dict | None = None, ready_timeout: float = 60.0) -> None:
        self.name = name
        self._cmd = cmd
        self._cwd = cwd
        self._env = env
        self._ready_timeout = ready_timeout
        self._proc: asyncio.subprocess.Process | None = None

    async def setup(self) -> None:
        self._proc = await asyncio.create_subprocess_exec(
            *self._cmd, cwd=self._cwd, env=self._env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE)
        # Wait for a readiness line: {"type":"ready"} so warm-up cost is in setup_ms.
        try:
            line = await asyncio.wait_for(self._proc.stdout.readline(), self._ready_timeout)
        except asyncio.TimeoutError:
            err = (await self._read_stderr())[:600]
            raise RuntimeError(f"{self.name} sidecar never signalled ready. stderr:\n{err}")
        if not line:
            err = (await self._read_stderr())[:600]
            raise RuntimeError(f"{self.name} sidecar exited during startup. stderr:\n{err}")

    async def _read_stderr(self) -> str:
        if not self._proc or not self._proc.stderr:
            return ""
        try:
            data = await asyncio.wait_for(self._proc.stderr.read(2000), 2.0)
            return data.decode("utf-8", "replace")
        except asyncio.TimeoutError:
            return ""

    async def run(self, message: str, context: ChatContext) -> AsyncIterator[Event]:
        assert self._proc and self._proc.stdin and self._proc.stdout
        req = json.dumps({"message": message,
                          "context": {"kind": context.kind, "seed": context.seed}}) + "\n"
        self._proc.stdin.write(req.encode())
        await self._proc.stdin.drain()
        while True:
            line = await self._proc.stdout.readline()
            if not line:
                yield Event("error", text=f"{self.name} sidecar closed stdout"); return
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue  # tolerate stray non-JSON log lines on stdout
            ev = Event(obj.get("type", "error"), text=obj.get("text", ""),
                       tool_name=obj.get("tool_name", ""), tool_args=obj.get("tool_args", {}) or {},
                       tool_result=obj.get("tool_result", ""))
            yield ev
            if ev.type in ("done", "error"):
                return

    async def cancel(self) -> None:
        if self._proc and self._proc.stdin:
            try:
                self._proc.stdin.write(b'{"cancel":true}\n')
                await self._proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                pass

    async def teardown(self) -> None:
        if self._proc and self._proc.returncode is None:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), 5.0)
            except (asyncio.TimeoutError, ProcessLookupError):
                try: self._proc.kill()
                except ProcessLookupError: pass
