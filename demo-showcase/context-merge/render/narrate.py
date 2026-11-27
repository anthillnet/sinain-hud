"""Generate scene-timed narration for the Sinain context-merge demo."""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro


ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "output"
CLIPS = OUTPUT / "narration-clips"
MODEL_DIR = Path(os.environ.get("KOKORO_MODEL_DIR", "/private/tmp/sinain-kokoro-models"))
MODEL = MODEL_DIR / "kokoro-v1.0.onnx"
VOICES = MODEL_DIR / "voices-v1.0.bin"
VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
DURATION = 24.0

# start time, available speaking window, narration
LINES = [
    (0.65, 3.20, "Sinain notices what you're working on."),
    (4.65, 3.15, "It tracks your work across every app and A I."),
    (8.65, 3.75, "Every A I starts with the goal, what's done, and what comes next."),
    (13.20, 4.10, "Step away. Sinain keeps watching agent progress while you're gone."),
    (18.10, 2.35, "Come back to what changed, and what to do next."),
    (21.05, 2.10, "Your A I should pay attention."),
]


def synthesize_to_window(kokoro: Kokoro, text: str, window: float) -> tuple[np.ndarray, int, float]:
    speed = 1.04
    audio, rate = kokoro.create(text, voice=VOICE, speed=speed, lang="en-us")
    length = len(audio) / rate
    if length > window:
        speed = min(1.45, speed * length / window * 1.04)
        audio, rate = kokoro.create(text, voice=VOICE, speed=speed, lang="en-us")
    return np.asarray(audio, dtype=np.float32).reshape(-1), rate, speed


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    CLIPS.mkdir(parents=True, exist_ok=True)
    kokoro = Kokoro(str(MODEL), str(VOICES))
    sample_rate = 24000
    track = np.zeros(round(DURATION * sample_rate), dtype=np.float32)

    for index, (start, window, text) in enumerate(LINES, start=1):
        audio, rate, speed = synthesize_to_window(kokoro, text, window)
        if rate != sample_rate:
            raise RuntimeError(f"Unexpected Kokoro sample rate: {rate}")

        fade_samples = min(round(0.025 * rate), len(audio) // 2)
        if fade_samples:
            ramp = np.linspace(0.0, 1.0, fade_samples, dtype=np.float32)
            audio[:fade_samples] *= ramp
            audio[-fade_samples:] *= ramp[::-1]

        sf.write(CLIPS / f"{index:02d}.wav", audio, rate, subtype="PCM_16")
        offset = round(start * rate)
        end = min(offset + len(audio), len(track))
        track[offset:end] += audio[: end - offset]
        print(f"{index:02d}  {start:05.2f}s  {len(audio) / rate:04.2f}s  {speed:0.2f}x  {text}")

    peak = float(np.max(np.abs(track)))
    if peak > 0.95:
        track *= 0.95 / peak
    sf.write(OUTPUT / "sinain-context-merge-narration.wav", track, sample_rate, subtype="PCM_24")
    print(f"Wrote {OUTPUT / 'sinain-context-merge-narration.wav'}")


if __name__ == "__main__":
    main()
