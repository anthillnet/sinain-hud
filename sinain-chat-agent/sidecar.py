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

Env: selected provider stack from ~/.sinain/.env, with optional SINAIN_CHAT_* overrides,
     SINAIN_CHAT_REASONING (off|on, default off), SINAIN_CORE_URL, SINAIN_CHAT_WS_PORT (9610).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path


_PROCESS_ENV = dict(os.environ)
_FILE_ENV_KEYS: set[str] = set()


def _ensure_venv() -> None:
    """Self-bootstrap: if openhands isn't importable, we're running outside
    our venv (fresh checkout — the venv is gitignored and nothing else
    provisions it; sinaind falls back to system python3, which used to mean
    a silent crash loop). Create .venv, install requirements, and re-exec
    under the venv python. --prefer-binary: litellm's sdist builds a Rust
    component that fails on stock cargo — wheels sidestep it.
    """
    import importlib.util
    if importlib.util.find_spec("openhands") is not None:
        return
    if os.environ.get("SINAIN_CHAT_BOOTSTRAPPED"):
        sys.exit("[sinain-chat] openhands still missing after venv bootstrap — "
                 "install failed; check pip output above")
    from pathlib import Path
    import subprocess
    here = Path(__file__).resolve().parent
    venv_py = here / ".venv" / "bin" / "python"
    if not venv_py.exists():
        print("[sinain-chat] venv missing — bootstrapping (one-time, ~2 min)…",
              flush=True)
        subprocess.run([sys.executable, "-m", "venv", str(here / ".venv")],
                       check=True)
        subprocess.run(
            [str(venv_py), "-m", "pip", "install", "--quiet",
             "--disable-pip-version-check", "--prefer-binary",
             "-r", str(here / "requirements.txt")],
            check=True)
        print("[sinain-chat] venv ready", flush=True)
    os.environ["SINAIN_CHAT_BOOTSTRAPPED"] = "1"
    os.execv(str(venv_py), [str(venv_py), str(here / "sidecar.py")])


_ensure_venv()

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

log = logging.getLogger("sinain-chat")

