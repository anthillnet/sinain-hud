# ar-bridge — desktop peer for ARSinain voice sessions

Publishes the screen (sck-capture frame IPC) + microphone to an ARSinain
server over WebRTC, plays the returned TTS audio, and sends the context seed
over the `meta` datachannel. Spawned by sinain-core's VoiceSessionManager
(`POST /voice/start`); not meant to be run by hand, but can be:

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python bridge.py --server http://127.0.0.1:8089
```

Core resolves the interpreter as `tools/ar-bridge/.venv/bin/python` when the
venv exists, else `python3`. Requires the ARSinain branch `feat/hud-seed`
(seed handling on the datachannel); older servers ignore the seed and the
session still works, just unseeded.

Stdout protocol (parsed by core): `AR-BRIDGE live` · `AR-BRIDGE error: …` ·
`AR-BRIDGE ended` · `AR-BRIDGE meta …` (proactive markers, for a future UI).
