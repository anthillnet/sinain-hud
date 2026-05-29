# Local Mode — Running sinain Fully Offline

Run sinain with zero cloud API calls. All analysis, OCR, and transcription happen on your machine via Ollama and whisper.cpp.

---

## Quick Start

```bash
brew install ollama whisper-cpp
ollama serve &
ollama pull phi4-mini qwen2.5vl:7b
./start.sh --paranoid
```

Or use the setup wizard:

```bash
npx @geravant/sinain@latest start --setup
# Select "Local / Paranoid"
```

---

## Architecture

Four concurrent workloads run on your machine:

```
Screen frames (JPEG)                      System audio (PCM)
    │                                           │
    ▼                                           ▼
sense_client                              whisper.cpp
  Ollama: qwen2.5vl:7b                     ggml-large-v3-turbo
  (vision OCR, ~2s/frame)                   (speech-to-text, real-time)
    │                                           │
    └──────────────┬────────────────────────────┘
                   ▼
             sinain-core
               Ollama: phi4-mini
               (analysis + distillation, ~800ms/tick)
                   │
                   ▼
             Overlay (HUD)
```

- **Vision OCR** — qwen2.5vl:7b reads screen content from captured frames via Ollama
- **Audio transcription** — whisper.cpp transcribes system audio locally
- **Analysis** — phi4-mini produces context digests and HUD text via Ollama
- **Distillation** — phi4-mini extracts facts for the knowledge graph (shares the model with analysis)

Ollama manages GPU memory and model loading automatically. When two models need to run concurrently (vision + analysis), Ollama handles the scheduling.

---

## Hardware Requirements

| Tier | RAM | GPU/Chip | Experience |
|------|-----|----------|------------|
| Minimum | 16 GB | Apple M1 | Works but tight — models swap frequently, 3-5s per analysis tick |
| Recommended | 24 GB | Apple M1 Pro/Max | Smooth — both models resident, ~800ms analysis, ~2s OCR |
| Comfortable | 32 GB | Apple M2 Pro+ | Fast — room for larger models (gemma4, llama3.2-vision) |
| Desktop | 48+ GB | Apple M2 Ultra / NVIDIA 24GB+ | All models resident simultaneously, sub-second everything |

### VRAM Budget

| Component | Model | VRAM |
|-----------|-------|------|
| Screen OCR | qwen2.5vl:7b | ~4.7 GB |
| Analysis + distillation | phi4-mini | ~2.5 GB |
| Audio transcription | whisper.cpp large-v3-turbo | ~1.5 GB |
| Embeddings | all-MiniLM-L6-v2 (ONNX) | ~0.1 GB |
| **Total** | | **~8.8 GB** |

On Apple Silicon, VRAM is shared with system RAM. On NVIDIA, the GPU handles Ollama models while whisper uses CPU/GPU depending on your build.

---

## Benchmarked Models

Tested on M1 Max 64GB. Results from sinain's eval harness (`npm run eval` in sinain-core/).

### Text Analysis (phi4-mini is the default)

| Model | Size | Latency | Quality Score | Notes |
|-------|------|---------|---------------|-------|
| phi4-mini | 2.5 GB | 580-828ms | 7.2/10 | Best speed/quality ratio. Recommended default |
| gemma3:4b | 2.5 GB | 650ms | 7.0/10 | Competitive alternative |
| llama3.2:3b | 2.0 GB | 520ms | 6.5/10 | Fastest, lower quality |
| gemma4:e2b | 5.2 GB | 1.1s | 7.8/10 | Best quality, needs more RAM |

### Vision OCR

| Model | Size | Latency | OCR Quality | Notes |
|-------|------|---------|-------------|-------|
| qwen2.5vl:7b | 4.7 GB | 1.8-2.5s | Excellent | Best OCR accuracy. Recommended default |
| gemma4:e2b | 5.2 GB | 2.1s | Good | Multimodal, newer |
| llava:7b | 4.7 GB | 2.0s | Good | General purpose |
| moondream | 1.7 GB | 0.8s | Fair | Use on 16GB machines |

### Dual-Model Pipeline (vision + analysis concurrently)

Running qwen2.5vl + phi4-mini together:
- Analysis latency increases ~15% vs solo (828ms → ~950ms)
- Vision latency stable at ~2.2s
- No model swapping on 24GB+ machines
- On 16GB: frequent model loading/unloading adds 2-3s overhead per swap

---

## Configuration

### Unified Config (recommended)

Set three variables and everything derives automatically:

```bash
SINAIN_LOCAL_MODE=true
SINAIN_LOCAL_LLM=phi4-mini
SINAIN_LOCAL_VISION=qwen2.5vl:7b
```

These propagate to all subsystems:
- `ANALYSIS_PROVIDER=ollama` (sinain-core analyzer)
- `ANALYSIS_MODEL=phi4-mini` (sinain-core analyzer)
- `LOCAL_VISION_ENABLED=true` + `LOCAL_VISION_MODEL=qwen2.5vl:7b` (sense_client — legacy bridge; sense_client also reads `SINAIN_LOCAL_VISION` directly)
- `TRANSCRIPTION_BACKEND=local` (whisper.cpp)
- `SINAIN_FAST_MODEL=ollama/phi4-mini` + `SINAIN_SMART_MODEL=ollama/phi4-mini` (distiller)

