"""SSD1327 128x128 greyscale OLED display driver via luma.oled over SPI."""

from __future__ import annotations

import asyncio
import functools
import logging
import textwrap

from PIL import Image, ImageDraw, ImageFont

from .protocol import DisplayState, Priority

log = logging.getLogger(__name__)

# Priority → OLED greyscale intensity (SSD1327: 4-bit, 16 levels, 0–255 mapped)
_COLORS = {
    Priority.NORMAL: 255,   # bright white
    Priority.HIGH: 170,     # mid-grey
    Priority.URGENT: 255,   # white (blinks to dark)
}

# Urgent blink alternates between bright and dim
_URGENT_DIM = 50

# Status dot intensities
_STATUS_COLORS = {
    "idle": 68,
    "connected": 255,
    "listening": 200,
    "thinking": 170,
    "error": 255,
}


class OLEDDisplay:
    """Drives the Waveshare 1.5" SSD1327 OLED (128x128 greyscale) over SPI.

    Falls back to a virtual framebuffer (PIL Image) when luma.oled is not
    available (e.g., running on Mac for development). The virtual framebuffer
    is accessible via `last_frame` for the debug server.

    Modes:
    - "response": shows the latest agent response text (default)
    - "debug": shows camera classification, ssim, motion %, send status
    """

    def __init__(self, config: dict, display_state: DisplayState):
        self.config = config.get("oled", {})
        self.state = display_state
        self.width = self.config.get("width", 128)
        self.height = self.config.get("height", 128)
        self.font_size = self.config.get("font_size", 10)
        self.mode = self.config.get("mode", "response")  # "response" or "debug"
        self.device = None
        self.last_frame: Image.Image | None = None
        self._last_rendered = ""
        self._blink_on = True
        self._font = None

    def _load_font(self) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
        if self._font:
            return self._font
        for name in ("DejaVuSansMono.ttf", "DejaVuSans.ttf"):
            try:
                self._font = ImageFont.truetype(name, self.font_size)
                return self._font
            except OSError:
                continue
        self._font = ImageFont.load_default()
        return self._font

    def setup(self) -> None:
        """Initialize the SSD1327 device, or fall back to virtual framebuffer."""
        driver = self.config.get("driver", "ssd1327")
        try:
            from luma.core.interface.serial import spi
            from luma.oled import device as oled_device

            serial = spi(
                port=self.config.get("spi_port", 0),
                device=self.config.get("spi_device", 0),
                gpio_DC=self.config.get("gpio_dc", 25),
                gpio_RST=self.config.get("gpio_rst", 27),
                bus_speed_hz=self.config.get("spi_speed", 4_000_000),
            )
            device_cls = getattr(oled_device, driver)
            self.device = device_cls(serial, width=self.width, height=self.height)
            contrast = self.config.get("contrast", 255)
            self.device.contrast(contrast)
            log.info("%s OLED initialized (%dx%d)", driver.upper(),
                     self.width, self.height)
        except Exception as e:
            log.warning("OLED unavailable (%s), using virtual framebuffer", e)
            self.device = None

    def _get_display_text(self) -> str:
        """Pick the text to display based on the current mode."""
        if self.mode == "debug":
            return self.state.debug_text or self.state.text
        # Response mode: show agent response, fall back to generic text
        return self.state.response_text or self.state.text

    def render(self) -> Image.Image:
        """Render current display state to a PIL Image (RGB).

        We render in RGB directly (not greyscale "L") because the SSD1327
        luma driver expects RGB input.  This avoids an L→RGB conversion in
        _push_to_device and matches the working diagnostic script.
        """
        img = Image.new("RGB", (self.width, self.height), (0, 0, 0))
        draw = ImageDraw.Draw(img)
        font = self._load_font()

        # Gateway status dot (top-right corner, 6px diameter)
        if self.mode == "response":
            gw_dot = {"connected": 255, "disconnected": 68, "error": 170}
            dot_v = gw_dot.get(self.state.gateway_status, 68)
        else:
            dot_v = _STATUS_COLORS.get(self.state.status, 68)
        draw.ellipse([self.width - 9, 3, self.width - 3, 9],
                     fill=(dot_v, dot_v, dot_v))

        # Text content
        text_v = _COLORS.get(self.state.priority, 255)

        # Urgent priority blinks between bright and dim
        if self.state.priority == Priority.URGENT:
            self._blink_on = not self._blink_on
            if not self._blink_on:
                text_v = _URGENT_DIM

        display_text = self._get_display_text()
        if display_text:
            # Word-wrap to fit width (~18 chars at font_size 10)
            chars_per_line = max(1, (self.width - 4) // (self.font_size * 6 // 10))
            lines = textwrap.wrap(display_text, width=chars_per_line)
            max_lines = (self.height - 14) // (self.font_size + 2)
            lines = lines[:max_lines]

            y = 14  # Below status dot area
            for line in lines:
                draw.text((2, y), line, fill=(text_v, text_v, text_v), font=font)
                y += self.font_size + 2

        self.last_frame = img
        return img

    def _push_to_device(self, img: Image.Image) -> None:
        """Push rendered image to physical OLED (blocking SPI I/O).

        Called via run_in_executor() so that blocking SPI writes don't
        stall the asyncio event loop or get interrupted by it.
        """
        if self.device is not None:
            self.device.display(img)

    async def run(self, stop_event: asyncio.Event) -> None:
        """Display loop: re-render on state changes, ~10 FPS max."""
        loop = asyncio.get_running_loop()
        self.setup()

        # Boot splash — verifies hardware works, visible for 2 s
        if self.device is not None:
            splash = Image.new("RGB", (self.width, self.height), (0, 0, 0))
            draw = ImageDraw.Draw(splash)
            font = self._load_font()
            draw.text((2, 40), "SinainHUD", fill=(255, 255, 255), font=font)
            draw.text((2, 56), "Booting...", fill=(170, 170, 170), font=font)
            draw.ellipse([self.width - 9, 3, self.width - 3, 9],
                         fill=(255, 255, 255))
            self.device.display(splash)
            log.info("Boot splash pushed to OLED")
            await asyncio.sleep(2.0)  # Keep splash visible

        log.info("Display loop started (hw=%s, content_mode=%s)",
                 "oled" if self.device else "virtual", self.mode)
        _first_render = True

        while not stop_event.is_set():
            # Build a state fingerprint that covers all fields the render depends on
            display_text = self._get_display_text()
            fingerprint = (
                f"{display_text}|{self.state.priority}"
                f"|{self.state.status}|{self.state.gateway_status}"
            )
            needs_render = (fingerprint != self._last_rendered
                           or self.state.priority == Priority.URGENT)

            if needs_render:
                img = self.render()
                try:
                    # SPI I/O in a thread so it doesn't block/get starved
                    # by the event loop under CPU load from camera pipeline
                    await loop.run_in_executor(
                        None, functools.partial(self._push_to_device, img))
                except Exception as e:
                    log.error("OLED push failed: %s", e)
                if _first_render:
                    log.info("First OLED render: text=%r device=%s",
                             display_text[:40] if display_text else "(empty)",
                             "hw" if self.device else "vfb")
                    _first_render = False
                self._last_rendered = fingerprint

            await asyncio.sleep(0.1)  # 10 FPS max refresh
