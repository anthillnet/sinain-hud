# Plan: Add audio streaming from Meta glasses to ISinain

## Context

ISinain currently captures **video only** from the Meta Ray-Ban glasses. The sinain-core desktop app already has a full audio pipeline (capture → VAD → transcription → agent context). We want to bring the same capability to the mobile app so the agent sees both what the user sees AND hears.

**Key discovery:** The Meta glasses expose their 5-mic array as a standard **Bluetooth HFP audio input device**. Audio is captured via iOS `AVAudioEngine` + `AVAudioSession`, NOT through the MWDAT SDK. No SDK changes needed.

**Target:** `/Users/Igor.Gerasimov/IdeaProjects/ISinain/`

---

## Architecture

Audio pipeline runs **parallel** to the existing video pipeline. They share the gateway but process independently:

```
Meta glasses (BT HFP)
  → AVAudioEngine tap (hardware rate)
  → AVAudioConverter → 16kHz mono Int16 PCM
  → 4s chunk accumulator + VAD (RMS energy)
  → WAV base64 → TranscriptionClient (OpenRouter, gemini-2.5-flash)
  → TranscriptResult
  → bridge event "onTranscript" → JS
  → observationBuilder adds "## What I Hear" section
  → gateway.sendAgentRpc() (same gateway, richer message)
```

Background path: `AudioCapture.shared.lastTranscript` → `BackgroundPipeline.tick()` → `NativeObservationBuilder`

Audio and video are merged into a **single observation message** per tick. Both run on a 4-second interval so each tick naturally pairs with a fresh transcript.

---

## Files to create/modify (in build order)

### 1. `ios/ISinain/Info.plist` — add mic permission

Add `NSMicrophoneUsageDescription` key. Without this, the app crashes when accessing the mic.

### 2. NEW `ios/ISinain/AudioCapture.swift` — native audio engine

Singleton. Uses `AVAudioEngine` with Bluetooth input selection.

- `configureAudioSession()` → `.playAndRecord` + `[.allowBluetooth, .mixWithOthers, .defaultToSpeaker]`
- `selectBluetoothInput()` → prefer `.bluetoothHFP` port type
- `AVAudioConverter` from hardware format → 16kHz mono Float32 → vDSP Int16 conversion
- Pre-allocated 128KB PCM buffer (4s × 16kHz × 2 bytes = 128,000 bytes), guarded by serial `bufferQueue`
- `flushChunk()` every 4s (aligned with video tick interval): RMS VAD check → WAV wrap (44-byte header + PCM) → base64 → delegate callback
- `AudioCaptureDelegate` protocol: `didProduceChunk(wavBase64:, rmsEnergy:, durationMs:)`, `didChangeState()`, `didError()`
- Public `lastTranscript: TranscriptResult?` for background pipeline access

### 3. NEW `ios/ISinain/TranscriptionClient.swift` — OpenRouter transcription

Port of sinain-core's `TranscriptionService`. Same API format.

- POST to `https://openrouter.ai/api/v1/chat/completions`
- Message: `[{type: "input_audio", input_audio: {data: base64, format: "wav"}}, {type: "text", text: "Transcribe..."}]`
- Model: `google/gemini-2.5-flash`, temperature: 0, max_tokens: 500
- Max 3 concurrent (serial DispatchQueue counter), 30s timeout
- Returns `TranscriptResult {text, source: "glasses-mic", confidence, timestamp, latencyMs}`
- Filters silence/empty responses

### 4. `ios/ISinain/BackgroundKeepAlive.swift` — change audio session category

Line 19: `.playback` → `.playAndRecord` with `[.allowBluetooth, .mixWithOthers, .defaultToSpeaker]`

This is a superset — the silent audio loop keeps working, but now the session also permits mic input. Idempotent with `AudioCapture.configureAudioSession()`.

### 5. `ios/ISinain/MetaWearablesBridge.m` — register new bridge methods

Add 3 `RCT_EXTERN_METHOD` declarations: `startAudio`, `stopAudio`, `getAudioState`

### 6. `ios/ISinain/MetaWearablesBridge.swift` — bridge + delegate

- Add `"onTranscript"` and `"onAudioState"` to `supportedEvents()`
- Add `transcriptionClient: TranscriptionClient?` property
- `@objc startAudio(_ config:)` — creates `TranscriptionClient`, sets self as `AudioCapture.delegate`, calls `.start()`
- `@objc stopAudio()` — stops capture, nils delegate + client
- `@objc getAudioState()` — returns current state
- `AudioCaptureDelegate` extension: on chunk → `Task { await client.transcribe() }` → emit `"onTranscript"` event; on state change → emit `"onAudioState"`

### 7. `src/types.ts` — add TS types

```typescript
export interface TranscriptData {
  text: string;
  source: string;
  confidence: number;
  timestamp: number;  // ms
  latencyMs: number;
}

export interface AudioConfig {
  openRouterApiKey: string;
  transcriptionModel?: string;
}
```

### 8. `src/pipeline/types.ts` — extend PipelineState