### Component-Level Overrides

Individual vars override the unified config when set explicitly:

| Variable | Default (from unified) | What it controls |
|----------|----------------------|------------------|
| `ANALYSIS_PROVIDER` | `ollama` | Analysis backend (`ollama` or `openrouter`) |
| `ANALYSIS_MODEL` | `phi4-mini` | LLM for HUD analysis |
| `ANALYSIS_VISION_MODEL` | `phi4-mini` | Vision model for agent (text analysis, not OCR) |
| `ANALYSIS_ENDPOINT` | `http://localhost:11434` | Ollama API URL |
| `ANALYSIS_MAX_TOKENS` | `800` | Max output tokens per analysis |
| `ANALYSIS_TEMPERATURE` | `0.3` | Temperature for analysis LLM |
| `SINAIN_LOCAL_VISION` | `qwen2.5vl:7b` | Ollama model for screen OCR (primary; legacy alias `LOCAL_VISION_MODEL`) |
| `TRANSCRIPTION_BACKEND` | `local` | `local` (whisper) or `openrouter` |
| `LOCAL_WHISPER_BIN` | `whisper-cli` | Path to whisper.cpp binary |
| `LOCAL_WHISPER_MODEL` | `~/.sinain/models/whisper/ggml-large-v3-turbo.bin` | Whisper model file |
| `SINAIN_FAST_MODEL` | `ollama/phi4-mini` | Distiller fast model |
| `SINAIN_SMART_MODEL` | `ollama/phi4-mini` | Distiller smart model |

### Privacy Mode

Local mode works with any privacy level, but `paranoid` blocks all cloud calls:

| Privacy Mode | Cloud calls | Local models | Escalation content |
|-------------|-------------|-------------|-------------------|
| `off` | Allowed | Optional | Full screen text + audio |
| `standard` | Allowed | Optional | Redacted (cards, keys stripped) |
| `strict` | Allowed | Optional | Summaries only |
| `paranoid` | **Blocked** | **Required** | Configurable (see below) |

### Escalation Privacy Overrides

In paranoid mode, escalation messages have empty screen/audio content by default. To include redacted content in escalations (e.g., to an OpenClaw gateway agent):

```bash
PRIVACY_OCR_AGENT_GATEWAY=redacted
PRIVACY_AUDIO_AGENT_GATEWAY=redacted
```

This is safe because the agent_gateway destination is a deliberate user-configured endpoint, not a leak path. The `.env.paranoid` template ships with these overrides enabled.

---

## Swapping Models

Override at startup without editing config files:

```bash
# Use gemma4 for everything (single multimodal model)
SINAIN_LOCAL_VISION=gemma4:e2b SINAIN_LOCAL_LLM=gemma4:e2b ./start.sh --paranoid

# Use moondream for vision on a low-memory machine
SINAIN_LOCAL_VISION=moondream ./start.sh --paranoid

# Mix cloud analysis with local vision
SINAIN_LOCAL_MODE=true ANALYSIS_PROVIDER=openrouter ANALYSIS_MODEL=google/gemini-2.5-flash-lite ./start.sh
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Ollama not running` at startup | Ollama server not started | `ollama serve &` |
| Model not found warnings | Model not pulled | `ollama pull <model-name>` |
| Very slow first analysis (~10-30s) | Ollama cold-loading model into GPU | Normal — subsequent ticks are fast. Warm up with `ollama run phi4-mini "hello"` |
| `whisper-cli not found` | whisper.cpp not installed | `brew install whisper-cpp` |
| Whisper model not found | Model file missing | Run `./setup-local-stt.sh`, or download from `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin` to `~/.sinain/models/whisper/` |
| sense_client POST timeout | GPU contention — vision and analysis competing | Normal with retry logic. Add RAM or use smaller models |
| sinain-core health timeout (>15s) | Startup distillation with local model is slow | `--paranoid` auto-extends timeout to 45s |
| 401 from OpenRouter | No API key in paranoid mode | Expected — paranoid mode doesn't use OpenRouter. Set `OPENROUTER_API_KEY=` (empty) |
| `no slots available` from Ollama | Both models loaded, no GPU memory for another request | Wait (Ollama queues). Or reduce model sizes |
| Analysis quality too low | Small model limitations | Try `gemma4:e2b` (better quality, needs 5.2 GB) |

---

## Running the Benchmark

```bash
cd sinain-core
npm run eval          # Full eval: 3 runs, reports to eval/reports/
npm run eval:quick    # Quick eval: 1 run, stdout only
```

The eval harness tests analysis quality with LLM-as-Judge scoring. Compare model performance by setting `ANALYSIS_MODEL` before running:

```bash
ANALYSIS_PROVIDER=ollama ANALYSIS_MODEL=phi4-mini npm run eval:quick
ANALYSIS_PROVIDER=ollama ANALYSIS_MODEL=gemma3:4b npm run eval:quick
```
