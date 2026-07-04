"""VAD/segmentation tests — synthetic PCM, no audio hardware, no network.

Run: python3 -m unittest discover -s packages/sinain-sense/tests -v
The webrtcvad case skips when the `webrtcvad` extra isn't installed.
"""

import array
import importlib.util
import math
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sinain_sense.audio import (  # noqa: E402
    EnergyDetector,
    Segmenter,
    WavChunk,
    rms_energy,
    wav_header,
)

SR = 16000  # 16 kHz mono → 32 bytes/ms, 30 ms frame = 960 bytes


def _pcm(ms: int, amp: int, freq: int = 440) -> bytes:
    """A `ms`-long 16 kHz mono int16 sine at `amp`. amp≈30 = quiet 'silence',
    amp≈8000 = clear speech (RMS ~190x apart, well over SPEECH_FACTOR=3.5)."""
    n = SR * ms // 1000
    samples = array.array("h",
        (max(-32768, min(32767, int(amp * math.sin(2 * math.pi * freq * i / SR))))
         for i in range(n)))
    if struct.pack("<h", 1) != struct.pack("=h", 1):
        samples.byteswap()
    return samples.tobytes()


_SILENCE = lambda ms: _pcm(ms, 30)   # noqa: E731
_SPEECH = lambda ms: _pcm(ms, 8000)  # noqa: E731


class TestWavHeaderAndEnergy(unittest.TestCase):
    def test_wav_header_fields(self):
        h = wav_header(1000, 16000, 1)
        self.assertEqual(len(h), 44)
        self.assertEqual(h[:4], b"RIFF")
        self.assertEqual(h[8:12], b"WAVE")
        self.assertEqual(h[36:40], b"data")
        riff_size, = struct.unpack("<I", h[4:8])
        data_size, = struct.unpack("<I", h[40:44])
        self.assertEqual(riff_size, 36 + 1000)
        self.assertEqual(data_size, 1000)
        sr, = struct.unpack("<I", h[24:28])
        self.assertEqual(sr, 16000)

    def test_rms_energy_bounds(self):
        self.assertEqual(rms_energy(b""), 0.0)
        self.assertAlmostEqual(rms_energy(b"\x00\x00" * 100), 0.0)
        full = array.array("h", [32767, -32768] * 100)
        if struct.pack("<h", 1) != struct.pack("=h", 1):
            full.byteswap()
        self.assertGreater(rms_energy(full.tobytes()), 0.99)


class TestSegmenter(unittest.TestCase):
    def _seg(self, **kw):
        return Segmenter(sample_rate=SR, detector=EnergyDetector(), **kw)

    def test_one_utterance_cut_on_silence(self):
        seg = self._seg()
        stream = _SILENCE(500) + _SPEECH(1000) + _SILENCE(800)
        chunks = seg.feed(stream)
        self.assertEqual(len(chunks), 1)
        c = chunks[0]
        self.assertIsInstance(c, WavChunk)
        self.assertEqual(c.buffer[:4], b"RIFF")
        # preroll (~300) + speech (1000) + trailing silence up to hangover (700)
        self.assertTrue(1700 <= c.duration_ms <= 2100, c.duration_ms)
        self.assertGreater(c.energy, 0.01)
        self.assertFalse(c.forced)

    def test_streaming_across_feeds_is_equivalent(self):
        seg = self._seg()
        stream = _SILENCE(500) + _SPEECH(1000) + _SILENCE(800)
        chunks = []
        step = 137  # odd byte size → exercises partial-frame leftover carry
        for i in range(0, len(stream), step):
            chunks += seg.feed(stream[i:i + step])
        self.assertEqual(len(chunks), 1)
        self.assertTrue(1700 <= chunks[0].duration_ms <= 2100)

    def test_min_segment_drops_blip(self):
        seg = self._seg(preroll_ms=0, min_segment_ms=300)
        seg.feed(_SILENCE(300))          # calibrate the floor
        seg.feed(_SPEECH(100))           # 100 ms < 300 ms min
        self.assertIsNone(seg.flush())   # dropped, not emitted

    def test_max_segment_forces_cut(self):
        seg = self._seg(max_segment_ms=2000)
        chunks = seg.feed(_SILENCE(300) + _SPEECH(5000))
        self.assertGreaterEqual(len(chunks), 1)
        self.assertTrue(chunks[0].forced)
        self.assertLessEqual(chunks[0].duration_ms, 2100)

    def test_flush_emits_in_progress_utterance(self):
        seg = self._seg()
        seg.feed(_SILENCE(300) + _SPEECH(600))  # no trailing silence to end it
        c = seg.flush()
        self.assertIsNotNone(c)
        self.assertGreater(c.duration_ms, 500)
        self.assertIsNone(seg.flush())  # idempotent — nothing left

    def test_pure_silence_emits_nothing(self):
        seg = self._seg()
        self.assertEqual(seg.feed(_SILENCE(2000)), [])
        self.assertIsNone(seg.flush())


@unittest.skipUnless(importlib.util.find_spec("webrtcvad"), "webrtcvad extra not installed")
class TestWebrtcDetector(unittest.TestCase):
    def test_segments_with_webrtc_strategy(self):
        from sinain_sense.audio import WebrtcDetector
        seg = Segmenter(sample_rate=SR, detector=WebrtcDetector(mode=1))
        chunks = seg.feed(_SILENCE(400) + _SPEECH(800) + _SILENCE(800))
        self.assertGreaterEqual(len(chunks), 1)


if __name__ == "__main__":
    unittest.main()
