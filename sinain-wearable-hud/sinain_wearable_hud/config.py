"""YAML config loader with environment variable interpolation."""

import os
import re
import copy
import yaml

_ENV_PATTERN = re.compile(r"\$\{(\w+)(?::([^}]*))?\}")

DEFAULTS = {
    "gateway": {
        "ws_url": "ws://85.214.180.247:18789",
        "token": "",
        "session_key": "agent:main:sinain",
    },
    "camera": {
        "enabled": True,
        "device": 0,
        "resolution": [1280, 720],
        "fps": 10,
        "jpeg_quality_text": 70,
        "jpeg_quality_default": 50,
        "scene_threshold": 0.80,
        "stable_threshold": 0.90,
        "motion_threshold": 8.0,
        "text_cooldown": 5,
        "motion_cooldown": 3,
        "ambient_interval": 30,
        "blur_threshold": 50,
    },
    "audio": {
        "enabled": True,
        "device": None,
        "sample_rate": 16000,
        "vad_aggressiveness": 2,
        "silence_timeout": 1.5,
        "min_speech_duration": 0.5,
        "max_chunk_duration": 30,
    },
    "display": {
        "mode": "oled",
        "oled": {
            "driver": "ssd1351",
            "width": 128,
            "height": 128,
            "spi_port": 0,
            "spi_device": 0,
            "gpio_dc": 25,
            "gpio_rst": 24,
            "contrast": 255,
            "font_size": 10,
        },
        "debug_server": {
            "enabled": True,
            "port": 8080,
            "host": "0.0.0.0",
        },
    },
    "ocr": {
        "enabled": True,
        "api_key": "",
        "model": "google/gemini-2.5-flash",
        "timeout_s": 15,
    },
    "observation": {
        "max_entries": 20,
        "max_age_s": 300,
    },
    "logging": {
        "level": "INFO",
    },
}


def _interpolate_env(value):
    """Replace ${VAR} or ${VAR:default} patterns with env values."""
    if not isinstance(value, str):
        return value

    def _replace(match):
        var_name = match.group(1)
        default = match.group(2)
        return os.environ.get(var_name, default if default is not None else "")

    return _ENV_PATTERN.sub(_replace, value)


def _deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge override into base, interpolating env vars."""
    result = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = _interpolate_env(value)
    return result


def load_config(path: str | None = None) -> dict:
    """Load YAML config from path, merge with defaults, interpolate env vars."""
    if path and os.path.exists(path):
        with open(path) as f:
            user_config = yaml.safe_load(f) or {}
        return _deep_merge(DEFAULTS, user_config)
    return copy.deepcopy(DEFAULTS)
