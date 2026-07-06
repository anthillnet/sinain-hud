"""Transcription router + filter tests — no network, no models.

Run: python3 -m unittest discover -s packages/sinain-sense/tests -v
sinain_llm and requests are mocked; the faster-whisper case skips without the extra.
"""

import importlib.util
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

_HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_HERE))
sys.path.insert(0, str(_HERE.parent / "sinain-llm"))

from sinain_sense.audio import (  # noqa: E402
    OpenRouterAudioBackend,
    TranscriptDeduper,
    TranscriptionRouter,
    TranscriptResult,
    WavChunk,
    WhisperServerBackend,
    bigram_similarity,
    compose_whisper_prompt,
    is_hallucination,
    wav_header,
)


def _chunk(audio_source="system", pcm=b"\x00\x01" * 800):
    return WavChunk(buffer=wav_header(len(pcm), 16000, 1) + pcm, source="dev",
                    ts=time.time(), duration_ms=50, energy=0.1,
                    audio_source=audio_source)


class _FakeBackend:
    name = "fake"

    def __init__(self, texts):
        self.texts = list(texts)
        self.prompts = []

    def transcribe(self, chunk, prompt=None):
        self.prompts.append(prompt)
        text = self.texts.pop(0)
        if text is None:
            return None
        return TranscriptResult(text=text, source="fake", confidence=0.9,
                                ts=time.time(), audio_source=chunk.audio_source)


class TestFilters(unittest.TestCase):
    def test_hallucination_repeated_tokens(self):
        self.assertTrue(is_hallucination("kuch kuch kuch kuch kuch kuch kuch"))
        self.assertFalse(is_hallucination("this is a perfectly normal sentence here"))
        self.assertFalse(is_hallucination("too short"))  # <6 words never flags

    def test_bigram_similarity(self):
        self.assertEqual(bigram_similarity("same", "same"), 1.0)
        self.assertGreater(bigram_similarity("hello world", "hello worlds"), 0.8)
        self.assertLess(bigram_similarity("hello world", "quantum physics"), 0.2)

    def test_deduper_same_source_and_cross_stream(self):
        d = TranscriptDeduper()
        self.assertEqual(d.check("let's review the design doc", "system"),
                         "let's review the design doc")
        # near-duplicate on the same source → dropped
        self.assertIsNone(d.check("let's review the design doc", "system"))
        # mic hears the speakers (>70% similar to recent system) → dropped
        self.assertIsNone(d.check("let's review the design doc!", "mic"))
        # genuinely new mic speech → kept
        self.assertEqual(d.check("completely different sentence", "mic"),
                         "completely different sentence")

    def test_compose_prompt_tail_clip(self):
        self.assertIsNone(compose_whisper_prompt(None, None))
        self.assertEqual(compose_whisper_prompt("Sinain", "prior text"),
                         "Sinain prior text")
        long = "x" * 500
        self.assertEqual(len(compose_whisper_prompt(long, None)), 220)


class TestRouter(unittest.TestCase):
    def test_filters_short_and_hallucinated(self):
        be = _FakeBackend(["hi", "kuch kuch kuch kuch kuch kuch kuch", "a real transcript"])
        r = TranscriptionRouter(be, min_chars=3)
        self.assertIsNone(r.transcribe(_chunk()))           # "hi" < min_chars → dropped
        self.assertIsNone(r.transcribe(_chunk()))           # hallucination dropped
        self.assertEqual(r.transcribe(_chunk()).text, "a real transcript")

    def test_rolling_context_per_source_and_age_gate(self):
        be = _FakeBackend(["first utterance from the system stream",
                           "second", "mic side speech content"])
        r = TranscriptionRouter(be, hotwords="Sinain")
        r.transcribe(_chunk("system"))
        self.assertEqual(be.prompts[0], "Sinain")            # no context yet
        r.transcribe(_chunk("system"))
        self.assertIn("first utterance", be.prompts[1])      # system context carried
        r.transcribe(_chunk("mic"))
        self.assertEqual(be.prompts[2], "Sinain")            # mic NOT contaminated by system
        # age gate: stale context is not carried
        r._last["system"].ts -= 100
        be.texts.append("later")
        r.transcribe(_chunk("system"))
        self.assertEqual(be.prompts[3], "Sinain")

    def test_backend_none_passes_through(self):
        r = TranscriptionRouter(_FakeBackend([None]))
        self.assertIsNone(r.transcribe(_chunk()))


