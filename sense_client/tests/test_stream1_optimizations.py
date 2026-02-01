"""Tests for Stream 1 optimizations: adaptive cooldown, adaptive SSIM,
parallel OCR, skip image for text events, latency instrumentation."""

import time
import unittest
from unittest.mock import MagicMock, patch

from sense_client.change_detector import ChangeDetector, ChangeResult
from sense_client.config import load_config, DEFAULTS
from sense_client.gate import DecisionGate, SenseEvent, SenseMeta
from sense_client.ocr import OCRResult
from sense_client.sender import SenseSender


class TestConfig(unittest.TestCase):
    """Test that adaptiveCooldownMs is present in defaults."""

    def test_defaults_has_adaptive_cooldown(self):
        config = load_config(None)
        self.assertIn("adaptiveCooldownMs", config["gate"])
        self.assertEqual(config["gate"]["adaptiveCooldownMs"], 2000)

    def test_defaults_cooldown_unchanged(self):
        config = load_config(None)
        self.assertEqual(config["gate"]["cooldownMs"], 5000)


class TestChangeDetectorSetThreshold(unittest.TestCase):
    """Test dynamic SSIM threshold adjustment."""

    def test_set_threshold(self):
        det = ChangeDetector(threshold=0.92)
        self.assertEqual(det.threshold, 0.92)
        det.set_threshold(0.85)
        self.assertEqual(det.threshold, 0.85)
        det.set_threshold(0.95)
        self.assertEqual(det.threshold, 0.95)


class TestAdaptiveCooldown(unittest.TestCase):
    """Test that DecisionGate uses shorter cooldown after app switch."""

    def _make_change(self, ssim=0.80):
        return ChangeResult(
            ssim_score=ssim,
            diff_image=MagicMock(),
            contours=[],
            bbox=(0, 0, 100, 100),
        )

    def _make_ocr(self, text=""):
        return OCRResult(text=text, confidence=90, word_count=len(text.split()))

    def test_init_has_adaptive_params(self):
        gate = DecisionGate(adaptive_cooldown_ms=2000)
        self.assertEqual(gate.adaptive_cooldown_ms, 2000)
        self.assertEqual(gate.last_app_change_ts, 0)

    def test_app_change_sets_timestamp(self):
        gate = DecisionGate(cooldown_ms=5000, adaptive_cooldown_ms=2000,
                            context_cooldown_ms=0)
        change = self._make_change()
        ocr = self._make_ocr()

        # First call with app_changed — should set last_app_change_ts
        event = gate.classify(change, ocr, app_changed=True)
        self.assertIsNotNone(event)
        self.assertEqual(event.type, "context")
        self.assertGreater(gate.last_app_change_ts, 0)

    def test_adaptive_cooldown_shorter_after_app_switch(self):
        gate = DecisionGate(cooldown_ms=5000, adaptive_cooldown_ms=2000,
                            context_cooldown_ms=0)
        long_text = "This is a sufficiently long OCR text for testing purposes here"
        change = self._make_change(ssim=0.80)
        ocr = self._make_ocr(long_text)

        # Trigger app change to set last_app_change_ts
        gate.classify(change, ocr, app_changed=True)

        # Immediately after: should use 2s adaptive cooldown
        # Within 2s window, should be gated
        event = gate.classify(change, ocr, app_changed=False)
        self.assertIsNone(event)  # within 2s cooldown

        # Simulate 2.1s passing by adjusting timestamps
        gate.last_send_ts -= 2100  # pretend 2.1s have passed
        gate.last_app_change_ts = time.time() * 1000 - 1000  # app change 1s ago (within 10s)

        event = gate.classify(change, self._make_ocr(long_text + " extra"), app_changed=False)
        self.assertIsNotNone(event)
        self.assertEqual(event.type, "text")

    def test_normal_cooldown_when_no_recent_app_change(self):
        gate = DecisionGate(cooldown_ms=5000, adaptive_cooldown_ms=2000,
                            context_cooldown_ms=10000)
        long_text = "This is a sufficiently long OCR text for testing purposes here"
        change = self._make_change(ssim=0.80)
        ocr = self._make_ocr(long_text)

        # No app change ever — last_app_change_ts is 0
        # Send an initial event
        event = gate.classify(change, ocr, app_changed=False)
        self.assertIsNotNone(event)

        # Try again after 3s (> adaptive but < normal cooldown)
        gate.last_send_ts -= 3000
        event = gate.classify(change, self._make_ocr(long_text + " more"), app_changed=False)
        # Should be gated because no recent app change → uses 5s cooldown
        self.assertIsNone(event)


