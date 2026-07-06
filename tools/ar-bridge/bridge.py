#!/usr/bin/env python3
"""Sinain AR bridge — connects the desktop to an ARSinain voice session.

Publishes over WebRTC to an ARSinain server (../ARSinain):
  video: the screen — sck-capture's frame IPC file, polled at --fps
  audio: the microphone (sounddevice), 48k mono 20ms frames
and plays the returned TTS audio track on the default output device.

On datachannel open it sends the context seed (a situation brief built by
sinain-core) as {type: "seed", text, say} — ARSinain lands it in the talk
history and speaks the `say` line as the opening acknowledgment.

Spawned and supervised by sinain-core (VoiceSessionManager). Stdout protocol,
one line per event, parsed by core:
  AR-BRIDGE live
  AR-BRIDGE error: <reason>
  AR-BRIDGE ended
SIGTERM/SIGINT end the session cleanly.
"""
import argparse
import asyncio
import fractions
import json
import os
import signal
import sys
from io import BytesIO

import ssl

import aiohttp
import certifi
import av
import numpy as np
from aiortc import MediaStreamTrack, RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import MediaStreamError
from PIL import Image

try:
    import sounddevice as sd
except Exception:  # noqa: BLE001 — video-only fallback (no mic, no speaker)
    sd = None

AUDIO_RATE = 48000
AUDIO_SAMPLES = 960  # 20ms @ 48k
VIDEO_CLOCK = 90000


def emit(line: str) -> None:
    print(f"AR-BRIDGE {line}", flush=True)


class ScreenTrack(MediaStreamTrack):
    """Video track fed from sck-capture's atomically-replaced frame.jpg."""

    kind = "video"

    def __init__(self, path: str, fps: float):
        super().__init__()
        self.path = path
        self.period = 1.0 / max(0.5, fps)
        self._mtime = 0.0
        self._arr = np.zeros((720, 1280, 3), dtype=np.uint8)  # black until first frame
        self._ts = 0

    async def recv(self) -> av.VideoFrame:
        await asyncio.sleep(self.period)
        try:
            mtime = os.path.getmtime(self.path)
            if mtime != self._mtime:
                with open(self.path, "rb") as f:
                    data = f.read()
                img = Image.open(BytesIO(data)).convert("RGB")
                arr = np.asarray(img)
                # Even dimensions required by most encoders.
                self._arr = arr[: arr.shape[0] // 2 * 2, : arr.shape[1] // 2 * 2]
                self._mtime = mtime
        except Exception:  # noqa: BLE001 — partial write / missing file: keep last frame
            pass
        frame = av.VideoFrame.from_ndarray(self._arr, format="rgb24")
        self._ts += int(VIDEO_CLOCK * self.period)
        frame.pts = self._ts
        frame.time_base = fractions.Fraction(1, VIDEO_CLOCK)
        return frame


class MicTrack(MediaStreamTrack):
    """Microphone → 20ms s16 mono frames via sounddevice."""

    kind = "audio"

    def __init__(self):
        super().__init__()
        self._queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=16)
        self._ts = 0
        loop = asyncio.get_event_loop()

        def _cb(indata, _frames, _time, status):  # sounddevice thread
            if status:
                pass  # over/underflows are survivable
            data = bytes(indata)
            try:
                loop.call_soon_threadsafe(self._queue.put_nowait, data)
            except Exception:  # noqa: BLE001 — queue full: drop (late > stale)
                pass

        self._stream = sd.RawInputStream(
            samplerate=AUDIO_RATE, channels=1, dtype="int16",
            blocksize=AUDIO_SAMPLES, callback=_cb,
        )
        self._stream.start()

    async def recv(self) -> av.AudioFrame:
        data = await self._queue.get()
        frame = av.AudioFrame(format="s16", layout="mono", samples=AUDIO_SAMPLES)
        frame.planes[0].update(data)
        frame.sample_rate = AUDIO_RATE
        frame.pts = self._ts
        self._ts += AUDIO_SAMPLES
        frame.time_base = fractions.Fraction(1, AUDIO_RATE)
        return frame

    def stop(self):
        try:
            self._stream.stop()
            self._stream.close()
        except Exception:  # noqa: BLE001
            pass
        super().stop()


async def play_remote_audio(track: MediaStreamTrack) -> None:
    """Sinain's TTS → default output device."""
    if sd is None:
        emit("error: sounddevice unavailable — cannot play voice")
        return
    out = sd.RawOutputStream(samplerate=AUDIO_RATE, channels=1, dtype="int16")
    out.start()
    resampler = av.AudioResampler(format="s16", layout="mono", rate=AUDIO_RATE)
    try:
        while True:
            frame = await track.recv()
            for f in resampler.resample(frame):
                out.write(bytes(f.planes[0]))
    except MediaStreamError:
        pass
    finally:
        try:
            out.stop()
            out.close()
        except Exception:  # noqa: BLE001
            pass


