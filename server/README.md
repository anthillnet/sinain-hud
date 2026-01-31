# Server-Side Relays

Lightweight relay services that run on the server (alongside OpenClaw). They bridge the gap between Sinain and the Mac-side components.

## Components

### hud-relay.mjs

HTTP relay for the HUD text feed. Sinain pushes messages, the bridge polls them.

- **Port:** 18791
- **Endpoints:**
  - `POST /feed` — push a message `{ text, priority }`
  - `GET /feed?after=N` — poll messages after ID N
  - `GET /health` — health check
- **Storage:** in-memory ring buffer (last 100 items)
- **No dependencies** — Node.js stdlib only

```bash
node server/hud-relay.mjs
```

### audio-relay.py

TCP→HTTP audio relay. Receives raw audio from Mac via TCP, serves it as an HTTP stream for the transcriber.

- **TCP port:** 9999 (input from Mac)
- **HTTP port:** 8899 (output to transcriber)
- **Endpoint:** `GET /stream` — live audio stream (`audio/wav`)
- **No dependencies** — Python stdlib only

```bash
python3 server/audio-relay.py --tcp-port 9999 --http-port 8899
```

### Pipeline

```
Mac (audio)  → TCP :9999  → audio-relay.py → HTTP :8899/stream → transcriber
Mac (bridge) → polls :18791/feed ← hud-relay.mjs ← Sinain (push)
```

## Scripts

### hud-push.sh

Quick push to the HUD from the command line.

```bash
./server/scripts/hud-push.sh "Hello from Sinain" normal
./server/scripts/hud-push.sh "Alert!" urgent
```
