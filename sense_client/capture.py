"""Screen capture using ScreenCaptureKit (preferred), CoreGraphics, or IPC."""

import ctypes
import json
import os
import platform
import queue
import threading
import time
from typing import Generator

import objc
import Quartz
from PIL import Image


class ScreenCapture:
    """Captures screen frames via CGDisplayCreateImage (CoreGraphics/IOSurface).

    Uses Quartz CGDisplayCreateImage instead of the screencapture CLI.
    This avoids CoreMediaIO/ScreenCaptureKit, which blocks camera access
    for other apps (e.g. Google Meet) on macOS 14+.
    """

    def __init__(self, mode: str = "screen", target: int = 0,
                 fps: float = 1, scale: float = 0.5):
        self.mode = mode
        self.target = target
        self.fps = fps
        self.scale = scale
        self.stats_ok = 0
        self.stats_fail = 0
        self._last_stats_time = time.time()
        self._stats_interval = 60  # log stats every 60s
        self._display_id = Quartz.CGMainDisplayID()

    def capture_frame(self) -> tuple[Image.Image, float]:
        """Returns (PIL Image, timestamp).
        Uses CGDisplayCreateImage for zero-subprocess, camera-safe capture.
        Downscales by self.scale factor before returning.
        """
        ts = time.time()
        cg_image = Quartz.CGDisplayCreateImage(self._display_id)
        if cg_image is None:
            self.stats_fail += 1
            raise RuntimeError("CGDisplayCreateImage returned None")

        try:
            width = Quartz.CGImageGetWidth(cg_image)
            height = Quartz.CGImageGetHeight(cg_image)
            bytes_per_row = Quartz.CGImageGetBytesPerRow(cg_image)

            # Get raw pixel data from CGImage
            data_provider = Quartz.CGImageGetDataProvider(cg_image)
            raw_data = Quartz.CGDataProviderCopyData(data_provider)
        finally:
            # Explicitly release CGImage and its IOSurface handle immediately.
            # At continuous capture rates, unreleased handles cause GPU/camera
            # contention because the camera shares IOSurface infrastructure.
            del cg_image

        # CGDisplayCreateImage returns BGRA (premultiplied alpha, 32Little)
        img = Image.frombytes("RGBA", (width, height), raw_data,
                              "raw", "BGRA", bytes_per_row, 1)

        if self.scale != 1.0:
            new_w = int(width * self.scale)
            new_h = int(height * self.scale)
            img = img.resize((new_w, new_h), Image.LANCZOS)

        self.stats_ok += 1
        return img, ts

    def capture_loop(self) -> Generator[tuple[Image.Image, float], None, None]:
        """Yields frames at self.fps rate."""
        interval = 1.0 / self.fps
        while True:
            start = time.time()
            try:
                yield self.capture_frame()
            except Exception as e:
                print(f"[capture] error: {e}")
            self._maybe_log_stats()
            elapsed = time.time() - start
            sleep_time = interval - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)

    def _maybe_log_stats(self):
        now = time.time()
        if now - self._last_stats_time >= self._stats_interval:
            total = self.stats_ok + self.stats_fail
            rate = (self.stats_ok / total * 100) if total > 0 else 0
            print(f"[capture] stats: {self.stats_ok} ok, {self.stats_fail} fail"
                  f" ({rate:.0f}% success, {total} total)")
            if self.stats_fail > 0 and self.stats_ok == 0:
                print("[capture] WARNING: all captures failing — check screen recording permissions")
            self._last_stats_time = now


_kCVPixelBufferLock_ReadOnly = 0x00000001
_kCVPixelFormatType_32BGRA = 0x42475241  # 'BGRA'


