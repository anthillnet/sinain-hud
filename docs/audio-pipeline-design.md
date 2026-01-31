# Audio Pipeline — Bridge Design

## Overview

Capture system audio + mic on Mac, transcribe via AWS+Gemini hybrid, feed through context relay, escalate to Sinain via HUD relay.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                    Mac (Bridge)                   │
│                                                   │
│  BlackHole (system audio) ──┐                    │
│  Mic (user voice) ──────────┤                    │
│                              ▼                    │
│                    ┌──────────────────┐          │
│                    │  audio-pipeline  │          │
│                    │  sox/ffmpeg      │          │
│                    │  10s PCM chunks  │          │
│                    └────────┬─────────┘          │
│                             │                     │
│                    ┌────────▼─────────┐          │
│                    │  transcription   │          │
│                    │  AWS Transcribe  │──► instant words (500ms)
│                    │  + Gemini refine │──► polished text (7-10s)
│                    └────────┬─────────┘          │
│                             │                     │
│                    ┌────────▼─────────┐          │
│                    │  context-relay   │          │
│                    │  rolling window  │          │
│                    │  filter + batch  │          │
│                    │  trigger engine  │          │
│                    └────────┬─────────┘          │
│                             │ POST /feed          │
└─────────────────────────────┼─────────────────────┘
                              ▼
                    HUD Relay (54.228.25.196:18791)
                              │
                              ▼
                    Sinain processes → pushes advice back
```

## New Bridge Files

### `src/audio-pipeline.ts`

Spawns sox/ffmpeg to capture audio, chunks into segments.

```typescript
interface AudioPipelineConfig {
  device: string;           // 'BlackHole 2ch' or 'default'
  sampleRate: number;       // 16000
  channels: number;         // 1 (mono)
  chunkDurationMs: number;  // 10000
  format: 'wav' | 'raw';   // wav for compatibility
}

interface AudioChunk {
  buffer: Buffer;
  source: 'system' | 'mic';
  ts: number;
  durationMs: number;
}

class AudioPipeline extends EventEmitter {
  // Events: 'chunk' (AudioChunk), 'error', 'started', 'stopped'
  
  start(): void
  // Spawns: sox -d -t wav -r 16000 -c 1 - (pipes to chunker)
  // Or: ffmpeg -f avfoundation -i ":BlackHole 2ch" -ar 16000 -ac 1 -f wav pipe:1
  
  stop(): void
  
  // Internal: accumulates PCM, emits 'chunk' every chunkDurationMs
  // VAD option: skip chunks below energy threshold (silence)
}
```

**Audio device selection (macOS):**
```bash
# List devices
sox -d -t wav /dev/null trim 0 0 2>&1  # shows default
ffmpeg -f avfoundation -list_devices true -i "" 2>&1  # lists all

# BlackHole captures system audio (loopback)
# Create Multi-Output Device in Audio MIDI Setup:
#   → Built-in Output + BlackHole 2ch
# Set Multi-Output as system output
# Capture from BlackHole 2ch in bridge
```

### `src/transcription.ts`

Sends audio chunks to AWS Transcribe + Gemini for hybrid transcription.

```typescript
interface TranscriptionConfig {
  awsRegion: string;              // 'eu-west-1'
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  geminiModel: string;            // 'google/gemini-2.5-flash'
  openrouterApiKey: string;
  language: string;               // 'en-US'
}

interface TranscriptSegment {
  text: string;
  speaker?: string;       // future: diarization
  confidence: number;
  ts: number;
  source: 'aws' | 'gemini' | 'whisper';
  refined: boolean;       // true if Gemini-refined
}

class TranscriptionService extends EventEmitter {
  // Events: 'interim' (fast AWS words), 'final' (Gemini-refined segment)
  
  // AWS Transcribe WebSocket streaming
  // - Opens persistent WebSocket to AWS
  // - Streams PCM chunks as they arrive
  // - Emits 'interim' on partial results (~500ms)
  
  // Gemini refinement
  // - Accumulates AWS partials into 30s windows
  // - Sends to Gemini for cleanup + formatting
  // - Emits 'final' with polished text
  
  processChunk(chunk: AudioChunk): void
  destroy(): void
}
```

### `src/context-relay.ts` (extend existing)

Add transcript handling to the existing relay.

```typescript
// New methods on ContextRelay:

onTranscript(segment: TranscriptSegment): void
// - Adds to rolling window (5 min)
// - Runs trigger evaluation if enough new content
// - Batches with min 30s interval

evaluateContext(): { shouldEscalate: boolean; priority: Priority; summary: string }
// - Uses Gemini Flash to classify:
//   "Given this conversation, should the AI advisor intervene?"
// - Returns decision + compressed context if yes

escalateToSinain(context: EscalationContext): Promise<void>
// - POST to HUD relay with transcript summary
// - Format: { text: "[CONTEXT] ...", priority: "..." }
// - Sinain sees context, decides whether to push advice to overlay
```

## Configuration

New env vars for the bridge:

```bash
# Audio
AUDIO_DEVICE="BlackHole 2ch"     # or "default" for mic
AUDIO_SAMPLE_RATE=16000
AUDIO_CHUNK_MS=10000
AUDIO_VAD_ENABLED=true           # skip silence

# AWS Transcribe
AWS_REGION=eu-west-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...

# Gemini (via OpenRouter)
OPENROUTER_API_KEY=...
GEMINI_MODEL=google/gemini-2.5-flash

# Context Relay
RELAY_URL=http://54.228.25.196:18791
RELAY_MIN_INTERVAL_MS=30000
RELAY_CONTEXT_WINDOW_MS=300000   # 5 min rolling window
```

## Hotkey Integration

| Shortcut | Action |
|---|---|
| `Cmd+Shift+T` | Toggle audio capture on/off |
| `Cmd+Shift+D` | Switch audio device (BlackHole ↔ Mic) |

Toggle sends command via WebSocket → bridge starts/stops audio pipeline.

## Message Format (Relay → Sinain)

When context relay escalates:
```json
{
  "text": "[CONTEXT] Meeting about Q1 targets. Client pushing back on pricing. Last exchange:\n• Client: 'We can't justify this budget increase'\n• User: 'Let me walk through the ROI...'",
  "priority": "high"
}
```

Sinain processes and may push advice:
```json
{
  "text": "ROI argument is weak for this buyer. Lead with cost-of-inaction instead — their competitor just launched.",
  "priority": "high"
}
```

## Local Whisper Alternative

For private/offline use, swap `TranscriptionService` backend:

```bash
brew install whisper-cpp
whisper-cpp --model medium --language en
```

Bridge config:
```bash
TRANSCRIPTION_BACKEND=whisper    # 'aws-gemini' (default) or 'whisper'
WHISPER_MODEL=medium             # base, small, medium, large-v3
WHISPER_SERVER=true              # keep model loaded (1.5GB RAM for medium)
```

whisper.cpp server mode:
```bash
# Start server (persistent, model stays in RAM)
whisper-server --model ggml-medium.bin --port 8178
# Bridge sends chunks to http://localhost:8178/inference
```

CLI mode (no persistent RAM):
```bash
# Bridge shells out per chunk
whisper-cpp -m ggml-medium.bin -f chunk.wav --output-json
```

Performance on M4 (48GB):
- medium: ~1-2s per 10s chunk, 1.5GB RAM (server) or 0 (CLI)
- small: ~0.5-1s per 10s chunk, 500MB / 0
- RAM headroom: 48GB means medium server mode is trivial (~3% of RAM)
