"""HTTP/WebSocket debug server — view HUD from Mac browser."""

from __future__ import annotations

import asyncio
import io
import json
import logging
from pathlib import Path

from aiohttp import web

from .protocol import DisplayState

log = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).parent.parent / "static"


class DisplayServer:
    """Serves a browser-based mirror of the OLED display.

    - GET /         → static/index.html
    - GET /ws       → WebSocket pushing display_state JSON on change
    - GET /frame    → current OLED frame as PNG (for polling fallback)
    """

    def __init__(self, config: dict, display_state: DisplayState,
                 get_frame=None):
        self.config = config.get("debug_server", {})
        self.state = display_state
        self.get_frame = get_frame  # callable returning PIL Image or None
        self.host = self.config.get("host", "0.0.0.0")
        self.port = self.config.get("port", 8080)
        self._ws_clients: list[web.WebSocketResponse] = []
        self._app: web.Application | None = None
        self._runner: web.AppRunner | None = None

    def _build_app(self) -> web.Application:
        app = web.Application()
        app.router.add_get("/ws", self._ws_handler)
        app.router.add_get("/frame", self._frame_handler)
        app.router.add_static("/", STATIC_DIR, show_index=True)
        return app

    async def _ws_handler(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        self._ws_clients.append(ws)
        log.info("Debug client connected (%d total)", len(self._ws_clients))

        # Send current state immediately
        await ws.send_json(self.state.to_dict())

        try:
            async for msg in ws:
                pass  # Client doesn't send anything, just receives
        finally:
            self._ws_clients.remove(ws)
            log.info("Debug client disconnected (%d remaining)",
                     len(self._ws_clients))
        return ws

    async def _frame_handler(self, request: web.Request) -> web.Response:
        """Return current OLED frame as PNG for polling/debug."""
        frame = self.get_frame() if self.get_frame else None
        if frame is None:
            return web.Response(status=204)
        buf = io.BytesIO()
        frame.save(buf, format="PNG")
        return web.Response(body=buf.getvalue(),
                            content_type="image/png")

    async def _broadcast_loop(self, stop_event: asyncio.Event) -> None:
        """Push state updates to all connected WebSocket clients."""
        last_update = 0.0
        while not stop_event.is_set():
            if self.state.last_update > last_update and self._ws_clients:
                last_update = self.state.last_update
                data = json.dumps(self.state.to_dict())
                dead = []
                for ws in self._ws_clients:
                    try:
                        await ws.send_str(data)
                    except Exception:
                        dead.append(ws)
                for ws in dead:
                    self._ws_clients.remove(ws)
            await asyncio.sleep(0.1)

    async def run(self, stop_event: asyncio.Event) -> None:
        """Start HTTP server and broadcast loop."""
        if not self.config.get("enabled", True):
            log.info("Debug server disabled")
            return

        self._app = self._build_app()
        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self.host, self.port)
        await site.start()
        log.info("Debug server at http://%s:%d", self.host, self.port)

        try:
            await self._broadcast_loop(stop_event)
        finally:
            await self._runner.cleanup()
