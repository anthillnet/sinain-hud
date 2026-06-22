"""sinain chat-agent sidecar — resident OpenHands Conversation behind a WebSocket.

The responsive-chat stack validated in chat-harness-bench:
  - fast NON-reasoning model (qwen3.5-flash, reasoning OFF via litellm_extra_body)
    → ~0.6s first token, 1–4s end-to-end with real sinain tools (~10× vs a reasoning model)
  - RESIDENT Conversation (warm; init/tools paid once at startup, not per turn)
  - LEAN 7-tool surface (tools.py) so the system prompt stays small (fast TTFT)
  - token streaming (agent_message_chunk → token events)

sinain-core's ChatService connects over WS and relays to the overlay. Protocol:
  → client text frame:  {"message": "...", "context": {"kind":"main"|"roi", "seed":"..."}}
                        {"cancel": true}            (interrupt the in-flight turn)
  ← server NDJSON-over-WS event frames:
      {"type":"token","text":"..."}            (assistant CONTENT delta)
      {"type":"tool_call","tool_name":"...","tool_args":{...}}
      {"type":"tool_result","tool_name":"...","tool_result":"..."}
      {"type":"progress","text":"reasoning"}   (suppressed when reasoning is off)
      {"type":"done","text":"<full reply>"}
      {"type":"error","text":"..."}

Env: OPENROUTER_API_KEY (required), SINAIN_CHAT_MODEL (default qwen/qwen3.5-flash-02-23),
     SINAIN_CHAT_REASONING (off|on, default off), SINAIN_CORE_URL, SINAIN_CHAT_WS_PORT (9610).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os

import websockets
from pydantic import SecretStr

from openhands.sdk import LLM, Agent, Conversation, Tool

import tools

# Per-turn idle watchdog. If a turn produces NO event for this long, the
# underlying LLM call is treated as wedged (e.g. an OpenRouter stream that only
# emits `: PROCESSING` keepalives and never finishes). We abandon it and rebuild
# the Conversation so one stalled turn can't permanently wedge the resident chat
# lane — previously this required a manual sidecar restart. Default 90s.
TURN_TIMEOUT = float(os.environ.get("SINAIN_CHAT_TURN_TIMEOUT", "90"))

SYSTEM = (
    "You are Sinain's chat assistant — a fast, concise helper with access to the user's "
    "private knowledge graph, their current screen/audio context, and their machine. "
    "Prefer a tool over guessing; answer directly and briefly. Do only what's asked."
)


class ChatAgent:
    """Resident OpenHands Conversation. setup() once; run() per turn."""

    def __init__(self) -> None:
        self._conv = None
        self._acc = ""
        self._q: asyncio.Queue | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        # One resident Conversation serves BOTH user chat and ambient
        # escalations. Serialize turns (a single Conversation can't run two at
        # once) and let a USER turn preempt an in-flight ESCALATION so the user
        # is never starved. _lock = one turn at a time; _active = its source.
        self._lock = asyncio.Lock()
        self._active_source: str | None = None
        # Set when a turn stalls and we abandon its (wedged) worker thread — the
        # next turn rebuilds a fresh Conversation before running. _gen tags the
        # current turn so a late-unwinding abandoned worker can't emit its
        # done/error into a newer turn's queue.
        self._needs_resetup = False
        self._gen = 0

    async def setup(self) -> None:
        tools.register_all()
        model = os.environ.get("SINAIN_CHAT_MODEL", "qwen/qwen3.5-flash-02-23")
        # Provider: openrouter (cloud, default) or ollama (local). Auto-detect
        # local from SINAIN_LOCAL_MODE if SINAIN_CHAT_PROVIDER is unset.
        provider = os.environ.get("SINAIN_CHAT_PROVIDER", "").lower()
        if not provider:
            provider = "ollama" if os.environ.get("SINAIN_LOCAL_MODE") == "true" else "openrouter"
        if provider in ("ollama", "local"):
            base = (os.environ.get("SINAIN_CHAT_BASE_URL")
                    or os.environ.get("OLLAMA_BASE_URL")
                    or "http://localhost:11434")
            # litellm: use the ollama_chat/ provider (Ollama /api/chat) — it
            # supports function/tool-calling; the bare ollama/ provider hits
            # /api/generate and rejects the tool list (OllamaException).
            lm = os.environ.get("SINAIN_CHAT_MODEL", "")
            if lm.startswith("ollama_chat/"):
                model_id = lm
            elif lm.startswith("ollama/"):
                model_id = "ollama_chat/" + lm[len("ollama/"):]
            elif lm and "/" not in lm:
                model_id = f"ollama_chat/{lm}"     # bare ollama tag, e.g. qwen2.5:7b
            else:
                model_id = "ollama_chat/qwen2.5:7b"  # unset / openrouter slug → local default
            # ollama is keyless; litellm wants a non-empty key + api_base.
            # think:false — non-reasoning local models (qwen2.5, phi4-mini)
            # reject Ollama's `think` flag ("does not support thinking").
            llm_kwargs = dict(model=model_id, base_url=base,
                              api_key=SecretStr("ollama"),
                              litellm_extra_body={"think": False},
                              service_id="sinain-chat", stream=True)
        else:
            llm_kwargs = dict(model="openrouter/" + model,
                              api_key=SecretStr(os.environ["OPENROUTER_API_KEY"]),
                              service_id="sinain-chat", stream=True)
            # reasoning:{enabled:false} is an OpenRouter-only param — cloud only.
            if os.environ.get("SINAIN_CHAT_REASONING", "off").lower() != "on":
                llm_kwargs["litellm_extra_body"] = {"reasoning": {"enabled": False}}
        llm = LLM(**llm_kwargs)
        agent = Agent(llm=llm, tools=[Tool(name=n) for n, _, _ in tools.SPECS],
                      system_prompt_kwargs={}, system_prompt=SYSTEM)
        ws = os.path.join(os.path.dirname(__file__), ".workspace")
        os.makedirs(ws, exist_ok=True)
        self._loop = asyncio.get_running_loop()

        def on_token(chunk) -> None:  # runs in the conv.run() worker thread
            try:
                delta = chunk.choices[0].delta
            except (AttributeError, IndexError):
                return
            txt = getattr(delta, "content", None)
            if txt:
                self._acc += txt
                self._emit({"type": "token", "text": txt})

        # sinain tool executors emit via tools.SINK → the same queue
        tools.SINK = self._emit
        self._conv = Conversation(agent=agent, workspace=ws, token_callbacks=[on_token])

    def _emit(self, ev: dict) -> None:
        if self._q is not None and self._loop is not None:
            self._loop.call_soon_threadsafe(self._q.put_nowait, ev)

    async def run(self, message: str, context: dict):
        source = (context or {}).get("source") or "user"
        seed = (context or {}).get("seed") or ""
        kind = (context or {}).get("kind") or "main"

        # Escalations are ephemeral. If a turn is already running, DROP this one
        # rather than queue — a backlog of ambient escalations would pile up on
        # the single Conversation and starve user turns.
        if source != "user" and self._lock.locked():
            yield {"type": "done", "text": ""}
            return

        # A user turn PREEMPTS an in-flight escalation so the user is never
        # starved: signal the running turn to stop (run() resets PAUSED→RUNNING
        # for our turn), then wait for the lock as it unwinds.
        if source == "user" and self._lock.locked() and self._active_source != "user":
            self.cancel()

        async with self._lock:
            # Recover from a prior wedged turn: rebuild a fresh Conversation so a
            # stalled turn we abandoned can't block this one.
            if self._needs_resetup:
                await self.setup()
                self._needs_resetup = False
            self._gen += 1
            gen = self._gen
            self._active_source = source
            self._acc = ""
            self._q = asyncio.Queue()
            msg = message if not seed else f"[{kind} context]\n{seed}\n\n{message}"

            def _work():
                try:
                    self._conv.send_message(msg)
                    self._conv.run()
                    if self._gen == gen:
                        self._emit({"type": "done", "text": self._acc})
                except Exception as e:  # noqa: BLE001
                    if self._gen == gen:
                        self._emit({"type": "error", "text": f"{type(e).__name__}: {e}"})

            worker = asyncio.create_task(asyncio.to_thread(_work))
            stalled = False
            try:
                while True:
                    try:
                        ev = await asyncio.wait_for(self._q.get(), timeout=TURN_TIMEOUT)
                    except asyncio.TimeoutError:
                        # No event for the whole window — the LLM call is wedged.
                        # Abandon it (don't block the lane) and rebuild next turn.
                        stalled = True
                        self.cancel()
                        yield {"type": "error",
                               "text": f"chat turn stalled (>{int(TURN_TIMEOUT)}s) — resetting the chat lane"}
                        break
                    yield ev
                    if ev["type"] in ("done", "error"):
                        break
            finally:
                if stalled:
                    # The worker thread is stuck in a blocking call we can't
                    # cancel; flag a rebuild and let it unwind in the background
                    # rather than awaiting it (which would re-wedge the lane).
                    self._needs_resetup = True
                else:
                    try:
                        await asyncio.wait_for(asyncio.shield(worker), timeout=5)
                    except asyncio.TimeoutError:
                        self._needs_resetup = True
                self._active_source = None

    def cancel(self) -> None:
        if self._conv is not None:
            try:
                self._conv.pause()
            except Exception:  # noqa: BLE001
                pass


async def _handler(agent: "ChatAgent", ws) -> None:
    async for raw in ws:
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            await ws.send(json.dumps({"type": "error", "text": "bad JSON"}))
            continue
        if req.get("cancel"):
            agent.cancel()
            continue
        async for ev in agent.run(req.get("message", ""), req.get("context") or {}):
            await ws.send(json.dumps(ev))


async def main() -> None:
    _load_env()
    # core's liveness check (probeChatSidecar) opens a plain TCP socket to :9610
    # and closes it; the websockets server logs that as a failed handshake — a
    # full traceback every poll, which floods backend.log and buries real
    # errors. Quiet it. Genuine chat clients use a proper WS handshake and are
    # unaffected.
    logging.getLogger("websockets.server").setLevel(logging.CRITICAL)
    port = int(os.environ.get("SINAIN_CHAT_WS_PORT", "9610"))
    agent = ChatAgent()
    print(f"[sinain-chat] warming OpenHands ({os.environ.get('SINAIN_CHAT_MODEL', 'qwen/qwen3.5-flash-02-23')}, "
          f"reasoning={os.environ.get('SINAIN_CHAT_REASONING', 'off')})…", flush=True)
    await agent.setup()
    print(f"[sinain-chat] ready · ws://127.0.0.1:{port}", flush=True)

    async def bound(ws):  # websockets>=11 passes only the connection
        await _handler(agent, ws)

    async with websockets.serve(bound, "127.0.0.1", port):
        await asyncio.Future()  # run forever


def _load_env() -> None:
    from pathlib import Path
    env = Path(__file__).parent / ".env"
    if env.exists():
        for ln in env.read_text().splitlines():
            ln = ln.strip()
            if ln and not ln.startswith("#") and "=" in ln:
                k, v = ln.split("=", 1)
                os.environ.setdefault(k, v)


if __name__ == "__main__":
    asyncio.run(main())
