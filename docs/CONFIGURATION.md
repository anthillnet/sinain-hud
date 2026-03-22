# Configuration

All configuration is via environment variables in `sinain-core/.env`. Copy from the example to get started:

```bash
cp sinain-core/.env.example sinain-core/.env
```

The canonical source of truth is [`sinain-core/.env.example`](../sinain-core/.env.example).

---

## Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `9500` | sinain-core HTTP + WebSocket port |

## System Audio

| Variable | Default | Description |
|---|---|---|
| `AUDIO_CAPTURE_CMD` | `screencapturekit` | Capture backend: `screencapturekit` (zero-setup, macOS 13+), `sox`, or `ffmpeg` |
| `AUDIO_DEVICE` | `BlackHole 2ch` | macOS audio device (only used by sox/ffmpeg backends) |
| `AUDIO_SAMPLE_RATE` | `16000` | Sample rate in Hz |
| `AUDIO_CHUNK_MS` | `5000` | Audio chunk duration (ms) before transcription |
| `AUDIO_VAD_ENABLED` | `true` | Enable voice activity detection to skip silence |
| `AUDIO_VAD_THRESHOLD` | `0.003` | VAD energy threshold |
| `AUDIO_AUTO_START` | `true` | Start audio capture on launch |
| `AUDIO_GAIN_DB` | `20` | Audio gain in dB |

## Microphone (opt-in)

Disabled by default for privacy. Set `MIC_ENABLED=true` to capture the user's microphone.

| Variable | Default | Description |
|---|---|---|
| `MIC_ENABLED` | `false` | Enable microphone capture |
| `MIC_DEVICE` | `default` | Microphone device (`default` = system mic) |
| `MIC_CAPTURE_CMD` | `sox` | Capture backend: `sox` or `ffmpeg` |
| `MIC_SAMPLE_RATE` | `16000` | Sample rate in Hz |
| `MIC_CHUNK_MS` | `5000` | Chunk duration (ms) |
| `MIC_VAD_ENABLED` | `true` | Enable VAD |
| `MIC_VAD_THRESHOLD` | `0.008` | VAD threshold (higher due to ambient noise) |
| `MIC_AUTO_START` | `false` | Start mic capture on launch |
| `MIC_GAIN_DB` | `0` | Mic gain in dB |

## Transcription

| Variable | Default | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | — | **Required** (unless using local transcription) |
| `TRANSCRIPTION_BACKEND` | `openrouter` | `openrouter` or `local` (whisper.cpp on-device) |
| `TRANSCRIPTION_MODEL` | `google/gemini-2.5-flash` | Model for cloud transcription |
| `TRANSCRIPTION_LANGUAGE` | `en-US` | Language code |

## Local Transcription (whisper.cpp)

Only used when `TRANSCRIPTION_BACKEND=local`. Run `./setup-local-stt.sh` for one-time setup.

| Variable | Default | Description |
|---|---|---|
| `LOCAL_WHISPER_BIN` | `whisper-cli` | Path to whisper-cli binary |
| `LOCAL_WHISPER_MODEL` | `~/models/ggml-large-v3-turbo.bin` | Path to GGML model file |
| `LOCAL_WHISPER_TIMEOUT_MS` | `15000` | Max time (ms) per transcription call |

## Agent Loop

| Variable | Default | Description |
|---|---|---|
| `AGENT_ENABLED` | `true` | Enable the local agent analysis loop |
| `AGENT_MODEL` | `google/gemini-2.5-flash-lite` | Model for local digest |
| `AGENT_FALLBACK_MODELS` | — | Comma-separated fallback model chain |
| `AGENT_MAX_TOKENS` | `300` | Max tokens per agent response |
| `AGENT_TEMPERATURE` | `0.3` | Sampling temperature |
| `AGENT_PUSH_TO_FEED` | `true` | Push agent responses to overlay feed |
| `AGENT_DEBOUNCE_MS` | `3000` | Debounce delay before agent tick |
| `AGENT_MAX_INTERVAL_MS` | `30000` | Maximum interval between ticks |
| `AGENT_COOLDOWN_MS` | `10000` | Cooldown after a tick completes |
| `AGENT_MAX_AGE_MS` | `120000` | Context window lookback (2 min) |

## Escalation

| Variable | Default | Description |
|---|---|---|
| `ESCALATION_MODE` | `selective` | `off` / `selective` / `focus` / `rich` |
| `ESCALATION_COOLDOWN_MS` | `30000` | Minimum ms between escalations |
| `ESCALATION_TRANSPORT` | `auto` | `ws` / `http` / `auto` — use `http` for bare agent (no gateway) |

## OpenClaw / NemoClaw Gateway

| Variable | Default | Description |
|---|---|---|
| `OPENCLAW_WS_URL` | `ws://localhost:18789` | Gateway WebSocket URL |
| `OPENCLAW_WS_TOKEN` | — | 48-char hex auth token |
| `OPENCLAW_HTTP_URL` | `http://localhost:18789/hooks/agent` | Gateway HTTP hooks endpoint |
| `OPENCLAW_HTTP_TOKEN` | — | Same token as `WS_TOKEN` |
| `OPENCLAW_SESSION_KEY` | `agent:main:sinain` | Target session key (must match gateway) |
| `OPENCLAW_PHASE1_TIMEOUT_MS` | `10000` | Delivery timeout (circuit trips on failure) |
| `OPENCLAW_PHASE2_TIMEOUT_MS` | `120000` | Agent response timeout (no circuit trip) |
| `OPENCLAW_QUEUE_TTL_MS` | `300000` | Outbound queue message TTL (5 min) |
| `OPENCLAW_QUEUE_MAX_SIZE` | `10` | Max queued escalations |
| `OPENCLAW_PING_INTERVAL_MS` | `30000` | WS ping keepalive interval |

## SITUATION.md

| Variable | Default | Description |
|---|---|---|
| `SITUATION_MD_PATH` | `~/.openclaw/workspace/SITUATION.md` | Path for atomic SITUATION.md writes |
| `OPENCLAW_WORKSPACE_DIR` | `~/.openclaw/workspace` | OpenClaw workspace directory |

## Debug & Tracing

| Variable | Default | Description |
|---|---|---|
| `DEBUG` | `false` | Verbose logging (every tick, every chunk) |
| `TRACE_ENABLED` | `true` | Enable request tracing |
| `TRACE_DIR` | `~/.sinain-core/traces` | Trace output directory |
