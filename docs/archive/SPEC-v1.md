# SinainHUD — Live AI Overlay for macOS

## Overview

A private, always-on-top overlay on macOS that streams live AI advice, intel, and context from Sinain. Invisible to screen sharing and recording. Receives real-time input from audio transcription and (future) screen capture.

Think: a vampire whispering in your ear — except it's text, and only you can see it.

## Core Principles

1. **Privacy-first**: Overlay MUST be invisible to screen sharing/recording (`NSWindow.sharingType = .none`)
2. **Non-intrusive**: Click-through by default, small footprint, doesn't block workflow
3. **Real-time**: Sub-second latency from Sinain's output to overlay display
4. **Bidirectional**: Sinain sees what you hear (audio) and see (screen) — you see Sinain's thoughts

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        macOS Host                            │
│                                                              │
│  ┌──────────────┐    ┌──────────────────────────────────┐   │
│  │  SinainHUD   │◄──►│        Bridge Service             │   │
│  │  (Overlay)   │ WS │        (localhost:9500)            │   │
│  │  Flutter+Swift│    │                                   │   │
│  └──────────────┘    │  ┌────────────┐ ┌──────────────┐  │   │
│                      │  │ Audio      │ │ Screen Cap   │  │   │
│                      │  │ Pipeline   │ │ Pipeline     │  │   │
│                      │  │ Mic→Whisper│ │ (future)     │  │   │
│                      │  └─────┬──────┘ └──────┬───────┘  │   │
│                      │        │               │           │   │
│                      │  ┌─────▼───────────────▼───────┐  │   │
│                      │  │     Context Relay (LLM)     │  │   │
│                      │  │  • Filter noise/silence     │  │   │
│                      │  │  • Compress & summarize     │  │   │
│                      │  │  • Decide when to escalate  │  │   │
│                      │  │  • Maintain rolling state   │  │   │
│                      │  └─────────────┬───────────────┘  │   │
│                      └────────────────┼──────────────────┘   │
│                                       │ HTTPS/WSS            │
└───────────────────────────────────────┼──────────────────────┘
                                        │
                              ┌─────────▼──────────┐
                              │   OpenClaw Gateway  │
                              │   (Sinain - Agent)  │
                              └────────────────────┘
```

### Components

#### 1. SinainHUD Overlay (Flutter + Swift)

Fork/adapt GhostLayer. Strip sticky notes, images, grid. Replace with:

**Display modes:**
- **Feed mode**: Scrolling text feed of Sinain's live output (default)
- **Alert mode**: Single prominent card for urgent intel (auto-triggered or hotkey)
- **Minimal mode**: Single-line ticker at screen edge
- **Hidden**: Fully invisible (hotkey toggle)

**UI elements:**
- Live text feed with auto-scroll and fade-out (old messages dim)
- Status bar: connection status, audio input level, current context indicator
- Compact — default position: bottom-right corner, ~300x200px
- Resizable, draggable, remembers position

**Key NSWindow properties (from GhostLayer):**
```swift
window.sharingType = .none          // Invisible to screen capture
window.level = .floating            // Always on top
window.ignoresMouseEvents = true    // Click-through by default
window.isOpaque = false             // Transparent background
window.backgroundColor = .clear
```

**Hotkeys:**
| Shortcut | Action |
|---|---|
| `Cmd+Shift+Space` | Toggle overlay visibility |
| `Cmd+Shift+C` | Toggle click-through (interact with overlay) |
| `Cmd+Shift+M` | Cycle display mode (feed → alert → minimal) |
| `Cmd+Shift+H` | Panic hide (instant) |
| `Cmd+Shift+T` | Toggle audio transcription on/off |

#### 2. Bridge Service (Node.js, runs locally)

Lightweight local server that connects the overlay to OpenClaw.

**Responsibilities:**
- WebSocket server on `localhost:9500` for overlay connection
- Manages audio capture pipeline
- Manages screen capture pipeline (future)
- Relays messages bidirectionally between overlay and OpenClaw
- Buffers and batches input to avoid flooding Sinain

**OpenClaw integration:**
- Connects to OpenClaw gateway via `sessions_send` or a dedicated streaming session
- Sends context updates (transcripts, screen descriptions) as system events
- Receives Sinain's output and forwards to overlay via WebSocket

**API (WebSocket messages):**

```jsonc
// Bridge → Overlay (display messages)
{
  "type": "feed",
  "text": "Meeting's going sideways. They're anchoring on Q3 numbers — counter with Q4 pipeline.",
  "priority": "normal",   // normal | high | urgent
  "ts": 1706000000000
}

