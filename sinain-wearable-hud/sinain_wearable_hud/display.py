"""SSD1327 128x128 greyscale OLED display driver via luma.oled over SPI."""

from __future__ import annotations

import asyncio
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
    """

    def __init__(self, config: dict, display_state: DisplayState):
        self.config = config.get("oled", {})
        self.state = display_state
        self.width = self.config.get("width", 128)
        self.height = self.config.get("height", 128)
        self.font_size = self.config.get("font_size", 10)
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

    def render(self) -> Image.Image:
        """Render current display state to a PIL Image (greyscale)."""
        img = Image.new("L", (self.width, self.height), 0)
        draw = ImageDraw.Draw(img)
        font = self._load_font()

        # Status dot (top-right corner, 6px diameter)
        dot_intensity = _STATUS_COLORS.get(self.state.status, 68)
        draw.ellipse([self.width - 9, 3, self.width - 3, 9],
                     fill=dot_intensity)

        # Text content
        text_intensity = _COLORS.get(self.state.priority, 255)

        # Urgent priority blinks between bright and dim
        if self.state.priority == Priority.URGENT:
            self._blink_on = not self._blink_on
            if not self._blink_on:
                text_intensity = _URGENT_DIM

        if self.state.text:
            # Word-wrap to fit width (~18 chars at font_size 10)
            chars_per_line = max(1, (self.width - 4) // (self.font_size * 6 // 10))
            lines = textwrap.wrap(self.state.text, width=chars_per_line)
            max_lines = (self.height - 14) // (self.font_size + 2)
            lines = lines[:max_lines]

            y = 14  # Below status dot area
            for line in lines:
                draw.text((2, y), line, fill=text_intensity, font=font)
                y += self.font_size + 2

        self.last_frame = img
        return img

    def _push_to_device(self, img: Image.Image) -> None:
        """Push rendered image to physical OLED if available."""
        if self.device is not None:
            # luma.oled SSD1327 expects RGB; convert from greyscale "L"
            if img.mode != self.device.mode:
                img = img.convert(self.device.mode)
            self.device.display(img)

    async def run(self, stop_event: asyncio.Event) -> None:
        """Display loop: re-render on state changes, ~10 FPS max."""
        self.setup()
        log.info("Display loop started (mode=%s)", "oled" if self.device else "virtual")

        while not stop_event.is_set():
            # Build a state fingerprint to detect changes
            fingerprint = f"{self.state.text}|{self.state.priority}|{self.state.status}"
            needs_render = (fingerprint != self._last_rendered
                           or self.state.priority == Priority.URGENT)

            if needs_render:
                img = self.render()
                self._push_to_device(img)
                self._last_rendered = fingerprint

            await asyncio.sleep(0.1)  # 10 FPS max refresh
