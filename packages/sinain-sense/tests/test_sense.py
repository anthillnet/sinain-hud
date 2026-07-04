"""Unit tests for sinain_sense — no network; requests / sinain_llm mocked.

Run: python3 -m unittest discover -s packages/sinain-sense/tests -v
Gate tests skip when their extra (scikit-image / cv2) is absent.
"""

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock

_HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_HERE))
sys.path.insert(0, str(_HERE.parent / "sinain-llm"))

from sinain_sense import (  # noqa: E402
    SenseEvent,
    SenseMeta,
    SenseSender,
    apply_privacy,
    encode_image,
    frame_dims,
    redact_sensitive,
    strip_private,
)
from sinain_sense.vision import OpenRouterVisionProvider  # noqa: E402

_HAS_SKIMAGE = importlib.util.find_spec("skimage") is not None
_HAS_CV2 = importlib.util.find_spec("cv2") is not None
_HAS_PIL = importlib.util.find_spec("PIL") is not None


class TestPrivacy(unittest.TestCase):
    def test_strip_private(self):
        self.assertEqual(strip_private("a <private>secret\nstuff</private> b"), "a  b")

    def test_redactions(self):
        cases = [
            ("card 4111 1111 1111 1111 ok", "[REDACTED:card]"),
            ("Bearer abcdefghijklmnopqrstuvwx", "[REDACTED:bearer]"),
            ("password: hunter2", "[REDACTED:password]"),
            ("eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM", "[REDACTED:jwt]"),
            ("mail me at a.b@example.com", "[REDACTED:email]"),
            ("ssn 123-45-6789", "[REDACTED:ssn]"),
        ]
        for text, marker in cases:
            self.assertIn(marker, redact_sensitive(text), text)

    def test_apply_privacy_pipeline(self):
        out = apply_privacy("<private>x</private> password=abc")
        self.assertEqual(out, "[REDACTED:password]")


class TestSender(unittest.TestCase):
    def test_send_payload_shape_and_retry(self):
        ev = SenseEvent(type="text", ts=123.0, ocr="hello",
                        meta=SenseMeta(ssim=0.9, app="Xcode", window_title="t", screen=1),
                        vision_cost={"cost": 0.001, "cost_id": "abc"})
        ok = mock.Mock(status_code=200)
        fail = mock.Mock(status_code=503)
        post = mock.Mock(side_effect=[fail, ok])
        with mock.patch("sinain_sense.sender.requests.post", post), \
             mock.patch("time.sleep"):
            self.assertTrue(SenseSender("http://localhost:9500").send(ev))
        self.assertEqual(post.call_count, 2)  # retried once, then succeeded
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["type"], "text")
        self.assertEqual(payload["meta"], {"ssim": 0.9, "app": "Xcode",
                                           "windowTitle": "t", "screen": 1})
        self.assertEqual(payload["vision_cost"]["cost_id"], "abc")
        self.assertNotIn("roi", payload)  # optional fields omitted when unset

    def test_send_motion_fire_and_forget(self):
        post = mock.Mock(side_effect=ConnectionError("down"))
        with mock.patch("sinain_sense.sender.requests.post", post):
            SenseSender().send_motion(1.5, -2.0, [], "Safari", 0)  # must not raise

    @unittest.skipUnless(_HAS_PIL, "Pillow not installed")
    def test_encode_image_budget_and_last_resort(self):
        import base64
        from PIL import Image
        # Compressible image → binary search lands under budget
        flat = Image.new("RGB", (640, 400), (40, 90, 120))
        b64 = encode_image(flat, max_kb=20)
        self.assertLessEqual(len(base64.b64decode(b64)), 20 * 1024)
        # Incompressible noise under an impossible budget → documented last
        # resort: returns quality-20 JPEG anyway (never fails)
        noise = Image.effect_noise((640, 400), 100).convert("RGB")
        b64 = encode_image(noise, max_kb=1)
        self.assertTrue(base64.b64decode(b64).startswith(b"\xff\xd8"))  # JPEG magic
        self.assertEqual(frame_dims(noise), [640, 400])


class TestVision(unittest.TestCase):
    @unittest.skipUnless(_HAS_PIL, "Pillow not installed")
    def test_openrouter_provider_via_sinain_llm(self):
        from PIL import Image
        import sinain_llm
        img = Image.new("RGB", (64, 64), (10, 20, 30))
        provider = OpenRouterVisionProvider(api_key="k", model="google/gemini-2.5-flash-lite")
        res_ok = {"text": "a screen", "model": "m",
                  "usage": {"prompt_tokens": 5, "completion_tokens": 3,
                            "total_tokens": 8, "cost": 0.0002}}
        with mock.patch.object(sinain_llm, "chat", return_value=res_ok) as m:
            out = provider.describe(img, "what is it?")
        self.assertEqual(out.text, "a screen")
        self.assertEqual(out.cost["cost"], 0.0002)
        self.assertEqual(out.cost["model"], "google/gemini-2.5-flash-lite")
        self.assertEqual(len(out.cost["cost_id"]), 16)
        kw = m.call_args.kwargs
        self.assertEqual(kw["api_key"], "k")
        content = kw["messages"][0]["content"]
        self.assertEqual(content[0]["text"], "what is it?")
        self.assertTrue(content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,"))

    @unittest.skipUnless(_HAS_PIL, "Pillow not installed")
    def test_failure_returns_none_result(self):
        from PIL import Image
        import sinain_llm
        provider = OpenRouterVisionProvider(api_key="k")
        with mock.patch.object(sinain_llm, "chat", side_effect=sinain_llm.LLMError("boom")):
            out = provider.describe(Image.new("RGB", (8, 8)))
        self.assertIsNone(out.text)
        self.assertIsNone(out.cost)

    def test_no_key_short_circuits(self):
        out = OpenRouterVisionProvider(api_key="").describe(mock.Mock())
        self.assertIsNone(out.text)


@unittest.skipUnless(_HAS_SKIMAGE, "scikit-image not installed (ssim extra)")
class TestSsimGate(unittest.TestCase):
    def test_detects_change_and_keyframes(self):
        from PIL import Image
        from sinain_sense.gates.ssim import ChangeDetector
        det = ChangeDetector(threshold=0.95, min_area=10)
        black = Image.new("L", (128, 128), 0)
        half = Image.new("L", (128, 128), 0)
        half.paste(255, (0, 0, 64, 128))
        self.assertIsNone(det.detect(black))          # first frame = keyframe
        self.assertIsNone(det.detect(black))          # unchanged
        res = det.detect(half)                        # big change
        self.assertIsNotNone(res)
        self.assertLess(res.ssim_score, 0.95)
        x, y, w, h = res.bbox
        self.assertGreater(w * h, 0)


@unittest.skipUnless(_HAS_CV2, "cv2 not installed (hash extra)")
class TestHashGate(unittest.TestCase):
    def test_classify_transitions(self):
        import numpy as np
        from sinain_sense.gates.hash import SceneGate
        gate = SceneGate(blur_min=0, scene_cd=0.0, motion_cd=0.0)
        rng = np.random.default_rng(0)
        a = rng.integers(0, 255, (120, 160, 3), dtype=np.uint8)
        verdict, reason = gate.classify(a)
        self.assertEqual((verdict, reason), ("scene", "first frame"))
        verdict, _ = gate.classify(a)
        self.assertEqual(verdict, "drop")             # unchanged frame drops


if __name__ == "__main__":
    unittest.main()
