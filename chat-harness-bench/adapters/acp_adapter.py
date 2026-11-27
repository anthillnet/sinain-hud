"""ACP (Agent Client Protocol) adapter — the REUSABLE bridge for any ACP-capable
harness (Hermes via `hermes-acp`, Goose via `goose-acp-server`, …). Instead of
reverse-engineering each harness's bespoke API, we speak the open ACP standard:
newline-delimited JSON-RPC 2.0 over the harness's stdio.

Flow (ACP, agentclientprotocol.com):
  client→agent  initialize {protocolVersion, clientCapabilities} → {agentCapabilities}
  client→agent  session/new {cwd, mcpServers:[…sinain MCP…]} → {sessionId}   (resident)
  client→agent  session/prompt {sessionId, prompt:[{type:"text",text}]} → {stopReason}
  agent→client  session/update notifications (streaming):
                  agent_message_chunk → token ; agent_thought_chunk → progress(reasoning)
                  tool_call → tool_call ; tool_call_update(completed) → tool_result
  agent→client  session/request_permission → we auto-allow (so tools run)
                fs/read_text_file, fs/write_text_file → served from disk

sinain tools are provided to the agent as an MCP server in session/new (the production
path) — the agent calls them itself; we don't execute tools client-side.
"""
from __future__ import annotations

import asyncio
import json
import os
from typing import AsyncIterator

from contract import Adapter, ChatContext, Event


def _norm_acp_tool(title: str) -> str:
    """ACP tool_call gives a human TITLE, not the raw name. Normalize across agents:
      Goose:  'Sinain: Sinain Memory Query', 'Shell', 'Read'
      Hermes: 'mcp_sinain_sinain_memory_query', 'terminal: git ...'
    → fixture vocabulary so tool-use quality scores correctly."""
    t = title.strip()
    low = t.lower()
    for pre in ("mcp__sinain__", "mcp_sinain_"):            # Hermes MCP form
        if low.startswith(pre):
            return low[len(pre):]
    if low.startswith("sinain:"):                            # Goose MCP form
        return low.split(":", 1)[1].strip().replace(" ", "_")
    if low.startswith("terminal:") or low == "shell":        # shell aliases
        return "bash"
    if low == "read":
        return "read_file"
    return low.replace(" ", "_")


