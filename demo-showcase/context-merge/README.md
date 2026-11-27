# Sinain session-continuity demo

A 24-second product animatic based on the Sessions sidebar user stories. Sinain
recognizes the user’s working session, maintains its goal/done/next context,
briefs attached AIs in the background, and reorients the user after time away.

## Story beats

1. “Looks like you’re working on…” turns ambient activity into a named session.
2. The session follows the task across apps instead of following one window.
3. Claude Code, Codex, and Cursor receive goal/done/next through hooks.
4. The user walks away while agent lanes keep working.
5. On return, Sinain raises what changed and the next step.

## Preview

```bash
cd demo-showcase/context-merge/render
npm run preview
```

Open `http://localhost:4174/render/host.html`. The timeline supports playback,
scrubbing, arrow-key seeking, and reset.

## Export

```bash
cd demo-showcase/context-merge/render
npm run render
```

The default export is 1280 × 720 at 24 fps. Optional arguments set fps and
width: `node export.mjs 30 1920`.

## Narration and delivery files

`narrate.py` uses the local `kokoro-onnx` runtime and a Kokoro model directory
containing `kokoro-v1.0.onnx` and `voices-v1.0.bin`:

```bash
cd demo-showcase/context-merge/render
KOKORO_MODEL_DIR=/path/to/kokoro-models python3 narrate.py
```

The current delivery files are:

- `output/sinain-context-merge-24s.gif` — 960 × 540, 12 fps, looping GIF.
- `output/sinain-context-merge-24s-1080p-narrated.mp4` — 1920 × 1080,
  24 fps, scene-timed Kokoro narration.
- `output/sinain-context-merge-24s-1080p-silent.mp4` — silent 1080p master.
- `output/sinain-context-merge-narration.wav` — 24-second narration stem.

The timed script is documented in `NARRATION.md`.