# ── Harness control (2026-07-16) ─────────────────────────────────────────────
# A runaway turn compounded the resident Conversation to ~1M input tokens at
# $0.10/step, invisible to CostTracker (usage only shipped on `done`, which
# never came). The HARNESS owns the ceiling, not the agent:
#   - TURN_BUDGET_USD / TURN_MAX_INPUT_TOKENS: hard per-turn caps — crossing
#     either pauses the conversation and closes the turn with what it has.
#   - CONTEXT_RESET_TOKENS: a turn whose summed prompt tokens crossed this
#     rebuilds a fresh Conversation next turn — resident history stays bounded.
#   - Usage ticks every USAGE_TICK_SECONDS: cost deltas ship mid-turn, so
#     spend is visible in CostTracker while a turn runs, not just after it.
TURN_BUDGET_USD = float(os.environ.get("SINAIN_CHAT_TURN_BUDGET_USD", "0.50"))
TURN_MAX_INPUT_TOKENS = int(os.environ.get("SINAIN_CHAT_TURN_MAX_INPUT_TOKENS", "400000"))
CONTEXT_RESET_TOKENS = int(os.environ.get("SINAIN_CHAT_CONTEXT_RESET_TOKENS", "150000"))
USAGE_TICK_SECONDS = float(os.environ.get("SINAIN_CHAT_USAGE_TICK_SECONDS", "15"))

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
        cfg = await _resolve_provider()
        model = cfg["model"]
        # Provider: openrouter (cloud, default) or ollama (local). Local mode
        # FORCES ollama — a .env cloud pin must not win (observed 2026-07-15:
        # this lane analyzed an arc.dev assessment via OpenRouter despite
        # SINAIN_LOCAL_MODE=true). A file-vs-real-env precedence rule (like
        # core's de8b37d) is not implementable here: litellm/openhands
        # auto-load .env at import time, before our _load_env runs, so pin
        # origin is indistinguishable. The contract is absolute anyway — in
        # local mode the chat lane never talks to a cloud endpoint.
        provider = cfg["stack"]
        if provider == "local" and not os.environ.get("SINAIN_CHAT_ENDPOINT"):
            provider = "ollama"
        if provider in ("ollama", "local"):
            base = (cfg["base_url"]
                    or os.environ.get("SINAIN_CHAT_BASE_URL")
                    or os.environ.get("OLLAMA_BASE_URL")
                    or "http://localhost:11434")
            # litellm: use the ollama_chat/ provider (Ollama /api/chat) — it
            # supports function/tool-calling; the bare ollama/ provider hits
            # /api/generate and rejects the tool list (OllamaException).
            lm = model
            if lm.startswith("ollama_chat/"):
                model_id = lm
            elif lm.startswith("ollama/"):
                model_id = "ollama_chat/" + lm[len("ollama/"):]
            elif lm and "/" not in lm:
                model_id = f"ollama_chat/{lm}"     # bare ollama tag, e.g. qwen2.5:7b
            else:
                # unset / openrouter slug → local default. qwen2.5vl:7b is the
                # local-mode standard (serves vision + text lanes already).
                model_id = "ollama_chat/qwen2.5vl:7b"
            # ollama is keyless; litellm wants a non-empty key + api_base.
            # think:false — non-reasoning local models (qwen2.5, phi4-mini)
            # reject Ollama's `think` flag ("does not support thinking").
            llm_kwargs = dict(model=model_id, base_url=base,
                              api_key=SecretStr("ollama"),
                              litellm_extra_body={"think": False},
                              service_id="sinain-chat", stream=True)
        else:
            if not cfg["api_key"]:
                raise RuntimeError(f"sinain chat is not configured: {cfg['stack']} needs an API key — add it in AI Provider settings")
            model_id = "openrouter/" + model if provider == "openrouter" else "openai/" + model
            llm_kwargs = dict(model=model_id, base_url=cfg["base_url"],
                              api_key=SecretStr(cfg["api_key"]),
                              service_id="sinain-chat", stream=True)
            # reasoning:{enabled:false} is an OpenRouter-only param — cloud only.
            if os.environ.get("SINAIN_CHAT_REASONING", "off").lower() != "on":
                llm_kwargs["litellm_extra_body"] = {"reasoning": {"enabled": False}}
        llm = LLM(**llm_kwargs)
        self._llm = llm  # kept so each turn can read OpenHands usage metrics
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

            def _usage_snapshot():
                # OpenHands accumulates cost + tokens on the LLM across turns;
                # snapshot before/after so we can emit this turn's delta.
                try:
                    m = self._llm.metrics
                    tu = m.accumulated_token_usage
                    return (m.accumulated_cost or 0.0,
                            tu.prompt_tokens if tu else 0,
                            tu.completion_tokens if tu else 0)
                except Exception:  # noqa: BLE001
                    return (0.0, 0, 0)

            def _work():
                try:
                    self._conv.send_message(msg)
                    self._conv.run()
                    if self._gen == gen:
                        # Usage is attached by the consumer loop (it owns the
                        # tick ledger) — the worker only reports completion.
                        self._emit({"type": "done", "text": self._acc})
                except Exception as e:  # noqa: BLE001
                    if self._gen == gen:
                        self._emit({"type": "error", "text": f"{type(e).__name__}: {e}"})

            c0, p0, k0 = _usage_snapshot()
            reported = (c0, p0, k0)
            model_name = (getattr(self._llm.metrics, "model_name", "")
                          or os.environ.get("SINAIN_CHAT_MODEL", "sinain-chat"))

            def _delta_since_reported():
                # Usage since the last report — every terminal event and every
                # tick carries a DELTA, so core's CostTracker can sum blindly.
                nonlocal reported
                c, p, k = _usage_snapshot()
                d = {"cost": max(0.0, c - reported[0]),
                     "tokensIn": max(0, p - reported[1]),
                     "tokensOut": max(0, k - reported[2]),
                     "model": model_name}
                reported = (c, p, k)
                return d

            worker = asyncio.create_task(asyncio.to_thread(_work))
            stalled = False
            budget_stop: str | None = None
            last_event = time.monotonic()
            last_tick = time.monotonic()
            try:
                while True:
                    try:
                        ev = await asyncio.wait_for(self._q.get(), timeout=2.0)
                    except asyncio.TimeoutError:
                        ev = None
                    now = time.monotonic()

                    # The harness owns the ceiling: crossing either budget
                    # pauses the conversation; the turn closes with what it has.
                    if budget_stop is None:
                        c_now, p_now, _ = _usage_snapshot()
                        spent, toks = c_now - c0, p_now - p0
                        if spent > TURN_BUDGET_USD or toks > TURN_MAX_INPUT_TOKENS:
                            budget_stop = (f"turn budget exceeded "
                                           f"(${spent:.2f}, {toks} input tokens)")
                            log.warning("budget stop: %s", budget_stop)
                            self.cancel()  # pause — run() unwinds at the step boundary

                    if ev is None:
                        if now - last_event > TURN_TIMEOUT:
                            # No event for the whole window — the LLM call is
                            # wedged. Abandon it and rebuild next turn.
                            stalled = True
                            self.cancel()
                            yield {"type": "error",
                                   "text": f"chat turn stalled (>{int(TURN_TIMEOUT)}s) — resetting the chat lane",
                                   "usage": _delta_since_reported()}
                            break
                        if budget_stop is not None and now - last_event > 20:
                            # The paused run didn't unwind — close the turn
                            # ourselves with the partial answer.
                            stalled = True
                            yield {"type": "done",
                                   "text": f"{self._acc}\n\n[stopped: {budget_stop}]",
                                   "usage": _delta_since_reported()}
                            break
                        if now - last_tick >= USAGE_TICK_SECONDS:
                            last_tick = now
                            d = _delta_since_reported()
                            if d["cost"] or d["tokensIn"]:
                                yield {"type": "usage_tick", "usage": d}
                        continue

                    last_event = now
                    if now - last_tick >= USAGE_TICK_SECONDS:
                        # Mid-stream spend stays visible even while events flow.
                        last_tick = now
                        d = _delta_since_reported()
                        if d["cost"] or d["tokensIn"]:
                            yield {"type": "usage_tick", "usage": d}
                    if ev["type"] in ("done", "error"):
                        if budget_stop is not None and ev["type"] == "done":
                            ev["text"] = f"{ev.get('text') or self._acc}\n\n[stopped: {budget_stop}]"
                        ev["usage"] = _delta_since_reported()
                        yield ev
                        break
                    yield ev
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
                # Bounded resident history: a budget stop, or a turn whose
                # summed prompt tokens crossed the reset bound, rebuilds a
                # fresh Conversation next turn — history can't compound.
                _, p_end, _ = _usage_snapshot()
                if budget_stop is not None or (p_end - p0) > CONTEXT_RESET_TOKENS:
                    log.warning("resident history bound hit (%d turn prompt tokens) — fresh Conversation next turn",
                                p_end - p0)
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
        if req.get("type") == "status":
            await ws.send(json.dumps({"type": "status", "state": agent.state,
                                      "error": agent.error}))
            continue
        if agent.state != "running":
            await ws.send(json.dumps({"type": "error", "text": agent.error or
                                      "sinain chat is starting"}))
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
    agent.state = "starting"
    agent.error = None
    print(f"[sinain-chat] warming OpenHands ({os.environ.get('SINAIN_CHAT_MODEL', 'qwen/qwen3.5-flash-02-23')}, "
          f"reasoning={os.environ.get('SINAIN_CHAT_REASONING', 'off')})…", flush=True)
    try:
        await agent.setup()
        agent.state = "running"
        print(f"[sinain-chat] ready · ws://127.0.0.1:{port}", flush=True)
    except Exception as exc:  # config/warmup failures must not take down WS
        agent.state = "degraded"
        agent.error = str(exc)
        print(f"[sinain-chat] degraded: {agent.error}", file=sys.stderr, flush=True)

    async def retry_warmup():
        while True:
            await asyncio.sleep(60)
            if agent.state == "running":
                continue
            _load_env()
            try:
                await agent.setup()
                agent.state = "running"
                agent.error = None
                print("[sinain-chat] configuration healed · ready", flush=True)
            except Exception as exc:  # noqa: BLE001
                agent.state = "degraded"
                agent.error = str(exc)

    asyncio.create_task(retry_warmup())

    async def bound(ws):  # websockets>=11 passes only the connection
        await _handler(agent, ws)

    async with websockets.serve(bound, "127.0.0.1", port):
        await asyncio.Future()  # run forever