async def run(args: argparse.Namespace) -> int:
    seed = {}
    if args.seed_file:
        try:
            with open(args.seed_file, "r", encoding="utf-8") as f:
                seed = json.load(f)
        except Exception as e:  # noqa: BLE001 — session still useful unseeded
            emit(f"error: seed file unreadable ({e}) — continuing unseeded")

    # Auth headers for a deployed (oauth2-proxy-fronted) server: the user's
    # own browser session cookie. Local dev servers need neither.
    auth_headers = {}
    if args.cookie:
        auth_headers["Cookie"] = args.cookie
    if args.email:
        auth_headers["X-Auth-Request-Email"] = args.email

    # Reachability probe FIRST — before any audio/video hardware is touched.
    # Opening the mic can block on the macOS permission prompt; a down server
    # must fail fast, not hang behind TCC.
    ssl_ctx = ssl.create_default_context(cafile=certifi.where())

    def http_session():
        return aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=ssl_ctx))

    try:
        async with http_session() as session:
            async with session.get(args.server.rstrip("/") + "/",
                                   headers=auth_headers,
                                   allow_redirects=False,
                                   timeout=aiohttp.ClientTimeout(total=8)) as resp:
                if resp.status in (301, 302, 303, 307, 308, 401, 403):
                    emit("error: the server wants a login — set ARSINAIN_COOKIE "
                         "to your browser's _oauth2_proxy cookie")
                    return 1
                await resp.read()
    except Exception as e:  # noqa: BLE001
        emit(f"error: cannot reach ARSinain at {args.server}: {e}")
        return 1

    pc = RTCPeerConnection()
    stop = asyncio.Event()

    channel = pc.createDataChannel("meta")

    @channel.on("open")
    def on_open():
        if seed.get("text") or seed.get("say"):
            channel.send(json.dumps({"type": "seed",
                                     "text": seed.get("text", ""),
                                     "say": seed.get("say", "")}))
            emit("seed sent")

    @channel.on("message")
    def on_message(msg):
        # Proactive markers etc. — plumbing logs them; a future UI may render
        # them as region eyes.
        emit(f"meta {str(msg)[:160]}")

    @pc.on("track")
    def on_track(track):
        if track.kind == "audio":
            asyncio.ensure_future(play_remote_audio(track))

    @pc.on("connectionstatechange")
    def on_state():
        if pc.connectionState == "connected":
            emit("live")
        elif pc.connectionState in ("failed", "closed"):
            stop.set()

    mic = None
    pc.addTrack(ScreenTrack(args.frame, args.fps))
    if args.no_audio:
        emit("audio disabled (--no-audio)")
    elif sd is not None:
        try:
            mic = MicTrack()
            pc.addTrack(mic)
        except Exception as e:  # noqa: BLE001 — no mic ≠ no session
            emit(f"error: mic unavailable ({e}) — publishing screen only")
    else:
        emit("error: sounddevice unavailable — publishing screen only")

    await pc.setLocalDescription(await pc.createOffer())
    headers = dict(auth_headers)
    try:
        async with http_session() as session:
            async with session.post(
                f"{args.server.rstrip('/')}/offer",
                json={"sdp": pc.localDescription.sdp, "type": pc.localDescription.type},
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                if resp.status != 200:
                    body = (await resp.text())[:200]
                    emit(f"error: signaling {resp.status}: {body}")
                    return 1
                answer = await resp.json()
    except Exception as e:  # noqa: BLE001
        emit(f"error: cannot reach ARSinain at {args.server}: {e}")
        return 1

    await pc.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type=answer["type"]))

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    await stop.wait()
    if mic is not None:
        mic.stop()
    await pc.close()
    emit("ended")
    return 0


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--server", default="http://127.0.0.1:8089", help="ARSinain base URL")
    p.add_argument("--frame", default=os.path.expanduser("~/.sinain/capture/frame.jpg"),
                   help="screen frame IPC file (sck-capture)")
    p.add_argument("--fps", type=float, default=4.0, help="screen publish rate")
    p.add_argument("--seed-file", default="", help="JSON file: {text, say}")
    p.add_argument("--email", default="", help="X-Auth-Request-Email for gated servers")
    p.add_argument("--cookie", default="",
                   help="oauth2-proxy session cookie for a deployed server")
    p.add_argument("--no-audio", action="store_true",
                   help="publish screen only (no mic, no speaker) — smoke tests")
    args = p.parse_args()
    sys.exit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