class TestOpenRouterBackend(unittest.TestCase):
    def test_payload_and_cost(self):
        import sinain_llm
        be = OpenRouterAudioBackend(model="google/gemini-2.5-flash",
                                    language="auto", api_key="k")
        ok = {"text": " hello there ", "model": "m",
              "usage": {"prompt_tokens": 9, "completion_tokens": 4,
                        "total_tokens": 13, "cost": 0.00031}}
        with mock.patch.object(sinain_llm, "chat", return_value=ok) as m:
            res = be.transcribe(_chunk("mic"), prompt="Sinain, JetBrains")
        self.assertEqual(res.text, "hello there")
        self.assertEqual(res.audio_source, "mic")
        self.assertEqual(res.cost["cost"], 0.00031)
        content = m.call_args.kwargs["messages"][0]["content"]
        self.assertEqual(content[0]["input_audio"]["format"], "wav")
        txt = content[1]["text"]
        self.assertIn("language it was spoken", txt)         # auto mode
        self.assertIn("EXACTLY as spoken", txt)              # entity guard
        self.assertIn("Sinain, JetBrains", txt)              # hotwords
        self.assertEqual(m.call_args.kwargs["api_key"], "k")

    def test_strict_language_gate(self):
        import sinain_llm
        be = OpenRouterAudioBackend(language="en-US")
        ok = {"text": "x y z", "model": "m", "usage": {"cost": None}}
        with mock.patch.object(sinain_llm, "chat", return_value=ok) as m:
            be.transcribe(_chunk())
        txt = m.call_args.kwargs["messages"][0]["content"][1]["text"]
        self.assertIn("in en-US", txt)
        self.assertIn("If the audio is not in en-US", txt)

    def test_llm_error_returns_none(self):
        import sinain_llm
        be = OpenRouterAudioBackend()
        with mock.patch.object(sinain_llm, "chat", side_effect=sinain_llm.LLMError("x")):
            self.assertIsNone(be.transcribe(_chunk()))


class TestWhisperServerBackend(unittest.TestCase):
    def test_inference_request_shape(self):
        be = WhisperServerBackend(base_url="http://127.0.0.1:8910", language="en-US")
        resp = mock.Mock(status_code=200)
        resp.raise_for_status = mock.Mock()
        resp.json.return_value = {"text": " transcribed text "}
        with mock.patch("requests.post", return_value=resp) as m:
            res = be.transcribe(_chunk(), prompt="Sinain")
        self.assertEqual(res.text, "transcribed text")
        self.assertEqual(res.source, "whisper")
        url = m.call_args.args[0]
        self.assertEqual(url, "http://127.0.0.1:8910/inference")
        data = m.call_args.kwargs["data"]
        self.assertEqual(data["language"], "en")             # region stripped
        self.assertEqual(data["prompt"], "Sinain")
        self.assertIn("file", m.call_args.kwargs["files"])

    def test_connection_error_returns_none(self):
        be = WhisperServerBackend()
        with mock.patch("requests.post", side_effect=ConnectionError("down")):
            self.assertIsNone(be.transcribe(_chunk()))
        with mock.patch("requests.get", side_effect=ConnectionError("down")):
            self.assertFalse(be.is_available())


@unittest.skipUnless(importlib.util.find_spec("faster_whisper"),
                     "faster-whisper extra not installed")
class TestFasterWhisperBackend(unittest.TestCase):
    def test_wav_decode_roundtrip(self):
        from sinain_sense.audio import FasterWhisperBackend
        pcm = b"\x00\x40" * 1600  # constant 0x4000 samples
        wav = wav_header(len(pcm), 16000, 1) + pcm
        audio = FasterWhisperBackend._wav_to_float32(wav)
        self.assertEqual(len(audio), 1600)
        self.assertAlmostEqual(float(audio[0]), 16384 / 32768.0, places=4)


if __name__ == "__main__":
    unittest.main()
