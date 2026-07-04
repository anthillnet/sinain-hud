"""Unit tests for sinain_llm — no network; requests.post is mocked.

Run: python3 -m unittest discover -s packages/sinain-llm/tests -v
"""

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sinain_llm import (  # noqa: E402
    CEREBRAS_URL,
    OPENROUTER_URL,
    LLMError,
    call_llm,
    call_llm_with_fallback,
    chat,
    extract_json,
)


def _resp(content="hello", usage=None, status=200):
    r = mock.Mock()
    r.status_code = status
    r.raise_for_status = mock.Mock()
    r.json.return_value = {
        "choices": [{"message": {"content": content}}],
        "usage": usage or {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }
    return r


ENV = {
    "OPENROUTER_API_KEY": "or-key",
    "CEREBRAS_API_KEY": "cb-key",
}


class TestProviderRouting(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, ENV, clear=False)
        self.env.start()
        self.addCleanup(self.env.stop)

    def _call(self, post, **kwargs):
        with mock.patch("sinain_llm.client.requests.post", post):
            return chat("sys", "user", **kwargs)

    def test_openrouter_default(self):
        post = mock.Mock(return_value=_resp())
        res = self._call(post, model="google/gemini-3-flash-preview")
        url = post.call_args.args[0]
        body = post.call_args.kwargs["json"]
        headers = post.call_args.kwargs["headers"]
        self.assertEqual(url, OPENROUTER_URL)
        self.assertEqual(body["model"], "google/gemini-3-flash-preview")
        self.assertEqual(headers["Authorization"], "Bearer or-key")
        self.assertEqual(res["text"], "hello")

    def test_openrouter_reflection_key_fallback(self):
        env = dict(ENV)
        del env["OPENROUTER_API_KEY"]
        env["OPENROUTER_API_KEY_REFLECTION"] = "refl-key"
        with mock.patch.dict(os.environ, env, clear=True):
            post = mock.Mock(return_value=_resp())
            with mock.patch("sinain_llm.client.requests.post", post):
                chat("s", "u", model="x/y")
            self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer refl-key")

    def test_openrouter_missing_key_raises_runtimeerror(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                chat("s", "u", model="x/y")

    def test_ollama_prefix_strips_and_is_keyless(self):
        post = mock.Mock(return_value=_resp())
        self._call(post, model="ollama/phi4-mini")
        url = post.call_args.args[0]
        body = post.call_args.kwargs["json"]
        headers = post.call_args.kwargs["headers"]
        self.assertIn("localhost:11434", url)
        self.assertEqual(body["model"], "phi4-mini")
        self.assertNotIn("Authorization", headers)

    def test_ollama_timeout_floor(self):
        post = mock.Mock(return_value=_resp())
        self._call(post, model="ollama/phi4-mini", timeout=60)
        self.assertEqual(post.call_args.kwargs["timeout"], 120.0)
        self._call(post, model="ollama/phi4-mini", timeout=300)
        self.assertEqual(post.call_args.kwargs["timeout"], 300)

    def test_cerebras_prefix_cache_key_and_json_mode(self):
        post = mock.Mock(return_value=_resp())
        self._call(post, model="cerebras/gemma-4-31b", cache_key="arsinain-help-v2", json_mode=True)
        url = post.call_args.args[0]
        body = post.call_args.kwargs["json"]
        headers = post.call_args.kwargs["headers"]
        self.assertEqual(url, CEREBRAS_URL)
        self.assertEqual(body["model"], "gemma-4-31b")
        self.assertEqual(headers["Authorization"], "Bearer cb-key")
        self.assertEqual(body["prompt_cache_key"], "arsinain-help-v2")
        self.assertEqual(body["response_format"], {"type": "json_object"})

    def test_cerebras_missing_key_raises(self):
        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "x"}, clear=True):
            with self.assertRaises(RuntimeError):
                chat("s", "u", model="cerebras/gemma-4-31b")

    def test_provider_routing_openrouter_only(self):
        post = mock.Mock(return_value=_resp())
        routing = {"order": ["WandB"], "ignore": ["ModelRun"]}
        self._call(post, model="google/gemma-4-31b-it", provider_routing=routing)
        self.assertEqual(post.call_args.kwargs["json"]["provider"], routing)
        self._call(post, model="cerebras/gemma-4-31b", provider_routing=routing)
        self.assertNotIn("provider", post.call_args.kwargs["json"])