def _load_env() -> None:
    # Process env wins. File values are rebuilt on every call so adding or
    # changing a provider key heals the degraded sidecar without a restart.
    for key in _FILE_ENV_KEYS:
        if key not in _PROCESS_ENV:
            os.environ.pop(key, None)
    _FILE_ENV_KEYS.clear()
    here = Path(__file__).resolve().parent
    for env in (here / ".env", Path.home() / ".sinain" / ".env", here.parent / ".env"):
        if not env.exists():
            continue
        for ln in env.read_text().splitlines():
            ln = ln.strip()
            if ln and not ln.startswith("#") and "=" in ln:
                k, v = ln.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k not in os.environ:
                    os.environ[k] = v
                    _FILE_ENV_KEYS.add(k)


def _openai_base(endpoint: str) -> str:
    endpoint = endpoint.rstrip("/")
    suffix = "/chat/completions"
    return endpoint[:-len(suffix)] if endpoint.endswith(suffix) else endpoint


async def _provider_status() -> dict:
    import urllib.request
    def fetch():
        try:
            with urllib.request.urlopen("http://127.0.0.1:9500/setup/providers", timeout=2) as res:
                return json.loads(res.read())
        except Exception:  # noqa: BLE001
            return {}
    return await asyncio.to_thread(fetch)