// Bridge → Overlay (status updates)
{
  "type": "status",
  "audio": "active",       // active | muted | off
  "screen": "off",         // active | off (future)
  "connection": "connected" // connected | reconnecting | disconnected
}

// Overlay → Bridge (commands)
{
  "type": "command",
  "action": "mute_audio"   // mute_audio | unmute_audio | clear_feed | send_message
}

// Overlay → Bridge (user input — future)
{
  "type": "message",
  "text": "What's the competitor's pricing?"
}
```

#### 3. Audio Pipeline

**Flow:**
```
System Audio (BlackHole) + Mic
        │
        ▼
  Audio Capture (Core Audio / sox)
        │
        ▼
  Chunking (5-10s segments, VAD-based)
        │
        ▼
  Transcription (Whisper / OpenRouter audio LLM)
        │
        ▼
  Context Assembly (speaker diarization, rolling window)
        │
        ▼
  Bridge → OpenClaw (batched transcript updates)
```

**Audio sources:**
- **Mic input**: What the user says
- **System audio** (via BlackHole loopback): What others say (calls, meetings)
- Both captured simultaneously, tagged by source

**Transcription approach (cloud — default):**
- AWS Transcribe streaming for instant word-by-word (~500ms latency)
- Gemini refinement pass on accumulated text (higher accuracy)
- Hybrid mode: AWS gives speed, Gemini gives quality
- Rolling transcript window (last ~5 min)
- VAD (Voice Activity Detection) to avoid sending silence

**Transcription approach (local — optional):**
- whisper.cpp with CoreML/Metal acceleration
- Models: small (500MB, ~0.5-1s/chunk) or medium (1.5GB, ~1-2s/chunk)
- Run as server (persistent RAM) or CLI per chunk (no persistent cost)
- 100% on-device — no audio leaves the Mac
- Pair with Gemini refine every 30s for best quality at low cost
- Install: `brew install whisper-cpp` + download model
- Best for: sensitive meetings, offline use, zero API cost

**Context sent to Sinain:**
```jsonc
{
  "type": "transcript_update",
  "window": [
    { "speaker": "user", "text": "I think we should push the deadline", "ts": 1706000010 },
    { "speaker": "other", "text": "The client won't accept that", "ts": 1706000015 },
    { "speaker": "other", "text": "We need to deliver by March", "ts": 1706000020 }
  ],
  "summary": "Negotiating project timeline. Client pushing for March deadline."
}
```

#### 4. Context Relay (the preprocessing brain)

Sits between raw input pipelines and the Sinain agent loop. Uses a fast/cheap LLM to filter, compress, and decide what's worth escalating.

**Why this exists:**
- Raw audio transcripts are noisy — "um", "yeah", "can you hear me?" waste agent tokens
- Not every 5s of conversation needs Sinain's attention
- Screen context changes slowly — no need to re-describe identical frames
- The agent loop is expensive (Opus-level reasoning). Don't burn it on "John said hi."

**What it does:**

| Function | Description |
|---|---|
| **Noise filtering** | Drop filler, greetings, silence gaps, crosstalk |
| **Compression** | Summarize last N transcript chunks into dense context |
| **Change detection** | Only escalate when something meaningfully changed |
| **Trigger classification** | Decide: does Sinain need to see this NOW, SOON, or NEVER? |
| **State management** | Maintain rolling context window without agent involvement |
| **Priority assignment** | Tag escalations as normal / high / urgent |

**Trigger heuristics (when to escalate to Sinain):**
- Question directed at user (needs help answering)
- Negotiation/conflict detected (tone shift, disagreement)
- Factual claim that might be wrong
- Topic change to something Sinain has relevant context on
- User explicitly asks something (detected via wake word or hotkey)
- Significant time gap since last update (periodic summary push)
- Nothing happening → DON'T escalate

**Model choice:**
- Fast, cheap model: `google/gemini-2.0-flash`, `anthropic/claude-sonnet` or equivalent
- Latency target: <1s per classification decision
- Token budget: ~500 input / ~100 output per evaluation cycle

**Relay → Sinain message format:**
```jsonc
{
  "type": "hud_context",
  "trigger": "question_detected",       // why this was escalated
  "priority": "high",
  "transcript_summary": "Product demo call. Client asking about API rate limits — user hesitating.",
  "recent_exchange": [
    { "speaker": "client", "text": "What are the rate limits on the enterprise plan?" },
    { "speaker": "user", "text": "So the rate limits are... let me check..." }
  ],
  "screen_context": "Slack open, #sales channel visible",  // if available
  "rolling_context": "30-min product demo with Acme Corp. User demoing API dashboard. Client seems engaged but detail-oriented."
}
```

**What stays in the relay (never hits agent loop):**
- "Hey everyone, can you hear me?"
- "Sorry, you're on mute"
- Background noise transcription artifacts
- Screen context that hasn't changed
- Repeated/rephrased versions of the same point

**Evaluation cycle:**
- Runs every transcript chunk (5-10s) OR on screen change
- Batches rapid-fire chunks if conversation is fast
- Minimum interval between escalations: configurable (default 30s, unless urgent)

#### 5. Screen Capture Pipeline (Future)

**Flow:**
```
Screen Capture (periodic, every 5-30s)
        │
        ▼
  Change Detection (skip if <5% pixel diff)
        │
        ▼
  Vision Analysis (describe what's on screen)
        │
        ▼
  Context Assembly (what app, what content, what activity)
        │
        ▼
  Bridge → OpenClaw
```

**Context sent to Sinain:**
```jsonc
{
  "type": "screen_context",
  "app": "Google Meet",
  "description": "Video call with 4 participants. Shared screen showing quarterly revenue chart.",
  "ts": 1706000030
}
```

---

## Sinain's Behavior in HUD Mode

When receiving live context, Sinain operates differently than in chat:

### Output Style
- **Terse**: Max 1-2 sentences per feed item
- **Actionable**: Advice, not analysis. "Do X" not "One option would be..."
- **Timely**: React to what's happening NOW
- **Selective**: Don't comment on everything. Only when there's value to add.

### Trigger Conditions
Sinain should push to the overlay when:
- Detecting a negotiation/persuasion opportunity
- Spotting factual errors in conversation
- Recognizing a question the user might need help answering
- Identifying important context the user might be missing
- Upcoming calendar events / time-sensitive items

Sinain should stay SILENT when:
- Conversation is flowing fine
- Small talk / social lubrication
- User is clearly in control
- Nothing useful to add

### Priority Levels
- **normal**: Appears in feed, fades naturally
- **high**: Stays visible longer, subtle highlight
- **urgent**: Alert mode — prominent card, optional sound

---

## Implementation Phases

### Phase 1: Overlay + Bridge (MVP)
- Fork GhostLayer, strip to minimal feed display
- Build bridge service with WebSocket server
- Connect bridge to OpenClaw via session messaging
- Manual text input to Sinain via overlay (type a question, get answer in feed)
- **Deliverable**: Working overlay that shows Sinain's responses in real-time

### Phase 2: Audio Pipeline
- Integrate audio capture (BlackHole + mic)
- Chunk and transcribe via audio-transcriber skill
- Feed rolling transcript to Sinain as context
- Sinain provides live commentary based on what it hears
- **Deliverable**: Sinain listens to your meetings and whispers advice

### Phase 3: Screen Context
- Periodic screen capture with change detection
- Vision model analysis of screen content
- Combined audio + visual context for richer advice
- **Deliverable**: Sinain sees AND hears your world

### Phase 4: Windows Support
- Add C++ Win32 platform plugin (~70 lines, same 6 methods as Swift plugin)
- Key APIs: `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` for privacy, `SetWindowPos(HWND_TOPMOST)` for always-on-top, `WS_EX_TRANSPARENT` for click-through, `WS_EX_LAYERED` for transparency, `RegisterHotKey` for global hotkeys
- Add `windows/` runner alongside `macos/` runner
- Flutter UI and bridge service require zero changes (already cross-platform)
- **Deliverable**: SinainHUD runs on both macOS and Windows

### Phase 5: Polish
- Speaker diarization (who's saying what)
- Smart batching (don't flood Sinain, don't lag behind)
- Overlay themes and customization
- Quick-reply from overlay (type back to Sinain without switching apps)
- Persistent context memory (remember this meeting's thread)

---

## Technical Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Overlay framework | Flutter + Swift (GhostLayer fork) | Privacy mode already implemented, proven NSWindow.sharingType approach |
| Bridge runtime | Node.js | Matches OpenClaw ecosystem, easy audio/WS handling |
| Audio transcription | OpenRouter audio LLM | Already have skill, no local GPU needed |
| Screen capture | macOS CGWindowListCreateImage | Native, efficient, no third-party deps |
| Transport (local) | WebSocket on localhost | Low latency, bidirectional, simple |
| Transport (remote) | OpenClaw session messaging | Already authenticated, handles routing |
| Context relay model | Gemini Flash / Claude Sonnet | Fast, cheap, good enough for classification + summarization |
| Relay → Agent ratio | ~10:1 | ~10 relay evaluations per 1 agent escalation in normal conversation |

## Open Questions

1. **Flutter vs Electron for overlay?** GhostLayer proves Flutter works, but Electron might be simpler for rapid iteration and web-native rendering. Trade-off: Flutter has better NSWindow integration via Swift plugin; Electron needs native module for `sharingType = .none`.

2. **Audio chunk size?** 5s gives faster feedback but more API calls. 10s is more efficient but adds latency. VAD-based chunking is ideal but more complex.

3. **How should Sinain's HUD session relate to the main chat session?** Options:
   - Same session (HUD context mixed with regular chat) — simpler but noisy
   - Dedicated session with periodic summaries to main — cleaner but more complex
   - Hybrid: dedicated session, but user can escalate to main chat

4. **Rate limiting Sinain's output?** In a fast-moving meeting, Sinain could generate too many messages. Need a queue with priority + dedup + throttle.

5. **Local Whisper vs cloud transcription?** Local = faster + private. Cloud = higher quality + no GPU. Could offer both.

---

## File Structure (Proposed)

```
sinain-hud/
├── overlay/                    # Flutter + Swift (GhostLayer fork)
│   ├── lib/
│   │   ├── core/
│   │   │   ├── models/        # Feed items, settings
│   │   │   └── services/      # WebSocket client, window management
│   │   ├── ui/
│   │   │   ├── feed/          # Main feed display
│   │   │   ├── alert/         # Urgent alert card
│   │   │   ├── ticker/        # Minimal mode ticker
│   │   │   └── status/        # Connection/audio status bar
│   │   └── main.dart
│   └── macos/
│       └── Runner/
│           └── WindowControlPlugin.swift
├── bridge/                     # Node.js bridge service
│   ├── src/
│   │   ├── ws-server.ts       # WebSocket server for overlay
│   │   ├── openclaw-client.ts # OpenClaw session integration
│   │   ├── audio-pipeline.ts  # Audio capture + transcription
│   │   ├── screen-pipeline.ts # Screen capture + analysis (future)
│   │   ├── context-relay.ts   # Preprocessing LLM — filter, compress, escalate
│   │   ├── trigger-engine.ts  # Heuristics for when to escalate to agent
│   │   └── context-manager.ts # Rolling context window + state
│   ├── package.json
│   └── tsconfig.json
├── docs/
│   └── SPEC.md                # This file
└── README.md
```

---

## Security Considerations

- **All local traffic**: Bridge ↔ Overlay on localhost only
- **No overlay content in screen capture**: NSWindow.sharingType = .none
- **Audio never stored**: Transcribed in memory, chunks discarded after processing
- **Screen captures never stored**: Analyzed and discarded immediately
- **OpenClaw auth**: Bridge uses existing gateway token
- **Panic hide**: Instant kill of all visible overlay content
