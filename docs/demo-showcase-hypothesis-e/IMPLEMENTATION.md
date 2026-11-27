# Implementation handoff

## Reused Negaverse technology

Use the existing local renderer in:

`/Users/Igor.Gerasimov/IdeaProjects/negaverse/local-docs/demo-showcase`

Reuse these pieces without changing the Negaverse project:

- `animations.jsx` - `Stage`, `Sprite`, exact-time seek, playback controls, and `VideoSprite`.
- `render/host.html` - Babel/React composition boot and deterministic `window.__seek(t)` contract.
- `render/export.mjs` - Chrome/Puppeteer frame capture.
- The established post-render path: PNG sequence -> ffmpeg video encode -> narration/audio mix.

Create the Sinain composition in this repository rather than overwriting the Negaverse film. The intended target directory for the build is `demo-showcase/hypothesis-e/` with this shape:

```text
demo-showcase/hypothesis-e/
  animations.jsx              # copied from the proven Negaverse engine
  sinain-hp-e-video.jsx       # both cuts, selected by query parameter
  live/
    live-01-return-offer.mp4  # placeholder until captured
    live-02-resume-brief.mp4  # placeholder until captured
    live-03-agent-rejoins.mp4 # placeholder until captured
  narration/
    cut-20.wav
    cut-60.wav
  render/
    host.html
    export.mjs                # duration/cut parameterized
    package.json
  output/
    sinain-hp-e-20s.mp4
    sinain-hp-e-60s.mp4
```

## Composition contract

Expose a single component:

```jsx
window.SinainHPEVideo = ({ cut = '60' }) => { /* ... */ };
```

The 60-second scene functions are the source of truth. The 20-second cut reuses the same components with shorter `Sprite` windows and alternate local-time scaling. Do not maintain two independent implementations.

Suggested scene components:

```text
ParallelAgentPaths
SingularAttention
SwitchCost
LivePlaceholderOrVideo
ReturnOffer
ConsentFork
ReentryBrief
HumanAgentSharedContext
PauseOffer
EndLockup
```

`LivePlaceholderOrVideo` accepts `id`, `src`, and `label`. If the media request fails, it renders the screenplay's explicit placeholder treatment. When the MP4 is added at the named path, the same component switches to `VideoSprite`; no timeline rewrite is required.

## Export changes from the 180-second renderer

Parameterize the constants currently fixed in `render/export.mjs`:

```text
cut       20 | 60
duration  20 | 60
fps       30
start     default 0
end       default duration * fps
dsf       default 1; use 2 for 4K
```

Render a smoke set before the full sequence: first frame, every scene midpoint, every live-slot boundary, and final frame. Review those stills before spending time on all 600 or 1800 frames.

## Narration timing

Narration is the timing master. Generate or record each paragraph separately, assemble it with explicit silence matching the screenplay, then conform scene boundaries to the final WAV. Do not time-stretch voice audio to rescue animation timing.

The existing Negaverse `narration/build_narration.py` is the reference for per-scene WAV assembly. Keep music and effects on separate tracks until the last encode.

## Product fidelity rules

- Source UI copy from the running build where possible. The screenplay's re-entry brief describes intent, not permission to fake a nonexistent response.
- Use real cursor scale and one click per action.
- Label demo-mode capture internally; do not show a red/demo eye in the final footage if the current build offers a production-looking capture route.
- The overlay's invisibility is a privacy feature, but this video must intentionally capture it. Record through the project's supported demo mode, not by recreating the UI in motion graphics.
- Abstract animation may explain context assembly; only live footage should claim the feature exists.

## Review gates

1. **Animatic:** placeholders, temp narration, all timing locked.
2. **Product proof:** replace L1-L3 and confirm the real interaction still fits the promised timing.
3. **Legibility:** inspect 1080p frames at 100% scale, especially the live re-entry brief and final value statement.
4. **Audio:** dialogue at consistent loudness, effects at least 12 dB below voice, no notification-like cue before consent.
5. **Export:** verify exact 20.0 s and 60.0 s runtimes, 16:9 dimensions, first/last frames, and audio sync.
