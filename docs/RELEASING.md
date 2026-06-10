# Releasing Sinain

The release is **not done until sinain.com serves the new DMG**. The landing
page pins its download link to a *specific* release tag (a `latest` link
can't be used — `releases/latest` may resolve to an overlay/npm release that
has no `Sinain.dmg` asset), so every DMG release requires a follow-up link
bump + site deploy. Follow the order below.

## Order of actions

### 1. Bump component versions — `RELEASE_VERSIONS.json` (PR to main)

Each component keeps its **own series**. Bump only what ships:

```json
{ "dmg": "0.3.0", "overlay": "2.13.0", "npm": "1.27.0", "sck-capture": "1.2.1" }
```

Components whose release tag already exists are skipped by the workflow, so
unchanged entries cost nothing.

### 2. Merge → everything builds at once

Releasing IS merging the `RELEASE_VERSIONS.json` bump to main. The merge
push triggers `.github/workflows/release.yml` ("Release All") — no tag
needed (`workflow_dispatch` is the manual fallback): a plan job reads
`RELEASE_VERSIONS.json` on main, then fans out via
`workflow_call` to the component workflows, each creating its own prefixed
release — `overlay-vX` (macOS+Windows zips), `npm-vX` (registry publish),
`sck-capture-vX` (binary), `macos-vX` (**signed + notarized DMG** — the slow
leg, Apple notarization takes a while).

The per-component triggers (`overlay-v*` etc. tag pushes) still work for
one-off releases. Do **not** create `macos-v*` tags via `gh release create`
outside this flow unless you publish the release — `push: tags` doesn't fire
for API-created tags (that's why release-app.yml triggers on
`release: published`).

### 3. Verify the DMG asset exists

```bash
gh run list --workflow=release.yml --limit 1          # conclusion: success
gh api repos/anthillnet/sinain-hud/releases/tags/macos-v<ver> --jq '.assets[].name'
# must list Sinain.dmg
```

### 4. Propagate to sinain.com — the step everyone forgets

The download CTA in `docs/index.html` is hard-pinned:

```
https://github.com/anthillnet/sinain-hud/releases/download/macos-v<ver>/Sinain.dmg
```

- PR a one-line bump of that URL to the new `macos-v<ver>`.
- **Merge only after step 3 confirms the asset** — the link 404s until the
  release is published.
- Merging to main triggers the Firebase hosting deploy
  (`firebase-hosting-merge.yml`) — no manual deploy step.

### 5. Verify live

```bash
curl -s https://sinain.com | grep -o 'releases/download/[^"]*'   # new tag?
curl -sIL <that dmg url> | head -1                                # HTTP 200?
```

## What updates itself (no site step)

- **npm launcher consumers** (`npx @geravant/sinain`): `setup-overlay.js` /
  `setup-sck-capture.js` query the GitHub Releases API for the newest release
  matching their hardcoded tag prefixes (`overlay-v*`, `sck-capture-v*`) —
  new releases are picked up automatically. Don't rename those prefixes.
- **DMG over-install**: the bundle carries a `BUILD_ID`; on launch over an
  older install it refreshes provisioned python deps automatically
  (`tools/dmg/stage-backend.sh`). User config (`.env`, `agents.json`) and
  models are never touched.
