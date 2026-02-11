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
        # New: pHash fast gate settings
        "phashThreshold": 5,  # Hamming distance threshold (0-64)
        "useFastGate": True,
    },
    "ocr": {
        "enabled": True,
        "backend": "auto",
        "languages": ["en", "ru"],
        "lang": "eng",
        "psm": 11,
        "minConfidence": 50,
        # New: caching settings
        "cacheSize": 1000,
        "cacheMethod": "content",  # "content" (perceptual) or "pixel" (exact)
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
        # New: WebSocket settings
        "useWebSocket": True,
        "wsReconnectDelay": 2.0,
        "maxQueueSize": 100,
    },
    # New: region tracking settings
    "regions": {
        "gridSize": 16,
        "stabilityThresholdS": 30.0,
        "stabilityMinSamples": 5,
    },
    # New: text detection settings
    "textDetection": {
        "enabled": True,
        "threshold": 0.4,
        "minSize": [32, 16],
    },
    # New: semantic layer settings
    "semantic": {
        "enabled": True,
        "maxHistory": 30,
        "contextLines": 1,
        "maxDeltasPerEvent": 5,
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


def get_default_config() -> dict:
    """Get a copy of the default configuration."""
    return json.loads(json.dumps(DEFAULTS))