class TestBodyShaping(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, ENV, clear=False)
        self.env.start()
        self.addCleanup(self.env.stop)

    def _body(self, post):
        return post.call_args.kwargs["json"]

    def test_json_schema_strict_and_ollama_format(self):
        schema = {"title": "facts", "type": "object"}
        post = mock.Mock(return_value=_resp())
        with mock.patch("sinain_llm.client.requests.post", post):
            chat("s", "u", model="ollama/qwen2.5:7b", json_schema=schema)
        body = self._body(post)
        self.assertEqual(body["response_format"]["type"], "json_schema")
        self.assertEqual(body["response_format"]["json_schema"]["name"], "facts")
        self.assertTrue(body["response_format"]["json_schema"]["strict"])
        self.assertEqual(body["format"], schema)  # Ollama-native constraint
        with mock.patch("sinain_llm.client.requests.post", post):
            chat("s", "u", model="openai/gpt-4o-mini", json_schema=schema)
        self.assertNotIn("format", self._body(post))

    def test_loose_json_mode_provider_gate(self):
        post = mock.Mock(return_value=_resp())
        for model, expected in [
            ("openai/gpt-4o-mini", True),
            ("google/gemini-3-flash-preview", True),
            ("ollama/phi4-mini", True),
            ("cerebras/gemma-4-31b", True),
            ("anthropic/claude-sonnet-4.6", False),
        ]:
            with mock.patch("sinain_llm.client.requests.post", post):
                chat("s", "u", model=model, json_mode=True)
            self.assertEqual("response_format" in self._body(post), expected, model)

    def test_temperature_seed_and_messages_override(self):
        post = mock.Mock(return_value=_resp())
        msgs = [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]
        with mock.patch("sinain_llm.client.requests.post", post):
            chat(model="x/y", temperature=0.0, seed=42, messages=msgs)
        body = self._body(post)
        self.assertEqual(body["temperature"], 0.0)
        self.assertEqual(body["seed"], 42)
        self.assertEqual(body["messages"], msgs)

    def test_empty_content_raises_llmerror(self):
        post = mock.Mock(return_value=_resp(content=""))
        with mock.patch("sinain_llm.client.requests.post", post):
            with self.assertRaises(LLMError):
                chat("s", "u", model="x/y")

    def test_extra_body_merged_last(self):
        post = mock.Mock(return_value=_resp())
        with mock.patch("sinain_llm.client.requests.post", post):
            chat("s", "u", model="google/gemini-2.5-flash",
                 extra_body={"plugins": [{"id": "web", "max_results": 5}], "max_tokens": 200})
        body = self._body(post)
        self.assertEqual(body["plugins"], [{"id": "web", "max_results": 5}])
        self.assertEqual(body["max_tokens"], 200)  # extra_body wins over defaults

    def test_usage_cost_passthrough(self):
        post = mock.Mock(return_value=_resp(usage={"prompt_tokens": 1, "completion_tokens": 2,
                                                   "total_tokens": 3, "cost": 0.00012}))
        with mock.patch("sinain_llm.client.requests.post", post):
            res = chat("s", "u", model="x/y")
        self.assertEqual(res["usage"]["cost"], 0.00012)


class TestFallback(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, ENV, clear=False)
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_fallback_chain(self):
        calls = []

        def fake_call(system, user, model, max_tokens=1500, **kw):
            calls.append(model)
            if model == "primary/m":
                raise LLMError("boom")
            return "ok"

        with mock.patch("sinain_llm.client.call_llm", side_effect=fake_call), \
             mock.patch("time.sleep"):
            out = call_llm_with_fallback("s", "u", "primary/m",
                                         retries=1, fallback_models=["fb/one", "fb/two"])
        self.assertEqual(out, "ok")
        self.assertEqual(calls, ["primary/m", "primary/m", "fb/one"])

    def test_exhausted_chain_raises_last_error(self):
        with mock.patch("sinain_llm.client.call_llm", side_effect=LLMError("x")), \
             mock.patch("time.sleep"):
            with self.assertRaises(LLMError):
                call_llm_with_fallback("s", "u", "p/m", retries=0, fallback_models=["f/1"])

    def test_call_llm_returns_text(self):
        post = mock.Mock(return_value=_resp(content="txt"))
        with mock.patch("sinain_llm.client.requests.post", post):
            self.assertEqual(call_llm("s", "u", "x/y"), "txt")


class TestExtractJson(unittest.TestCase):
    def test_clean(self):
        self.assertEqual(extract_json('{"a": 1}'), {"a": 1})

    def test_code_fence(self):
        self.assertEqual(extract_json('```json\n{"a": 1}\n```'), {"a": 1})

    def test_embedded_in_prose(self):
        self.assertEqual(extract_json('Sure! Here: {"a": [1, 2]} hope that helps'),
                         {"a": [1, 2]})

    def test_truncated_repair(self):
        self.assertEqual(extract_json('{"facts": ["one", "two'),
                         {"facts": ["one", "two"]})

    def test_no_json_raises(self):
        with self.assertRaises(ValueError):
            extract_json("nothing here")


if __name__ == "__main__":
    unittest.main()
