"""Configuration loader for sense_client."""

import json
import os

DEFAULTS = {
    "capture": {
        "mode": "screen",
        "target": 0,
        "fps": 10,
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
        "cooldownMs": 5000,
        "adaptiveCooldownMs": 2000,
        "contextCooldownMs": 10000,
    },
    "relay": {
        "url": "http://localhost:9500",
        "sendThumbnails": True,
        "maxImageKB": 500,
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
    return config