class ACPAdapter(Adapter):
    def __init__(self, name: str, cmd: list[str], mcp_servers: list[dict] | None = None,
                 env: dict | None = None, cwd: str | None = None) -> None:
        self.name = name
        self._cmd = cmd
        self._mcp = mcp_servers or []
        self._env = env
        self._cwd = cwd or os.getcwd()
        self._proc: asyncio.subprocess.Process | None = None
        self._next_id = 1
        self._pending: dict[int, asyncio.Future] = {}
        self._session_id: str | None = None
        self._q: asyncio.Queue[Event] | None = None   # current run's event sink
        self._reader: asyncio.Task | None = None

    # ── JSON-RPC plumbing ────────────────────────────────────────────────────
    def _send(self, obj: dict) -> None:
        assert self._proc and self._proc.stdin
        self._proc.stdin.write((json.dumps(obj) + "\n").encode())

    async def _request(self, method: str, params: dict, timeout: float = 120) -> dict:
        rid = self._next_id; self._next_id += 1
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        await self._proc.stdin.drain()
        return await asyncio.wait_for(fut, timeout)

    def _respond(self, rid, result: dict) -> None:
        self._send({"jsonrpc": "2.0", "id": rid, "result": result})

    async def _read_loop(self) -> None:
        assert self._proc and self._proc.stdout
        while True:
            line = await self._proc.stdout.readline()
            if not line:
                return
            if os.environ.get("ACP_DEBUG"):
                with open(os.path.join(os.path.dirname(__file__), "..", "results", "acp_raw.log"), "ab") as _f:
                    _f.write(line)
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "id" in msg and ("result" in msg or "error" in msg):      # response
                fut = self._pending.pop(msg["id"], None)
                if fut and not fut.done():
                    fut.set_result(msg.get("result") or {"_error": msg.get("error")})
            elif "id" in msg and "method" in msg:                         # agent→client request
                self._handle_request(msg)
            elif msg.get("method") == "session/update":                   # notification
                self._handle_update(msg.get("params", {}))

    def _handle_request(self, msg: dict) -> None:
        method, rid, params = msg["method"], msg["id"], msg.get("params", {})
        if method == "session/request_permission":
            # auto-allow so tool calls proceed
            opts = params.get("options", [])
            allow = next((o["optionId"] for o in opts if "allow" in o.get("optionId", "").lower()), None)
            self._respond(rid, {"outcome": {"outcome": "selected", "optionId": allow or (opts[0]["optionId"] if opts else "allow")}})
        elif method == "fs/read_text_file":
            try:
                with open(params["path"], encoding="utf-8") as fh:
                    self._respond(rid, {"content": fh.read()})
            except OSError as e:
                self._respond(rid, {"content": f"[read error: {e}]"})
        elif method == "fs/write_text_file":
            self._respond(rid, {})   # no-op for the bench
        else:
            self._respond(rid, {})

    def _handle_update(self, params: dict) -> None:
        if not self._q:
            return
        upd = params.get("update", {})
        kind = upd.get("sessionUpdate")
        if kind == "agent_message_chunk":
            txt = (upd.get("content") or {}).get("text", "")
            if txt:
                self._q.put_nowait(Event("token", text=txt))
        elif kind == "agent_thought_chunk":
            self._q.put_nowait(Event("progress", text="reasoning"))
        elif kind == "tool_call":
            self._q.put_nowait(Event("tool_call", tool_name=_norm_acp_tool(upd.get("title", "") or upd.get("toolCallId", "tool")),
                                     tool_args=upd.get("rawInput", {}) or {}))
        elif kind == "tool_call_update" and upd.get("status") == "completed":
            content = upd.get("content") or []
            txt = ""
            if content and isinstance(content, list):
                txt = (content[0].get("content", {}) or {}).get("text", "") if content else ""
            self._q.put_nowait(Event("tool_result", tool_result=str(txt)[:500]))

    # ── Adapter interface ────────────────────────────────────────────────────
    async def setup(self) -> None:
        env = {**os.environ, **(self._env or {})}
        self._proc = await asyncio.create_subprocess_exec(
            *self._cmd, cwd=self._cwd, env=env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE)
        self._reader = asyncio.create_task(self._read_loop())
        init = await self._request("initialize", {
            "protocolVersion": 1,
            "clientCapabilities": {"fs": {"readTextFile": True, "writeTextFile": True}}})
        # Authenticate if the agent advertises non-terminal auth methods (Hermes: id="openrouter").
        # Terminal methods (e.g. "--setup") need an interactive TTY — skip them.
        for am in (init.get("authMethods") or []):
            if am.get("type") != "terminal":
                await self._request("authenticate", {"methodId": am["id"]})
                break
        # NOTE (Hermes, validated 2026-06-15): initialize advertises `authMethods`
        # ("Authenticate Hermes using the currently configured openrouter"). Without
        # an `authenticate` call, session/prompt returns stopReason=end_turn with
        # usage_update but NO agent_message_chunk (no content). TODO: call
        #   await self._request("authenticate", {"methodId": <id from initialize authMethods>})
        # before session/new. Also: session/new RESULT includes models.availableModels
        # (e.g. "openrouter:deepseek/deepseek-v4-flash") + modes → select the bench
        # model PER SESSION here instead of mutating the user's ~/.hermes default.
        res = await self._request("session/new", {"cwd": self._cwd, "mcpServers": self._mcp})
        self._session_id = res.get("sessionId")
        if not self._session_id:
            raise RuntimeError(f"{self.name}: session/new returned no sessionId: {res}")

    async def run(self, message: str, context: ChatContext) -> AsyncIterator[Event]:
        self._q = asyncio.Queue()
        text = message if not context.seed else f"[{context.kind} context]\n{context.seed}\n\n{message}"
        prompt_task = asyncio.create_task(self._request(
            "session/prompt", {"sessionId": self._session_id,
                               "prompt": [{"type": "text", "text": text}]}, timeout=180))
        while True:
            getter = asyncio.create_task(self._q.get())
            done, _ = await asyncio.wait({getter, prompt_task}, return_when=asyncio.FIRST_COMPLETED)
            if getter in done:
                yield getter.result()
            else:
                getter.cancel()
                # prompt finished: drain any remaining queued events, then done
                while not self._q.empty():
                    yield self._q.get_nowait()
                try:
                    res = prompt_task.result()
                    yield Event("done", text=res.get("stopReason", ""))
                except Exception as e:  # noqa: BLE001
                    yield Event("error", text=f"{type(e).__name__}: {e}")
                return

    async def cancel(self) -> None:
        if self._session_id:
            try:
                self._send({"jsonrpc": "2.0", "method": "session/cancel",
                            "params": {"sessionId": self._session_id}})
                await self._proc.stdin.drain()
            except Exception:  # noqa: BLE001
                pass

    async def teardown(self) -> None:
        if self._reader:
            self._reader.cancel()
        if self._proc and self._proc.returncode is None:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), 5.0)
            except (asyncio.TimeoutError, ProcessLookupError):
                try: self._proc.kill()
                except ProcessLookupError: pass
