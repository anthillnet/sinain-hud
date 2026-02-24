"""OpenClaw WebSocket gateway client — Python port of openclaw-ws.ts.

Protocol:
  1. Server sends connect.challenge event
  2. Client responds with connect request + auth token
  3. Client sends 'agent' RPC, server replies with two frames:
     - {payload: {status: "accepted"}} (intermediate, skip)
     - {ok: true, payload: {result: {payloads: [{text: "..."}]}}} (final)
  4. Reconnect with exponential backoff on disconnect
"""

from __future__ import annotations

import asyncio
import json
import logging
import platform
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import aiohttp

log = logging.getLogger(__name__)

TAG = "gateway"


@dataclass
class _PendingRpc:
    future: asyncio.Future[Any]
    timeout_handle: asyncio.TimerHandle
    expect_final: bool


class OpenClawGateway:
    """Persistent async WebSocket client to the OpenClaw gateway."""

    def __init__(
        self,
        ws_url: str,
        token: str,
        session_key: str,
        *,
        on_connected: Callable[[], Any] | None = None,
        on_response: Callable[[str], Awaitable[None] | None] | None = None,
        on_disconnected: Callable[[], Any] | None = None,
    ):
        self.ws_url = ws_url
        self.token = token
        self.session_key = session_key

        # Callbacks
        self._on_connected = on_connected
        self._on_response = on_response
        self._on_disconnected = on_disconnected

        # State
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._session: aiohttp.ClientSession | None = None
        self._authenticated = False
        self._rpc_id = 1
        self._pending: dict[str, _PendingRpc] = {}
        self._closing = False

        # Reconnect backoff
        self._reconnect_delay = 1.0
        self._max_reconnect_delay = 60.0

        # Circuit breaker
        self._recent_failures: list[float] = []
        self._circuit_open = False
        self._circuit_reset_handle: asyncio.TimerHandle | None = None
        self._CIRCUIT_THRESHOLD = 5
        self._CIRCUIT_WINDOW_S = 120.0
        self._circuit_reset_s = 300.0          # mutable, starts at 5 min, doubles on each trip
        self._MAX_CIRCUIT_RESET_S = 1800.0     # caps at 30 min

    @property
    def is_connected(self) -> bool:
        return self._ws is not None and not self._ws.closed and self._authenticated

    @property
    def is_circuit_open(self) -> bool:
        return self._circuit_open

    async def run(self, stop_event: asyncio.Event) -> None:
        """Main loop: connect, read messages, reconnect on failure."""
        while not stop_event.is_set():
            if self._circuit_open:
                log.info("[%s] circuit breaker open, waiting...", TAG)
                await asyncio.sleep(5)
                continue

            try:
                await self._connect_and_listen(stop_event)
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.warning("[%s] connection error: %s", TAG, e)

            if stop_event.is_set():
                break

            # Reconnect with backoff
            log.info("[%s] reconnecting in %.1fs...", TAG, self._reconnect_delay)
            try:
                await asyncio.wait_for(stop_event.wait(), self._reconnect_delay)
                break  # stop_event was set
            except asyncio.TimeoutError:
                pass  # timeout expired, try reconnecting
            self._reconnect_delay = min(
                self._reconnect_delay * 2, self._max_reconnect_delay
            )

        await self.close()

    async def _connect_and_listen(self, stop_event: asyncio.Event) -> None:
        """Single connection lifecycle: connect, authenticate, read messages."""
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()

        log.info("[%s] connecting to %s", TAG, self.ws_url)
        self._ws = await self._session.ws_connect(
            self.ws_url, heartbeat=30, timeout=15
        )
        self._authenticated = False
        self._reconnect_delay = 1.0  # reset backoff on successful connect
        log.info("[%s] ws connected (awaiting challenge)", TAG)

        try:
            async for msg in self._ws:
                if stop_event.is_set():
                    break
                if msg.type == aiohttp.WSMsgType.TEXT:
                    try:
                        data = json.loads(msg.data)
                        await self._handle_message(data)
                    except json.JSONDecodeError:
                        log.warning("[%s] invalid JSON: %s", TAG, msg.data[:200])
                elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    break
        finally:
            self._on_disconnect()

    async def _handle_message(self, msg: dict) -> None:
        """Route incoming WS messages through the protocol state machine."""
        # 1. Handle connect.challenge
        if msg.get("type") == "event" and msg.get("event") == "connect.challenge":
            log.info("[%s] received challenge, authenticating...", TAG)
            await self._send_json({
                "type": "req",
                "id": "connect-1",
                "method": "connect",
                "params": {
                    "minProtocol": 3,
                    "maxProtocol": 3,
                    "client": {
                        "id": "gateway-client",
                        "displayName": "Sinain Wearable HUD",
                        "version": "1.0.0",
                        "platform": platform.system().lower(),
                        "mode": "backend",
                    },
                    "auth": {"token": self.token},
                },
            })
            return

        # 2. Handle connect response (auth result)
        if msg.get("type") == "res" and msg.get("id") == "connect-1":
            if msg.get("ok"):
                self._authenticated = True
                log.info("[%s] authenticated", TAG)
                if self._on_connected:
                    self._on_connected()
            else:
                err = msg.get("error") or msg.get("payload", {}).get("error", "unknown")
                log.error("[%s] auth failed: %s", TAG, err)
                # Auth failure likely means bad params — slow down reconnect
                self._reconnect_delay = max(self._reconnect_delay, 30.0)
                if self._ws and not self._ws.closed:
                    await self._ws.close()
            return

        # 3. Handle RPC responses
        msg_id = str(msg["id"]) if "id" in msg else None
        if msg.get("type") == "res" and msg_id and msg_id in self._pending:
            pending = self._pending[msg_id]

            # Skip intermediate "accepted" frame when expecting final
            payload = msg.get("payload", {})
            if pending.expect_final and payload.get("status") == "accepted":
                log.debug("[%s] rpc %s: accepted (waiting for final)", TAG, msg_id)
                return

            # Final response
            pending.timeout_handle.cancel()
            del self._pending[msg_id]

            if not pending.future.done():
                pending.future.set_result(msg)

    async def send_agent_rpc(self, message: str, idempotency_key: str) -> dict | None:
        """Send an agent RPC and wait for the final response.

        Returns the full response dict, or None on failure.
        """
        if self._circuit_open:
            log.warning("[%s] circuit breaker open, skipping RPC", TAG)
            return None

        if not self.is_connected:
            log.warning("[%s] not connected, cannot send RPC", TAG)
            return None

        rpc_id = str(self._rpc_id)
        self._rpc_id += 1

        loop = asyncio.get_event_loop()
        future: asyncio.Future[Any] = loop.create_future()

        def on_timeout() -> None:
            if rpc_id in self._pending:
                del self._pending[rpc_id]
                self._on_rpc_failure()
                if not future.done():
                    future.set_exception(asyncio.TimeoutError(f"rpc timeout: agent"))

        timeout_handle = loop.call_later(60.0, on_timeout)
        self._pending[rpc_id] = _PendingRpc(
            future=future, timeout_handle=timeout_handle, expect_final=True
        )

        await self._send_json({
            "type": "req",
            "method": "agent",
            "id": rpc_id,
            "params": {
                "message": message,
                "sessionKey": self.session_key,
                "idempotencyKey": idempotency_key,
                "deliver": False,
            },
        })
        log.debug("[%s] agent RPC sent (id=%s): %s", TAG, rpc_id, message[:100])

        try:
            resp = await future
        except (asyncio.TimeoutError, asyncio.CancelledError) as e:
            log.warning("[%s] agent RPC failed: %s", TAG, e)
            return None

        # Extract text from response
        if resp.get("ok"):
            self._circuit_reset_s = 300.0  # reset backoff on success
            payloads = (
                resp.get("payload", {})
                .get("result", {})
                .get("payloads", [])
            )
            texts = [p["text"] for p in payloads if "text" in p]
            response_text = "\n".join(texts) if texts else ""

            if response_text and self._on_response:
                result = self._on_response(response_text)
                if asyncio.iscoroutine(result):
                    await result

            return resp
        else:
            err = resp.get("error", "unknown error")
            log.warning("[%s] agent RPC error: %s", TAG, err)
            self._on_rpc_failure()
            return resp

    async def _send_json(self, data: dict) -> None:
        if self._ws and not self._ws.closed:
            await self._ws.send_str(json.dumps(data))

    def _on_disconnect(self) -> None:
        """Clean up after a disconnect."""
        self._ws = None
        self._authenticated = False
        # Reject all pending RPCs
        for rpc_id, pending in list(self._pending.items()):
            pending.timeout_handle.cancel()
            if not pending.future.done():
                pending.future.set_exception(
                    ConnectionError("gateway disconnected")
                )
        self._pending.clear()
        log.info("[%s] disconnected", TAG)
        if self._on_disconnected:
            self._on_disconnected()

    def _on_rpc_failure(self) -> None:
        now = time.monotonic()
        self._recent_failures.append(now)
        cutoff = now - self._CIRCUIT_WINDOW_S
        self._recent_failures = [t for t in self._recent_failures if t > cutoff]

        if len(self._recent_failures) >= self._CIRCUIT_THRESHOLD and not self._circuit_open:
            self._circuit_open = True
            next_delay = min(self._circuit_reset_s * 2, self._MAX_CIRCUIT_RESET_S)
            log.warning(
                "[%s] circuit breaker opened after %d failures — pausing for %.0fs (next reset: %.0fs)",
                TAG, len(self._recent_failures), self._circuit_reset_s, next_delay,
            )

            def reset_circuit() -> None:
                self._circuit_open = False
                self._recent_failures.clear()
                log.info("[%s] circuit breaker reset", TAG)

            loop = asyncio.get_event_loop()
            self._circuit_reset_handle = loop.call_later(
                self._circuit_reset_s, reset_circuit
            )
            # Progressive backoff: double the delay for next trip, capped at MAX
            self._circuit_reset_s = next_delay

    async def close(self) -> None:
        """Graceful shutdown."""
        self._closing = True
        if self._circuit_reset_handle:
            self._circuit_reset_handle.cancel()
            self._circuit_reset_handle = None
        if self._ws and not self._ws.closed:
            await self._ws.close()
        self._on_disconnect()
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None
