"""USB microphone capture with WebRTC VAD for speech segmentation.

Records 16kHz mono PCM from the USB mic, uses webrtcvad to detect speech
boundaries, and emits AudioChunk objects when a speech segment ends
(silence > timeout).
"""

from __future__ import annotations

import asyncio
import logging
import struct
import time

from .protocol import AudioChunk

log = logging.getLogger(__name__)


class AudioCapture:
    """Captures speech segments from a USB microphone.

    Uses webrtcvad for voice activity detection on 30ms frames.
    Buffers speech audio and emits chunks when silence exceeds the timeout.
    """

    def __init__(self, config: dict, send_callback=None):
        audio = config.get("audio", {})
        self.device = audio.get("device")  # None = default
        self.sample_rate = audio.get("sample_rate", 16000)
        self.vad_aggressiveness = audio.get("vad_aggressiveness", 2)
        self.silence_timeout = audio.get("silence_timeout", 1.5)
        self.min_speech_duration = audio.get("min_speech_duration", 0.5)
        self.max_chunk_duration = audio.get("max_chunk_duration", 30)
        self.send_callback = send_callback

        # 30ms frames at 16kHz = 480 samples = 960 bytes (s16le)
        self.frame_duration_ms = 30
        self.frame_samples = self.sample_rate * self.frame_duration_ms // 1000
        self.frame_bytes = self.frame_samples * 2  # 16-bit

    async def run(self, stop_event: asyncio.Event) -> None:
        """Main capture loop using sounddevice InputStream."""
        try:
            import sounddevice as sd
            import webrtcvad
        except ImportError as e:
            log.error("Audio dependencies unavailable: %s", e)
            return

        vad = webrtcvad.Vad(self.vad_aggressiveness)

        # Shared state between callback and async loop
        audio_queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=100)
        loop = asyncio.get_event_loop()

        def _audio_callback(indata, frames, time_info, status):
            if status:
                log.debug("Audio status: %s", status)
            # Convert float32 → int16 PCM
            pcm = (indata[:, 0] * 32767).astype("int16").tobytes()
            try:
                loop.call_soon_threadsafe(audio_queue.put_nowait, pcm)
            except asyncio.QueueFull:
                pass  # Drop under backpressure

        try:
            stream = sd.InputStream(
                device=self.device,
                samplerate=self.sample_rate,
                channels=1,
                dtype="float32",
                blocksize=self.frame_samples,
                callback=_audio_callback,
            )
        except Exception as e:
            log.error("Cannot open audio device: %s", e)
            return

        stream.start()
        log.info("Audio capture started (rate=%dHz, vad=%d, device=%s)",
                 self.sample_rate, self.vad_aggressiveness, self.device)

        speech_buffer = bytearray()
        speech_start = 0.0
        silence_start = 0.0
        in_speech = False

        try:
            while not stop_event.is_set():
                try:
                    pcm_data = await asyncio.wait_for(
                        audio_queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue

                # Ensure frame is exactly the right size for VAD
                if len(pcm_data) != self.frame_bytes:
                    continue

                try:
                    is_speech = vad.is_speech(pcm_data, self.sample_rate)
                except Exception:
                    continue

                now = time.time()

                if is_speech:
                    if not in_speech:
                        in_speech = True
                        speech_start = now
                        speech_buffer = bytearray()
                        log.debug("Speech started")
                    silence_start = 0.0
                    speech_buffer.extend(pcm_data)

                    # Check max duration
                    duration = now - speech_start
                    if duration >= self.max_chunk_duration:
                        await self._emit_chunk(speech_buffer, speech_start,
                                               now)
                        speech_buffer = bytearray()
                        speech_start = now

                elif in_speech:
                    speech_buffer.extend(pcm_data)
                    if silence_start == 0.0:
                        silence_start = now

                    if now - silence_start >= self.silence_timeout:
                        duration = now - speech_start
                        if duration >= self.min_speech_duration:
                            await self._emit_chunk(speech_buffer, speech_start,
                                                   now)
                        else:
                            log.debug("Speech too short (%.1fs), discarded",
                                      duration)
                        speech_buffer = bytearray()
                        in_speech = False
                        silence_start = 0.0

        finally:
            stream.stop()
            stream.close()
            log.info("Audio capture stopped")

    async def _emit_chunk(self, buffer: bytearray, start: float,
                          end: float) -> None:
        """Package and send a completed speech segment."""
        duration = end - start
        chunk = AudioChunk(
            pcm_data=bytes(buffer),
            sample_rate=self.sample_rate,
            duration_s=duration,
            timestamp=start,
        )
        log.info("Speech chunk: %.1fs, %d bytes", duration, len(buffer))
        if self.send_callback:
            await self.send_callback(chunk)
