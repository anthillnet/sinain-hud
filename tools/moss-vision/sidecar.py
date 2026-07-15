#!/usr/bin/env python3
"""moss-vision sidecar — MOSS-VL-Realtime serving the sense_client vision lane.

Speaks the minimal Ollama surface OllamaVision uses:
    GET  /api/tags   → availability probe (200 + model list)
    POST /api/chat   → single-image describe, non-streaming

Run inside the MOSS venv (~/.sinain/venvs/moss):
    python tools/moss-vision/sidecar.py

Point sense_client at it:
    SINAIN_LOCAL_VISION=moss-vl-realtime
    SINAIN_LOCAL_VISION_URL=http://127.0.0.1:11435
    SINAIN_LOCAL_VISION_MAX_DIM=1280      # MOSS needs ~720p-area to read text
    SINAIN_LOCAL_VISION_TIMEOUT=30

Spike-validated settings (2026-07-15, M4 Max): sdpa attention, bf16, pixel
budget 1280*720 → 3.6 s/frame with correct on-screen reading. Requests are
serialized — one MPS model, and the vision lane is single-flight anyway.
"""

import base64
import io
import json
import logging
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

logging.basicConfig(level=logging.INFO, format="%(asctime)s [moss-vision] %(message)s")
log = logging.getLogger("moss-vision")

MODEL_DIR = os.environ.get(
    "MOSS_MODEL_DIR",
    os.path.expanduser("~/.sinain/models/moss-vl-realtime"),
)
PORT = int(os.environ.get("MOSS_PORT", "11435"))
PIXEL_BUDGET = int(os.environ.get("MOSS_PIXEL_BUDGET", str(1280 * 720)))
DEFAULT_MAX_TOKENS = int(os.environ.get("MOSS_MAX_TOKENS", "120"))
MODEL_NAME = "moss-vl-realtime"

_lock = threading.Lock()
_model = None
_proc = None


def _load():
    global _model, _proc
    import torch
    from transformers import AutoModelForCausalLM, AutoProcessor

    t0 = time.time()
    _proc = AutoProcessor.from_pretrained(MODEL_DIR, trust_remote_code=True)
    _model = AutoModelForCausalLM.from_pretrained(
        MODEL_DIR,
        trust_remote_code=True,
        torch_dtype=torch.bfloat16,
        attn_implementation="sdpa",
        low_cpu_mem_usage=True,
    ).to("mps").eval()
    log.info("model loaded in %.0fs (pixel_budget=%d)", time.time() - t0, PIXEL_BUDGET)

    # Warmup: the first MPS generate pays ~30s of kernel compilation; do it
    # here so the first real vision tick doesn't eat the cost.
    from PIL import Image
    t0 = time.time()
    _model.offline_image_generate(
        _proc, "warmup", Image.new("RGB", (1280, 800), (32, 32, 32)),
        longest_edge=PIXEL_BUDGET, max_new_tokens=8,
    )
    log.info("warmup generate done in %.0fs", time.time() - t0)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quiet default access log
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/tags":
            self._json(200, {"models": [{"name": MODEL_NAME, "model": MODEL_NAME}]})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/api/chat":
            self._json(404, {"error": "not found"})
            return
        try:
            from PIL import Image

            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length))
            msg = payload["messages"][-1]
            prompt = msg.get("content") or "Describe this screen."
            images = msg.get("images") or []
            if not images:
                self._json(400, {"error": "no image"})
                return
            img = Image.open(io.BytesIO(base64.b64decode(images[0]))).convert("RGB")
            max_tokens = (payload.get("options") or {}).get("num_predict", DEFAULT_MAX_TOKENS)

            t0 = time.time()
            with _lock:
                text = _model.offline_image_generate(
                    _proc, prompt, img,
                    longest_edge=PIXEL_BUDGET,
                    max_new_tokens=max_tokens,
                )
            dt = time.time() - t0
            log.info("tick: %.1fs img=%dx%d out=%d chars → %s",
                     dt, img.width, img.height, len(text), text[:100].replace("\n", " "))
            self._json(200, {
                "model": MODEL_NAME,
                "message": {"role": "assistant", "content": text},
                "done": True,
                "total_duration": int(dt * 1e9),
            })
        except Exception as e:
            log.exception("chat failed")
            self._json(500, {"error": str(e)})


if __name__ == "__main__":
    _load()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log.info("serving on 127.0.0.1:%d", PORT)
    srv.serve_forever()