async def _resolve_provider() -> dict[str, str]:
    endpoint = os.environ.get("SINAIN_CHAT_ENDPOINT", "").strip()
    explicit_key = os.environ.get("SINAIN_CHAT_API_KEY", "").strip()
    explicit_model = os.environ.get("SINAIN_CHAT_MODEL", "").strip()
    analysis_endpoint = os.environ.get("ANALYSIS_ENDPOINT", "").strip()
    burst = os.environ.get("BURST_PROVIDER", "").lower()
    local = os.environ.get("SINAIN_LOCAL_MODE", "").lower() == "true"
    if local:
        stack = "local"
    elif burst == "cerebras" or "cerebras.ai" in analysis_endpoint:
        stack = "cerebras"
    elif burst == "openrouter" or "openrouter.ai" in analysis_endpoint:
        stack = "openrouter"
    else:
        status = await _provider_status()
        stack = str(status.get("activeStack") or "openrouter").lower()

    default_model = "qwen/qwen3.5-flash-02-23"
    if stack == "cerebras":
        base = "https://api.cerebras.ai/v1"
        key = os.environ.get("CEREBRAS_API_KEY", "").strip()
        model = os.environ.get("SINAIN_CHAT_MODEL_CEREBRAS", "").strip() or os.environ.get("ANALYSIS_MODEL", "gemma-4-31b")
    elif stack == "local":
        base = _openai_base(analysis_endpoint) if analysis_endpoint else "http://localhost:11434"
        key = "local"
        model = os.environ.get("ANALYSIS_MODEL", "").strip() or os.environ.get("SINAIN_LOCAL_LLM", "qwen2.5vl:7b")
    else:
        stack = "openrouter"
        base = "https://openrouter.ai/api/v1"
        key = os.environ.get("OPENROUTER_API_KEY", "").strip()
        model = default_model
    return {"stack": stack, "base_url": _openai_base(endpoint) if endpoint else base,
            "api_key": explicit_key or key, "model": explicit_model or model}


if __name__ == "__main__":
    asyncio.run(main())