class SCKCapture:
    """Captures screen frames via ScreenCaptureKit (macOS 12.3+).

    Uses SCStream for async zero-copy IOSurface sharing that coexists
    with camera/microphone without GPU resource contention. Replaces
    CGDisplayCreateImage which causes intermittent camera conflicts
    and is deprecated in macOS 15.
    """

    _delegate_cls = None  # ObjC delegate class, created once

    def __init__(self, mode: str = "screen", target: int = 0,
                 fps: float = 2.0, scale: float = 0.5):
        self.mode = mode
        self.target = target
        self.fps = fps
        self.scale = scale
        self.stats_ok = 0
        self.stats_fail = 0
        self._last_stats_time = time.time()
        self._stats_interval = 60
        self._stream = None
        self._output = None
        self._queue = queue.Queue(maxsize=3)
        self._setup_done = False
        self._cv = None  # CoreVideo ctypes handle
        self._cm = None  # CoreMedia ctypes handle

    @classmethod
    def is_available(cls) -> bool:
        """Check if ScreenCaptureKit is available (macOS >= 12.3 + framework loads)."""
        try:
            ver = platform.mac_ver()[0]
            parts = [int(x) for x in ver.split('.')]
            major = parts[0]
            minor = parts[1] if len(parts) > 1 else 0
            if (major, minor) < (12, 3):
                return False
            objc.loadBundle(
                'ScreenCaptureKit',
                bundle_path='/System/Library/Frameworks/ScreenCaptureKit.framework',
                module_globals={},
            )
            return True
        except Exception:
            return False

    def _setup(self):
        """Lazy setup: load frameworks, enumerate displays, start SCStream."""
        if self._setup_done:
            return

        from Foundation import NSObject

        # 1. Load ScreenCaptureKit framework
        sck = {}
        objc.loadBundle(
            'ScreenCaptureKit',
            bundle_path='/System/Library/Frameworks/ScreenCaptureKit.framework',
            module_globals=sck,
        )

        # 2. Register metadata for async completion handler methods
        #    PyObjC needs explicit block signatures for methods loaded via loadBundle
        objc.registerMetaDataForSelector(
            b'SCShareableContent',
            b'getShareableContentExcludingDesktopWindows:onScreenWindowsOnly:completionHandler:',
            {'arguments': {4: {'callable': {
                'retval': {'type': b'v'},
                'arguments': {
                    0: {'type': b'^v'},  # block literal
                    1: {'type': b'@'},   # SCShareableContent
                    2: {'type': b'@'},   # NSError
                },
            }}}}
        )
        for sel in (b'startCaptureWithCompletionHandler:',
                    b'stopCaptureWithCompletionHandler:'):
            objc.registerMetaDataForSelector(
                b'SCStream', sel,
                {'arguments': {2: {'callable': {
                    'retval': {'type': b'v'},
                    'arguments': {
                        0: {'type': b'^v'},
                        1: {'type': b'@'},  # NSError
                    },
                }}}}
            )

        # 3. Load CoreVideo/CoreMedia via ctypes for pixel buffer extraction
        self._cv = ctypes.CDLL(
            '/System/Library/Frameworks/CoreVideo.framework/CoreVideo')
        self._cm = ctypes.CDLL(
            '/System/Library/Frameworks/CoreMedia.framework/CoreMedia')

        self._cm.CMSampleBufferGetImageBuffer.argtypes = [ctypes.c_void_p]
        self._cm.CMSampleBufferGetImageBuffer.restype = ctypes.c_void_p

        for fn_name in ('CVPixelBufferLockBaseAddress',
                        'CVPixelBufferUnlockBaseAddress'):
            fn = getattr(self._cv, fn_name)
            fn.argtypes = [ctypes.c_void_p, ctypes.c_uint64]
            fn.restype = ctypes.c_int32

        self._cv.CVPixelBufferGetBaseAddress.argtypes = [ctypes.c_void_p]
        self._cv.CVPixelBufferGetBaseAddress.restype = ctypes.c_void_p

        for fn_name in ('CVPixelBufferGetWidth', 'CVPixelBufferGetHeight',
                        'CVPixelBufferGetBytesPerRow'):
            fn = getattr(self._cv, fn_name)
            fn.argtypes = [ctypes.c_void_p]
            fn.restype = ctypes.c_size_t

        # 4. Create ObjC delegate class (once per process)
        if SCKCapture._delegate_cls is None:
            class _SCKStreamOutput(NSObject):
                """Bridges SCStream async frames to a Python queue."""
                def stream_didOutputSampleBuffer_ofType_(
                        self, stream, sample_buffer, output_type):
                    if output_type != 0:  # 0 = SCStreamOutputTypeScreen
                        return
                    try:
                        img = self._converter(sample_buffer)
                        self._py_queue.put_nowait((img, time.time()))
                    except Exception:
                        pass  # Drop frame (queue full or conversion error)
            SCKCapture._delegate_cls = _SCKStreamOutput

        # 5. Get shareable content (blocking async → sync via Event)
        content_event = threading.Event()
        content_result = [None, None]  # [SCShareableContent, NSError]

        def on_content(content, error):
            content_result[0] = content
            content_result[1] = error
            content_event.set()

        sck['SCShareableContent'] \
            .getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler_(
                True, True, on_content)

        if not content_event.wait(timeout=10):
            raise RuntimeError("Timeout getting shareable content")
        if content_result[1]:
            raise RuntimeError(
                f"Screen recording permission denied: {content_result[1]}")

        displays = content_result[0].displays()
        if not displays:
            raise RuntimeError("No displays found")
        display = displays[0]  # primary display

        # 6. Create content filter + stream configuration
        content_filter = sck['SCContentFilter'].alloc() \
            .initWithDisplay_excludingWindows_(display, [])

        config = sck['SCStreamConfiguration'].alloc().init()
        # Native GPU-level downscaling — no PIL resize() needed
        width = int(display.width() * self.scale)
        height = int(display.height() * self.scale)
        config.setWidth_(width)
        config.setHeight_(height)
        config.setPixelFormat_(_kCVPixelFormatType_32BGRA)
        config.setShowsCursor_(False)
        # Frame pacing: CMTime struct = (value, timescale, flags, epoch)
        # kCMTimeFlags_Valid = 1
        interval_ms = int(1000.0 / self.fps)
        config.setMinimumFrameInterval_((interval_ms, 1000, 1, 0))

        # 7. Create stream + attach delegate
        self._stream = sck['SCStream'].alloc() \
            .initWithFilter_configuration_delegate_(content_filter, config, None)

        output = SCKCapture._delegate_cls.alloc().init()
        output._py_queue = self._queue
        output._converter = self._sample_buffer_to_image
        self._output = output  # prevent GC

        success, err = self._stream \
            .addStreamOutput_type_sampleHandlerQueue_error_(
                output, 0, None, None)
        if not success:
            raise RuntimeError(f"Failed to add stream output: {err}")

        # 8. Start capture (blocking async → sync)
        start_event = threading.Event()
        start_error = [None]

        def on_start(error):
            start_error[0] = error
            start_event.set()

        self._stream.startCaptureWithCompletionHandler_(on_start)

        if not start_event.wait(timeout=10):
            raise RuntimeError("Timeout starting SCStream capture")
        if start_error[0]:
            raise RuntimeError(f"Failed to start capture: {start_error[0]}")

        self._setup_done = True
        print(f"[capture] SCKCapture ready: {width}x{height} @ {self.fps} FPS")

    def _sample_buffer_to_image(self, sample_buffer) -> Image.Image:
        """Convert CMSampleBuffer → PIL Image via ctypes CoreVideo calls."""
        buf_ptr = ctypes.c_void_p(objc.pyobjc_id(sample_buffer))
        pixel_buf = self._cm.CMSampleBufferGetImageBuffer(buf_ptr)
        if not pixel_buf:
            raise RuntimeError("No pixel buffer in sample buffer")

        self._cv.CVPixelBufferLockBaseAddress(pixel_buf,
                                              _kCVPixelBufferLock_ReadOnly)
        try:
            base = self._cv.CVPixelBufferGetBaseAddress(pixel_buf)
            w = self._cv.CVPixelBufferGetWidth(pixel_buf)
            h = self._cv.CVPixelBufferGetHeight(pixel_buf)
            bpr = self._cv.CVPixelBufferGetBytesPerRow(pixel_buf)
            data = ctypes.string_at(base, bpr * h)
            return Image.frombytes("RGBA", (w, h), data, "raw", "BGRA", bpr, 1)
        finally:
            self._cv.CVPixelBufferUnlockBaseAddress(pixel_buf,
                                                    _kCVPixelBufferLock_ReadOnly)

    def capture_frame(self) -> tuple[Image.Image, float]:
        """Returns (PIL Image, timestamp). Blocks until a frame is available."""
        self._setup()
        try:
            img, ts = self._queue.get(timeout=2)
            self.stats_ok += 1
            return img, ts
        except queue.Empty:
            self.stats_fail += 1
            raise RuntimeError("No frame received within timeout")

    def capture_loop(self) -> Generator[tuple[Image.Image, float], None, None]:
        """Yields frames from SCStream. Pacing handled by minimumFrameInterval."""
        self._setup()
        try:
            while True:
                try:
                    img, ts = self._queue.get(timeout=2)
                    self.stats_ok += 1
                    yield img, ts
                except queue.Empty:
                    self.stats_fail += 1
                    print("[capture] no frame received (timeout)")
                self._maybe_log_stats()
        finally:
            self.stop()

    def stop(self):
        """Stop the SCStream cleanly."""
        if not self._stream or not self._setup_done:
            return
        stop_event = threading.Event()

        def on_stop(error):
            if error:
                print(f"[capture] stop error: {error}")
            stop_event.set()

        self._stream.stopCaptureWithCompletionHandler_(on_stop)
        stop_event.wait(timeout=5)
        self._stream = None
        self._setup_done = False

    def _maybe_log_stats(self):
        now = time.time()
        if now - self._last_stats_time >= self._stats_interval:
            total = self.stats_ok + self.stats_fail
            rate = (self.stats_ok / total * 100) if total > 0 else 0
            print(f"[capture] stats: {self.stats_ok} ok, {self.stats_fail} fail"
                  f" ({rate:.0f}% success, {total} total)")
            self._last_stats_time = now