Add to `PipelineState`:
```typescript
recentTranscripts: TranscriptEntry[];
lastTranscriptText: string;
```

Add new type:
```typescript
export interface TranscriptEntry {
  text: string;
  timestamp: number;
  source: string;
}
```

### 9. `src/pipeline/config.ts` — add audio config

Add `audio` section to `PipelineConfig`:
```typescript
audio: {
  enabled: boolean;
  transcriptionModel: string;
  maxTranscriptAgeS: number;     // 60
  maxRecentTranscripts: number;  // 5
};
```

### 10. `src/useWearables.ts` — expose audio controls

- Add `audioState`, `lastTranscript` state
- Add `emitter.addListener('onTranscript', ...)` and `'onAudioState'` listeners
- Add `startAudio(config)`, `stopAudio()` callbacks
- Return: `audioState`, `isRecording`, `lastTranscript`, `startAudio`, `stopAudio`

### 11. `src/pipeline/observationBuilder.ts` — add "What I Hear" section

- Add `transcriptText` param to `buildObservationMessage()` and `getInstructions()`
- Insert `## What I Hear` section between "Visible Text" and "Recent Context" (after line 230)
- Add audio-aware instruction branch: "You can see AND hear what's happening" — before the fallback
- Cap transcript text at 800 chars

### 12. `src/pipeline/usePipeline.ts` — integrate transcripts

- Add `lastTranscript: TranscriptData | null` parameter
- Add `transcriptBufferRef = useRef<TranscriptEntry[]>([])`
- `useEffect` on `lastTranscript` → accumulate into buffer (cap at `maxRecentTranscripts`)
- In `processFrame()` step 7: call `getRecentTranscriptText()` helper → pass to `buildObservationMessage()`
- Init `PipelineState` with `recentTranscripts: []` and `lastTranscriptText: ''`

### 13. `ios/ISinain/NativeObservationBuilder.swift` — background audio support

- Add `transcriptText` param to `add()` and `buildMessage()`
- Add `transcriptText` field to `ObservationEntry` struct
- Insert `## What I Hear` section after "Visible Text" block (after line 86)
- Add audio-aware instruction branch in `getInstructions()` before fallback

### 14. `ios/ISinain/BackgroundPipeline.swift` — wire into background ticks

In `tick()`, after line 198 (vision result), before `builder.add()`:
- Read `AudioCapture.shared.lastTranscript`
- Check staleness (< 8s = 2 chunks)
- Pass `transcriptText` to `builder.add()` and `builder.buildMessage()`

### 15. `src/App.tsx` — UI controls

- Destructure `audioState`, `isRecording`, `lastTranscript`, `startAudio`, `stopAudio` from `useWearables()`
- Pass `lastTranscript` to `usePipeline()`
- Add audio toggle button (purple `#5856D6`) in controls section
- Add recording indicator overlay: red dot + transcript preview text (top-left of preview)
- Audio button disabled when not streaming (same pattern as capturePhoto)

---

## AVAudioSession interaction

Both `BackgroundKeepAlive` and `AudioCapture` set `.playAndRecord` — they agree and are idempotent. `.playAndRecord` is a strict superset of `.playback`. The `.allowBluetooth` option enables HFP for the glasses' 5-mic array. The `.defaultToSpeaker` option prevents routing output to earpiece (which `.playAndRecord` does by default).

**Background behavior:** `UIBackgroundModes: [audio]` is already set. `AVAudioEngine` continues capturing when backgrounded as long as the audio session is active (the silent audio loop maintains this).

---

## Observation message format (with audio)

```markdown
[sinain-wearable live context — tick #42]

## What I See
Two people at a cafe table, one with a laptop open...

### Visible Text
` ` `
WiFi: CafeGuest / brew2024
` ` `

## What I Hear
So I was thinking we could use GraphQL instead of REST...
Yeah, that makes sense, but what about the migration path?

## Recent Context
- [4s ago] [scene] Two people at a cafe, one typing...

## Instructions
**Display constraint:** Mobile phone screen. 2-4 concise sentences.
You can see what the user sees AND hear what's being said.
Prioritize the conversation context...
```

---

## Git strategy

ISinain is currently on `feat/apple-watch-companion` with uncommitted work. Before implementing:
1. Commit the current uncommitted changes on `feat/apple-watch-companion`
2. Create `feat/audio-streaming` branch from there
3. Implement all audio changes on the new branch

---

## Verification

1. **Native rebuild required** — new Swift files + Info.plist change → `npx react-native run-ios`
2. Connect Meta glasses via Bluetooth
3. Start video stream → verify video still works
4. Tap "Start Audio" → check for mic permission prompt
5. Speak near glasses → watch console for `[AudioCapture] chunk ready` + `[Transcription] "..."` logs
6. Verify observation messages include `## What I Hear` section (check gateway logs or response feed)
7. Background the app → verify `BackgroundPipeline` includes transcripts
8. Stop audio → verify clean teardown, no lingering mic indicator