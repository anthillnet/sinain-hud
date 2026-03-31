# Configuration Reference

All configuration is via environment variables in a single `.env` file at the project root.

```bash
cp .env.example .env    # then edit with your values
```

sinain-core, sinain-agent, and sense_client all read from this file.

---

## Context Analysis

The context analysis loop runs every 3–30 seconds inside sinain-core. It sends recent audio transcripts and screen OCR to an LLM, producing a **digest** — a structured summary of what's happening on screen and in audio. This digest drives:
- **Escalation scoring** — determines when to forward context to the escalation agent
- **SITUATION.md** — atomic file writes for the gateway agent's awareness
- **Recorder control** — start/stop recording decisions based on context

### Provider Selection

| Variable | Default | Description |
|---|---|---|
| `ANALYSIS_PROVIDER` | `openrouter` | LLM provider: `openrouter` or `ollama` |
| `ANALYSIS_MODEL` | `google/gemini-2.5-flash-lite` | Primary model for text-only ticks |
| `ANALYSIS_VISION_MODEL` | `google/gemini-2.5-flash` | Auto-selected when screen images present |
| `ANALYSIS_ENDPOINT` | *(auto)* | API endpoint. Defaults: OpenRouter → `https://openrouter.ai/api/v1/chat/completions`, Ollama → `http://localhost:11434` |
| `ANALYSIS_API_KEY` | *(from OPENROUTER_API_KEY)* | Bearer token. Not needed for Ollama. |
| `ANALYSIS_FALLBACK_MODELS` | `google/gemini-2.5-flash,anthropic/claude-3.5-haiku` | Comma-separated fallback chain (OpenRouter only) |
| `ANALYSIS_MAX_TOKENS` | `800` | Max output tokens |
| `ANALYSIS_TEMPERATURE` | `0.3` | LLM temperature (0–1) |
| `ANALYSIS_TIMEOUT` | `15000` | Request timeout in ms |

### OpenRouter (default)

```env
ANALYSIS_PROVIDER=openrouter
ANALYSIS_MODEL=google/gemini-2.5-flash-lite
OPENROUTER_API_KEY=sk-or-v1-...
```

Uses the OpenRouter chat completions API. Supports model fallback chains and automatic vision model upgrade when screen images are available. Costs ~$0.001/tick.

### Ollama (fully local)

```env
ANALYSIS_PROVIDER=ollama
ANALYSIS_MODEL=llava
# ANALYSIS_ENDPOINT=http://localhost:11434   # default
```

Calls your local Ollama instance. No API key needed. Install: `brew install ollama && ollama pull llava`. Supports both vision (with images) and text-only ticks through the same model.

For a fully offline setup, also set:
```env
TRANSCRIPTION_BACKEND=local
LOCAL_WHISPER_BIN=whisper-cli
LOCAL_WHISPER_MODEL=~/models/ggml-large-v3-turbo.bin
```

---

## API Keys

