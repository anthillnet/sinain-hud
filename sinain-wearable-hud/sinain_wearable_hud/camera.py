"""Camera capture pipeline: picamera2/cv2 → scene gate → JPEG encode → sender.

Runs a dedicated capture thread feeding an asyncio queue. The main loop pulls
frames, classifies them through the scene gate, and dispatches accepted frames
to the sender.

Supports two backends:
  - "picamera2" (default): Pi Camera Module 3 via libcamera/picamera2
  - "cv2": USB cameras via OpenCV VideoCapture (fallback)
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from queue import Empty, Full, Queue

import cv2
import numpy as np

from .ocr import OCREngine
from .protocol import FrameClass, RoomFrame
from .scene_gate import SceneGate

log = logging.getLogger(__name__)


class CameraCapture:
    """Camera capture with scene-gated frame selection."""

    def __init__(self, config: dict, send_callback=None,
                 ocr_engine: OCREngine | None = None):
        """
        Args:
            config: Full config dict (camera section will be extracted).
            send_callback: async callable(RoomFrame) to dispatch accepted frames.
            ocr_engine: Optional OCR engine for text extraction.
        """
        cam = config.get("camera", {})
        self.backend = cam.get("backend", "picamera2")
        self.device = cam.get("device", 0)
        self.resolution = tuple(cam.get("resolution", [1280, 720]))
        self.fps = cam.get("fps", 10)
        self.quality_text = cam.get("jpeg_quality_text", 70)
        self.quality_default = cam.get("jpeg_quality_default", 50)
        self.send_callback = send_callback
        self._ocr_engine = ocr_engine

        self._gate = SceneGate(config)
        self._frame_queue: Queue[np.ndarray] = Queue(maxsize=3)
        self._capture_thread: threading.Thread | None = None
        self._stop = threading.Event()

        # Stats
        self._frames_captured = 0
        self._frames_sent = 0
        self._frames_dropped = 0
        self._last_stats_ts = time.time()

    # ── Capture backends ──────────────────────────────────────────────

    def _capture_loop_picamera2(self) -> None:
        """Thread: read frames from Pi Camera Module via picamera2."""
        try:
            from picamera2 import Picamera2
        except ImportError:
            log.error("picamera2 not available — install python3-picamera2 "
                      "or switch to backend: cv2")
            return

        cam = Picamera2()
        video_config = cam.create_video_configuration(
            main={"size": self.resolution, "format": "RGB888"},
        )
        cam.configure(video_config)
        cam.start()

        actual = cam.camera_configuration()["main"]["size"]
        log.info("picamera2 opened: %dx%d @ %d FPS (requested %dx%d)",
                 actual[0], actual[1], self.fps,
                 self.resolution[0], self.resolution[1])

        interval = 1.0 / self.fps
        try:
            while not self._stop.is_set():
                t0 = time.monotonic()
                # capture_array returns numpy RGB array
                frame = cam.capture_array("main")

                # Convert RGB → BGR for cv2 compatibility (scene_gate expects BGR)
                frame = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)

                self._frames_captured += 1
                self._enqueue_frame(frame)

                # Pace to target FPS
                elapsed = time.monotonic() - t0
                if elapsed < interval:
                    time.sleep(interval - elapsed)
        finally:
            cam.stop()
            cam.close()
            log.info("picamera2 capture thread stopped")

    def _capture_loop_cv2(self) -> None:
        """Thread: read frames from USB camera via OpenCV."""
        cap = cv2.VideoCapture(self.device)
        if not cap.isOpened():
            log.error("Cannot open camera device %s", self.device)
            return

        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.resolution[0])
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.resolution[1])
        cap.set(cv2.CAP_PROP_FPS, self.fps)

        actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        log.info("cv2 camera opened: %dx%d @ %d FPS (requested %dx%d @ %d)",
                 actual_w, actual_h, int(cap.get(cv2.CAP_PROP_FPS)),
                 self.resolution[0], self.resolution[1], self.fps)

        interval = 1.0 / self.fps
        while not self._stop.is_set():
            t0 = time.monotonic()
            ok, frame = cap.read()
            if not ok:
                log.warning("Camera read failed, retrying...")
                time.sleep(0.5)
                continue

            self._frames_captured += 1
            self._enqueue_frame(frame)

            elapsed = time.monotonic() - t0
            if elapsed < interval:
                time.sleep(interval - elapsed)

        cap.release()
        log.info("cv2 capture thread stopped")

    def _enqueue_frame(self, frame: np.ndarray) -> None:
        """Push frame into bounded queue, dropping oldest on overflow."""
        try:
            self._frame_queue.put_nowait(frame)
        except Full:
            try:
                self._frame_queue.get_nowait()
            except Empty:
                pass
            self._frame_queue.put_nowait(frame)

    # ── Encoding ──────────────────────────────────────────────────────

    def _encode_frame(self, frame: np.ndarray, classification: FrameClass
                      ) -> tuple[bytes, int, int]:
        """JPEG-encode a frame. Downscale non-TEXT frames to save bandwidth."""
        if classification != FrameClass.TEXT:
            frame = cv2.resize(frame, (640, 480),
                               interpolation=cv2.INTER_AREA)

        quality = (self.quality_text if classification == FrameClass.TEXT
                   else self.quality_default)
        _, buf = cv2.imencode(".jpg", frame,
                              [cv2.IMWRITE_JPEG_QUALITY, quality])
        h, w = frame.shape[:2]
        return buf.tobytes(), w, h

    # ── Main loop ─────────────────────────────────────────────────────

    async def run(self, stop_event: asyncio.Event) -> None:
        """Main async loop: pull frames from queue → classify → send."""
        if self.backend == "picamera2":
            target = self._capture_loop_picamera2
        else:
            target = self._capture_loop_cv2

        self._capture_thread = threading.Thread(
            target=target, daemon=True, name="camera-capture")
        self._capture_thread.start()
        log.info("Camera pipeline started (backend=%s, fps=%d)",
                 self.backend, self.fps)

        loop = asyncio.get_event_loop()

        while not stop_event.is_set():
            try:
                frame = await loop.run_in_executor(
                    None, lambda: self._frame_queue.get(timeout=1.0))
            except Empty:
                continue

            classification, meta = self._gate.classify(frame)

            if classification == FrameClass.DROP:
                self._frames_dropped += 1
                self._maybe_log_stats()
                continue

            # Run vision analysis on full-res frame before encoding (which may downscale)
            description, ocr_text = "", ""
            if self._ocr_engine:
                description, ocr_text = await self._ocr_engine.extract(frame)

            jpeg_bytes, w, h = self._encode_frame(frame, classification)
            room_frame = RoomFrame(
                jpeg_bytes=jpeg_bytes,
                classification=classification,
                ssim=meta.get("ssim", 1.0),
                motion_pct=meta.get("motion_pct", 0.0),
                text_hint_count=meta.get("text_hint_count", 0),
                width=w,
                height=h,
                description=description,
                ocr_text=ocr_text,
            )

            log.debug("[%s] ssim=%.2f motion=%.1f%% text=%d size=%dKB",
                      classification.value, room_frame.ssim,
                      room_frame.motion_pct, room_frame.text_hint_count,
                      len(jpeg_bytes) // 1024)

            self._frames_sent += 1
            if self.send_callback:
                await self.send_callback(room_frame)

            self._maybe_log_stats()

        # Stop capture thread
        self._stop.set()
        if self._capture_thread:
            self._capture_thread.join(timeout=3)

    def _maybe_log_stats(self) -> None:
        now = time.time()
        if now - self._last_stats_ts < 60:
            return
        log.info("[camera] captured=%d sent=%d dropped=%d (last 60s)",
                 self._frames_captured, self._frames_sent, self._frames_dropped)
        self._frames_captured = 0
        self._frames_sent = 0
        self._frames_dropped = 0
        self._last_stats_ts = now