class ScreenKitCapture:
    """Reads frames written by ScreenCaptureKit via IPC (overlay app)."""

    FRAME_PATH = os.path.expanduser("~/.sinain/capture/frame.jpg")
    META_PATH = os.path.expanduser("~/.sinain/capture/meta.json")
    STALE_THRESHOLD = 1.0  # seconds

    def __init__(self, fps: float = 1, scale: float = 1.0, **kwargs):
        self.fps = fps
        self.scale = scale
        self.stats_ok = 0
        self.stats_fail = 0
        self._last_frame_ts = 0.0
        self._last_stats_time = time.time()
        self._stats_interval = 60

    @classmethod
    def is_available(cls) -> bool:
        """Check if fresh frames exist from the overlay app."""
        try:
            if not os.path.exists(cls.FRAME_PATH):
                return False
            mtime = os.path.getmtime(cls.FRAME_PATH)
            return (time.time() - mtime) < cls.STALE_THRESHOLD
        except OSError:
            return False

    def capture_frame(self) -> tuple[Image.Image, float] | None:
        """Read the latest frame from IPC.

        Returns (PIL Image, timestamp) or None if frame is stale/duplicate.
        """
        try:
            if not os.path.exists(self.FRAME_PATH):
                return None

            # Read metadata for precise timestamp
            ts = time.time()
            if os.path.exists(self.META_PATH):
                try:
                    with open(self.META_PATH) as f:
                        meta = json.load(f)
                    ts = meta.get("timestamp", ts)
                except (json.JSONDecodeError, OSError):
                    pass

            # Skip duplicate frames
            if ts == self._last_frame_ts:
                return None

            img = Image.open(self.FRAME_PATH)
            img.load()  # Force full read before file can be overwritten

            if self.scale != 1.0:
                new_w = int(img.width * self.scale)
                new_h = int(img.height * self.scale)
                img = img.resize((new_w, new_h), Image.LANCZOS)

            self._last_frame_ts = ts
            self.stats_ok += 1
            return img, ts

        except Exception as e:
            self.stats_fail += 1
            print(f"[capture-screenkit] error: {e}")
            return None

    def capture_loop(self) -> Generator[tuple[Image.Image, float], None, None]:
        """Yields frames at self.fps rate, same interface as ScreenCapture."""
        interval = 1.0 / self.fps
        while True:
            start = time.time()
            result = self.capture_frame()
            if result is not None:
                yield result
            self._maybe_log_stats()
            elapsed = time.time() - start
            sleep_time = interval - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)

    def _maybe_log_stats(self):
        now = time.time()
        if now - self._last_stats_time >= self._stats_interval:
            total = self.stats_ok + self.stats_fail
            rate = (self.stats_ok / total * 100) if total > 0 else 0
            print(f"[capture-screenkit] stats: {self.stats_ok} ok, {self.stats_fail} fail"
                  f" ({rate:.0f}% success, {total} total)")
            self._last_stats_time = now