class TestSkipImageForTextEvents(unittest.TestCase):
    """Verify that text events don't get image data packaged."""

    def test_text_event_has_no_roi(self):
        """Simulate what __main__.py does: text events skip package_roi."""
        event = SenseEvent(type="text", ts=time.time() * 1000, ocr="some text")
        # The logic in __main__.py:
        # if event.type == "context": package_full_frame
        # elif event.type == "visual" and rois: package_roi
        # text events: nothing
        if event.type == "context":
            event.roi = {"data": "base64..."}
        elif event.type == "visual":
            event.roi = {"data": "base64..."}
        # text: no roi set
        self.assertIsNone(event.roi)

    def test_visual_event_gets_roi(self):
        event = SenseEvent(type="visual", ts=time.time() * 1000, ocr="")
        rois = [MagicMock()]
        if event.type == "visual" and rois:
            event.roi = {"data": "base64...", "bbox": [0, 0, 100, 100]}
        self.assertIsNotNone(event.roi)


class TestSenderLatencyTracking(unittest.TestCase):
    """Test that SenseSender tracks send latencies."""

    def test_init_has_latency_fields(self):
        sender = SenseSender()
        self.assertIsInstance(sender._latencies, list)
        self.assertEqual(len(sender._latencies), 0)
        self.assertIsInstance(sender._last_stats_ts, float)

    @patch("sense_client.sender.requests.post")
    def test_send_tracks_latency(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_post.return_value = mock_resp

        sender = SenseSender(url="http://localhost:18791")
        event = SenseEvent(type="text", ts=time.time() * 1000, ocr="test",
                           meta=SenseMeta(ssim=0.9, app="test"))

        ok = sender.send(event)
        self.assertTrue(ok)
        self.assertEqual(len(sender._latencies), 1)
        self.assertGreater(sender._latencies[0], 0)

    @patch("sense_client.sender.requests.post")
    def test_stats_logged_after_interval(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_post.return_value = mock_resp

        sender = SenseSender(url="http://localhost:18791")
        sender._last_stats_ts = time.time() - 61  # pretend 61s ago

        event = SenseEvent(type="text", ts=time.time() * 1000, ocr="test",
                           meta=SenseMeta(ssim=0.9, app="test"))

        with patch("builtins.print") as mock_print:
            sender.send(event)
            # Should have logged stats
            calls = [str(c) for c in mock_print.call_args_list]
            stats_logged = any("[sender] relay latency" in c for c in calls)
            self.assertTrue(stats_logged, f"Expected latency stats log, got: {calls}")

    @patch("sense_client.sender.requests.post")
    def test_stats_not_logged_before_interval(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_post.return_value = mock_resp

        sender = SenseSender(url="http://localhost:18791")
        # _last_stats_ts defaults to now, so interval not elapsed

        event = SenseEvent(type="text", ts=time.time() * 1000, ocr="test",
                           meta=SenseMeta(ssim=0.9, app="test"))

        with patch("builtins.print") as mock_print:
            sender.send(event)
            calls = [str(c) for c in mock_print.call_args_list]
            stats_logged = any("[sender] relay latency" in c for c in calls)
            self.assertFalse(stats_logged)


class TestParallelOCR(unittest.TestCase):
    """Test parallel OCR logic from __main__.py."""

    def test_single_roi_no_threadpool(self):
        """With 1 ROI, OCR is called directly (no ThreadPoolExecutor)."""
        mock_ocr = MagicMock()
        mock_ocr.extract.return_value = OCRResult(text="hello world test text here", confidence=90, word_count=5)

        roi = MagicMock()
        rois = [roi]

        # Simulate single-ROI path
        if len(rois) == 1:
            result = mock_ocr.extract(rois[0].image)
        else:
            result = None

        self.assertIsNotNone(result)
        self.assertEqual(result.text, "hello world test text here")
        mock_ocr.extract.assert_called_once()

    def test_multiple_rois_picks_best(self):
        """With multiple ROIs, pick the result with most text."""
        results = [
            OCRResult(text="short", confidence=90, word_count=1),
            OCRResult(text="this is the longest text result here", confidence=85, word_count=7),
            OCRResult(text="medium text", confidence=88, word_count=2),
        ]

        best = max(results, key=lambda r: len(r.text))
        self.assertEqual(best.text, "this is the longest text result here")


if __name__ == "__main__":
    unittest.main()
