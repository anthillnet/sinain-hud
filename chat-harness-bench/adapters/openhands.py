"""OpenHands SDK adapter (MIT).  install: pip install openhands-sdk   (in .venv)

Wires sinain's tools as native OpenHands ToolDefinitions (executors call
sinain_tools.dispatch and emit contract events), streams CONTENT tokens via
LocalConversation.token_callbacks (reasoning deltas excluded → correct ttfc on the
deepseek reasoning model), and bridges the SDK's synchronous run() into the async
contract via a thread + a thread-safe asyncio.Queue.
"""
from __future__ import annotations

import asyncio
import os
from typing import AsyncIterator

from pydantic import SecretStr

from openhands.sdk import LLM, Agent, Conversation, Tool, register_tool
from openhands.sdk.llm.message import TextContent
from openhands.sdk.tool import Action, Observation, ToolAnnotations, ToolDefinition, ToolExecutor

from contract import Adapter, ChatContext, Event
from sinain_tools import dispatch


# ── Action schemas (these become the tool param schemas the model sees) ──────
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


# ── Per-run event sink (bench is sequential; one active run at a time) ────────
_SINK: "EventSink | None" = None


class EventSink:
    def __init__(self, loop: asyncio.AbstractEventLoop, q: "asyncio.Queue[Event]") -> None:
        self.loop, self.q = loop, q

    def emit(self, ev: Event) -> None:  # called from the conv.run() worker thread
        self.loop.call_soon_threadsafe(self.q.put_nowait, ev)


class _SinainExecutor(ToolExecutor):
    def __init__(self, tool_name: str) -> None:
        self.tool_name = tool_name

    def __call__(self, action: Action, conversation=None) -> Observation:  # noqa: ANN001
        args = action.model_dump()
        if _SINK:
            _SINK.emit(Event("tool_call", tool_name=self.tool_name, tool_args=args))
        result = dispatch(self.tool_name, args)
        if _SINK:
            _SINK.emit(Event("tool_result", tool_name=self.tool_name, tool_result=result[:500]))
        return SinainObs(content=[TextContent(text=result)])


def _annot() -> ToolAnnotations:
    return ToolAnnotations(readOnlyHint=True, destructiveHint=False,
                           idempotentHint=False, openWorldHint=True)


def _make_tool_class(name: str, action_cls: type, desc: str) -> type:
    """Build a ToolDefinition subclass mirroring the built-in ThinkTool pattern."""
    def create(cls, conv_state=None, **params):  # noqa: ANN001, ARG001
        return [cls(description=desc, action_type=action_cls, observation_type=SinainObs,
                    executor=_SinainExecutor(name), annotations=_annot())]
    return type(f"SinainTool_{name}", (ToolDefinition,),
               {"create": classmethod(create)})


# Lean 7-core (docs/chat-harness-evaluation.md §9c) — curated, not the kitchen sink.
_SPECS = [
    ("sinain_memory_query", MemoryQueryAction, "Query the user's knowledge graph (facts/entities)."),
    ("sinain_context", EmptyAction, "Get the user's current situation: digest + screen OCR/vision, audio, app history."),
    ("sinain_memory_store", MemoryStoreAction, "Save a fact/note to the user's long-term memory."),
    ("read_file", ReadFileAction, "Read a UTF-8 text file by absolute path."),
    ("bash", BashAction, "Run a read-only shell command to orient on the machine."),
    ("grep", GrepAction, "Search file contents for a pattern under a path."),
    ("glob", GlobAction, "Find files matching a glob pattern."),
]
_REGISTERED = False


class OpenHandsAdapter(Adapter):
    name = "openhands"

    def __init__(self) -> None:
        self._conv = None
        self._acc = ""

    async def setup(self) -> None:
        global _REGISTERED
        if not _REGISTERED:
            for name, action_cls, desc in _SPECS:
                register_tool(name, _make_tool_class(name, action_cls, desc))
            _REGISTERED = True
        llm_kwargs = dict(model="openrouter/" + os.environ.get("BENCH_MODEL", "deepseek/deepseek-v4-flash"),
                          api_key=SecretStr(os.environ["OPENROUTER_API_KEY"]), service_id="bench",
                          stream=True)  # stream=True required for token_callbacks (→ ttfc)
        if os.environ.get("BENCH_NO_REASONING"):  # disable reasoning for fast chat models
            llm_kwargs["litellm_extra_body"] = {"reasoning": {"enabled": False}}
        llm = LLM(**llm_kwargs)
        # include_default_tools (list[str]) defaults to the built-ins (finish/think) that
        # let the agent terminate — omit it so that default applies.
        agent = Agent(llm=llm, tools=[Tool(name=n) for n, _, _ in _SPECS])
        ws = os.path.join(os.path.dirname(__file__), "..", "oh_ws")
        os.makedirs(ws, exist_ok=True)

        def on_token(chunk) -> None:  # litellm ModelResponseStream, runs in worker thread
            try:
                delta = chunk.choices[0].delta
            except (AttributeError, IndexError):
                return
            if getattr(delta, "reasoning", None) or getattr(delta, "reasoning_content", None):
                if _SINK:
                    _SINK.emit(Event("progress", text="reasoning"))
            content = getattr(delta, "content", None)
            if content:
                self._acc += content
                if _SINK:
                    _SINK.emit(Event("token", text=content))

        self._conv = Conversation(agent=agent, workspace=ws, token_callbacks=[on_token])

    async def cancel(self) -> None:
        if self._conv is not None:
            try:
                self._conv.pause()
            except Exception:  # noqa: BLE001
                pass

    async def run(self, message: str, context: ChatContext) -> AsyncIterator[Event]:
        global _SINK
        self._acc = ""
        loop = asyncio.get_running_loop()
        q: asyncio.Queue[Event] = asyncio.Queue()
        _SINK = EventSink(loop, q)
        msg = message if not context.seed else f"[{context.kind} context]\n{context.seed}\n\n{message}"

        def _work() -> None:
            try:
                self._conv.send_message(msg)
                self._conv.run()
                _SINK.emit(Event("done", text=self._acc))
            except Exception as e:  # noqa: BLE001
                _SINK.emit(Event("error", text=f"{type(e).__name__}: {e}"))

        worker = asyncio.create_task(asyncio.to_thread(_work))
        try:
            while True:
                ev = await q.get()
                yield ev
                if ev.type in ("done", "error"):
                    break
        finally:
            await worker
            _SINK = None