def create_capture(mode: str = "screen", target: int = 0,
                   fps: float = 1, scale: float = 0.5
                   ) -> SCKCapture | ScreenKitCapture | ScreenCapture:
    """Factory: SCKCapture (preferred) → ScreenKitCapture (IPC) → ScreenCapture (legacy).

    SCKCapture uses ScreenCaptureKit for async zero-copy capture that coexists
    with camera/microphone. Falls back to CGDisplayCreateImage on older macOS
    or if screen recording permission is denied.
    """
    # 1. ScreenCaptureKit (camera-safe, efficient, preferred)
    if SCKCapture.is_available():
        try:
            cap = SCKCapture(mode=mode, target=target, fps=fps, scale=scale)
            cap._setup()  # eagerly verify permission + start stream
            print("[capture] Using ScreenCaptureKit (SCKCapture)")
            return cap
        except Exception as e:
            print(f"[capture] ScreenCaptureKit setup failed: {e}")

    # 2. IPC from overlay app (reads frame.jpg files)
    if ScreenKitCapture.is_available():
        print("[capture] Using ScreenCaptureKit (overlay IPC)")
        return ScreenKitCapture(fps=fps, scale=1.0)

    # 3. CGDisplayCreateImage (legacy fallback for macOS < 12.3)
    print("[capture] Using CoreGraphics (CGDisplayCreateImage)")
    print("[capture] WARNING: CGDisplayCreateImage may cause camera conflicts")
    return ScreenCapture(mode=mode, target=target, fps=fps, scale=scale)