| Variable | Default | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Required unless fully local. Used by context analysis and cloud transcription. Get one free at [openrouter.ai](https://openrouter.ai). |

---

## Privacy

| Variable | Default | Description |
|---|---|---|
| `PRIVACY_MODE` | `off` | Privacy preset: `off` / `standard` / `strict` / `paranoid` |

| Mode | Behavior |
|---|---|
| `off` | All data flows freely — maximum insight quality |
| `standard` | Auto-redacts credentials (API keys, tokens, passwords) before cloud APIs |
| `strict` | Only summaries leave your machine — no raw OCR or transcripts sent to cloud |
| `paranoid` | Fully local: requires `ANALYSIS_PROVIDER=ollama` + `TRANSCRIPTION_BACKEND=local` |

---

## Escalation

Controls when and how context analysis results are forwarded to an external agent (OpenClaw gateway or bare agent).

| Variable | Default | Description |
|---|---|---|
| `ESCALATION_MODE` | `rich` | `off` / `selective` / `focus` / `rich` |
| `ESCALATION_COOLDOWN_MS` | `30000` | Minimum time between escalations |
| `ESCALATION_TRANSPORT` | `auto` | `ws` (gateway) / `http` (bare agent) / `auto` |

**Modes:**
- `off` — no escalation, analysis runs but responses are not forwarded
- `selective` — escalate when scoring detects errors, questions, or high-signal context
- `focus` — always escalate every tick
- `rich` — always escalate with maximum context (images + full transcript window)

---

## OpenClaw Gateway

| Variable | Default | Description |
|---|---|---|
| `OPENCLAW_WS_URL` | — | Gateway WebSocket endpoint |
| `OPENCLAW_WS_TOKEN` | — | 48-char hex auth token |
| `OPENCLAW_HTTP_URL` | — | Gateway HTTP endpoint for bare agent mode |
| `OPENCLAW_HTTP_TOKEN` | — | HTTP auth token (usually same as WS token) |
| `OPENCLAW_SESSION_KEY` | `agent:main:sinain` | Session key for the sinain agent |

---

## Bare Agent

The bare agent (`sinain-agent/run.sh`) polls sinain-core for escalations and responds using a local AI agent (Claude, Codex, etc.).

| Variable | Default | Description |
|---|---|---|
| `SINAIN_AGENT` | `claude` | Agent: `claude` / `codex` / `junie` / `goose` / `aider` / custom command |
| `SINAIN_CORE_URL` | `http://localhost:9500` | sinain-core endpoint |
| `SINAIN_POLL_INTERVAL` | `5` | Seconds between escalation polls |
| `SINAIN_HEARTBEAT_INTERVAL` | `900` | Seconds between heartbeat ticks (15 min) |
| `SINAIN_WORKSPACE` | `~/.openclaw/workspace` | Knowledge files, playbook, curation scripts |
| `SINAIN_ALLOWED_TOOLS` | *(auto)* | MCP tools auto-approved for the agent. Auto-derived from `mcp-config.json`. |
| `SINAIN_AGENT_MAX_TURNS` | `5` | Max tool-use turns for escalation responses |
| `SINAIN_SPAWN_MAX_TURNS` | `25` | Max turns for spawn tasks (Shift+Enter) |

---

## Audio Capture

| Variable | Default | Description |
|---|---|---|
| `AUDIO_CAPTURE_CMD` | `screencapturekit` | Capture backend: `screencapturekit` / `sox` / `ffmpeg` |
| `AUDIO_DEVICE` | `BlackHole 2ch` | Audio device (only for sox/ffmpeg fallback) |
| `AUDIO_SAMPLE_RATE` | `16000` | Sample rate in Hz |
| `AUDIO_CHUNK_MS` | `5000` | Audio chunk duration in ms |
| `AUDIO_VAD_ENABLED` | `true` | Voice Activity Detection |
| `AUDIO_VAD_THRESHOLD` | `0.003` | VAD sensitivity threshold |
| `AUDIO_AUTO_START` | `true` | Start capturing on launch |
| `AUDIO_GAIN_DB` | `20` | Audio gain in dB |

## Microphone (opt-in)

| Variable | Default | Description |
|---|---|---|
| `MIC_ENABLED` | `false` | Enable microphone capture |
| `MIC_DEVICE` | `default` | Microphone device |
| `MIC_CAPTURE_CMD` | `sox` | Capture backend |

---

## Transcription

| Variable | Default | Description |
|---|---|---|
| `TRANSCRIPTION_BACKEND` | `openrouter` | `openrouter` (cloud) or `local` (whisper.cpp) |
| `TRANSCRIPTION_MODEL` | `google/gemini-2.5-flash` | Cloud transcription model |
| `TRANSCRIPTION_LANGUAGE` | `en-US` | Language code |

### Local Transcription (whisper.cpp)

```env
TRANSCRIPTION_BACKEND=local
LOCAL_WHISPER_BIN=whisper-cli
LOCAL_WHISPER_MODEL=~/models/ggml-large-v3-turbo.bin
```

Install: `brew install whisper-cpp`. Models: [huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp/tree/main).

---

## Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `9500` | sinain-core HTTP + WebSocket port |

## SITUATION.md

| Variable | Default | Description |
|---|---|---|
| `SITUATION_MD_PATH` | `~/.openclaw/workspace/SITUATION.md` | Path to SITUATION.md file |
| `OPENCLAW_WORKSPACE_DIR` | `~/.openclaw/workspace` | Workspace directory |

## Tracing

| Variable | Default | Description |
|---|---|---|
| `TRACE_ENABLED` | `true` | Enable trace logging |
| `TRACE_DIR` | `~/.sinain-core/traces` | Trace output directory |
