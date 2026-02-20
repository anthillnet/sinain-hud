"""Async orchestrator — wires camera, audio, display, gateway, and sender."""

from __future__ import annotations

import argparse
import asyncio
import logging
import signal
import sys

from .audio import AudioCapture
from .camera import CameraCapture
from .config import load_config
from .display import OLEDDisplay
from .display_server import DisplayServer
from .gateway import OpenClawGateway
from .observation import ObservationBuffer
from .ocr import OCREngine
from .protocol import AudioChunk, DisplayState, RoomFrame
from .sender import Sender

log = logging.getLogger("sinain-wearable-hud")


async def run(config: dict) -> None:
    """Start all subsystems and run until stopped."""
    stop_event = asyncio.Event()

    # Wire SIGTERM/SIGINT to stop
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop_event.set)

    # Shared state
    display_state = DisplayState(status="idle", gateway_status="disconnected")
    display_state.update("SinainHUD\nConnecting...")

    # Gateway config
    gw_cfg = config.get("gateway", {})
    ws_url = gw_cfg.get("ws_url", "ws://85.214.180.247:18789")
    token = gw_cfg.get("token", "")
    session_key = gw_cfg.get("session_key", "agent:main:sinain")

    # Gateway response callback → update OLED with agent response
    async def on_gateway_response(text: str) -> None:
        display_state.set_response(text)
        display_state.update(text, status="connected")

    def on_gateway_connected() -> None:
        display_state.gateway_status = "connected"
        display_state.update("SinainHUD\nGateway connected.", status="connected")
        log.info("Gateway connected")

    def on_gateway_disconnected() -> None:
        display_state.gateway_status = "disconnected"
        display_state.update("SinainHUD\nReconnecting...", status="idle")

    # Components
    gateway = OpenClawGateway(
        ws_url=ws_url,
        token=token,
        session_key=session_key,
        on_connected=on_gateway_connected,
        on_response=on_gateway_response,
        on_disconnected=on_gateway_disconnected,
    )
    ocr_engine = OCREngine(config)
    observation_buffer = ObservationBuffer(config)
    sender = Sender(config, gateway, observation_buffer=observation_buffer)
    oled = OLEDDisplay(config.get("display", {}), display_state)

    async def on_frame(frame: RoomFrame) -> None:
        debug_text = (
            f"[{frame.classification.value}] ssim={frame.ssim:.2f}"
            f" motion={frame.motion_pct:.0f}%"
        )
        display_state.set_debug(debug_text)
        display_state.status = "thinking"
        await sender.send_frame(frame)

    async def on_audio(chunk: AudioChunk) -> None:
        display_state.set_debug(f"Speech: {chunk.duration_s:.1f}s")
        display_state.status = "listening"
        sender.add_audio_transcript(
            f"[speech detected, {chunk.duration_s:.1f}s]", chunk.duration_s)
        await sender.send_audio(chunk)

    camera = CameraCapture(config, send_callback=on_frame, ocr_engine=ocr_engine)
    audio = AudioCapture(config, send_callback=on_audio)
    debug_server = DisplayServer(
        config.get("display", {}),
        display_state,
        get_frame=lambda: oled.last_frame,
    )

    # Build task list
    tasks: list[asyncio.Task] = []
    tasks.append(asyncio.create_task(gateway.run(stop_event), name="gateway"))
    tasks.append(asyncio.create_task(oled.run(stop_event), name="oled"))

    ds_cfg = config.get("display", {}).get("debug_server", {})
    if ds_cfg.get("enabled", True):
        tasks.append(asyncio.create_task(
            debug_server.run(stop_event), name="debug-server"))

    if config.get("camera", {}).get("enabled", True):
        tasks.append(asyncio.create_task(
            camera.run(stop_event), name="camera"))

    if config.get("audio", {}).get("enabled", True):
        tasks.append(asyncio.create_task(
            audio.run(stop_event), name="audio"))

    log.info("Started: gateway=%s session_key=%s camera=%s audio=%s display=%s",
             ws_url, session_key,
             config.get("camera", {}).get("enabled", True),
             config.get("audio", {}).get("enabled", True),
             config.get("display", {}).get("mode", "oled"))

    # Wait for stop or any task failure
    done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
    for task in done:
        if task.exception():
            log.error("Task %s failed: %s", task.get_name(), task.exception())

    # Graceful shutdown
    stop_event.set()
    for task in tasks:
        if not task.done():
            task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    await ocr_engine.shutdown()
    await gateway.close()
    log.info("Shutdown complete")


def main() -> None:
    parser = argparse.ArgumentParser(description="Sinain Wearable HUD")
    parser.add_argument("-c", "--config", default="config.yaml",
                        help="Path to config.yaml")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="Enable debug logging")
    args = parser.parse_args()

    level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    config = load_config(args.config)
    log_level = config.get("logging", {}).get("level", "INFO")
    if not args.verbose:
        logging.getLogger().setLevel(getattr(logging, log_level, logging.INFO))

    try:
        asyncio.run(run(config))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
