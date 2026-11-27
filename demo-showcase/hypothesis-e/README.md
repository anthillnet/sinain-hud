# Sinain HP-E demo animatic

End-to-end, graphic-first placeholder demo for HP-E: protecting the human's attention while several agents work in parallel. The visual grammar is social-video-like: one idea per shot, oversized type and objects, full-frame color accents, and minimal interface detail.

## Interactive preview

```bash
cd demo-showcase/hypothesis-e/render
npm run preview
```

Open `http://localhost:4173/render/host.html?cut=60` or change `cut=20`. The proven Negaverse timeline provides play, pause, scrub, arrow-key seeking, and reset.

## Render MP4s

```bash
cd demo-showcase/hypothesis-e/render
npm run render
```

The exporter renders both cuts at 1280 x 720 and 24 fps by default. Outputs land in `output/`. Pass fps and width directly for review or final export, for example `node export.mjs 60 30 1920`.

The three dark desktop sections are deliberately labeled placeholders. Replace them later with the screenplay's named live MP4s without changing the scene timings.
