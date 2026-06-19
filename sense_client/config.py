"""Configuration loader for sense_client."""
from __future__ import annotations

import json
import os
import sys

DEFAULTS = {
    "capture": {
        "mode": "screen",
        "target": 0,
        # Must keep up with sck-capture's IPC frame rate (CAPTURE_FPS, default 4)
        # so OCR and downstream eye re-anchoring run at full cadence. Env: SENSE_FPS.
        "fps": 4.0,
        "scale": 0.5,
    },
    "detection": {
        "ssimThreshold": 0.92,
        "minArea": 100,
        "roiPadding": 20,
        "cooldownMs": 5000,
    },
    "ocr": {
        "enabled": True,
        "backend": "auto",
        "languages": ["en", "ru"],
        "lang": "eng",
        "psm": 11,
        "minConfidence": 50,
    },
    "gate": {
        "minOcrChars": 20,
        "majorChangeThreshold": 0.85,
        # Min gap between emitted sense events. This caps how fast eyes update /
        # re-anchor (the 4fps capture can't help past this gate). Low so eyes
        # track scroll within ~0.5s instead of in 1.5s steps; OCR is local
        # (Apple Vision) so the extra cost is modest. adaptive applies for ~10s
        # after an app switch.
        "cooldownMs": 700,
        "adaptiveCooldownMs": 400,
        "contextCooldownMs": 10000,
    },
    "relay": {
        "url": "http://localhost:9500",
        "sendThumbnails": True,
        "maxImageKB": 500,
    },
    "vision": {
        "enabled": False,
        "backend": "ollama",
        "model": "qwen2.5vl:7b",
        "ollamaUrl": "http://localhost:11434",
        "timeout": 10.0,
        "throttleSeconds": 5,
        "prompt": "Describe what's on this screen: the application, UI state, any errors or notable content. Be concise (2-3 sentences).",
    },
    "optimization": {
        "backpressure": False,
        "textDedup": False,
        "visionRegionOfInterest": False,
        "shadowValidation": False,
    },
}


def load_config(path: str | None = None) -> dict:
    """Load config from JSON file, merge with defaults."""
    config = json.loads(json.dumps(DEFAULTS))  # deep copy
    if path and os.path.exists(path):
        try:
            with open(path) as f:
                user = json.load(f)
            for section, values in user.items():
                if section in config and isinstance(values, dict):
                    config[section].update(values)
                else:
                    config[section] = values
        except (json.JSONDecodeError, ValueError):
            pass  # use defaults
    # Env override for capture fps (kept in sync with sck-capture CAPTURE_FPS).
    if os.environ.get("SENSE_FPS"):
        try:
            config["capture"]["fps"] = float(os.environ["SENSE_FPS"])
        except ValueError:
            pass
    return config
