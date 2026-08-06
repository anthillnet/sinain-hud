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

### 4. sinain.com updates itself

The download CTA points at `https://sinain.com/download` — a Cloudflare
Worker (`tools/download-redirect/`) that resolves the version *at request
time* from `RELEASE_VERSIONS.json` on main (falling back to the newest
*published* `macos-v*` release, so the link never 404s mid-build; resolution
cached 5 min). No deploy-time rendering, no site re-deploy after a DMG
release, no manual link bump. The worker also logs every hit (user-agent,
country, bot/human) to Workers Analytics Engine — unlike GitHub's raw
`download_count`, which bots and range requests inflate several-fold.

### 5. Verify live

```bash
curl -s -o /dev/null -w '%{redirect_url}\n' https://sinain.com/download  # new tag?
curl -sI https://sinain.com/download | head -1                           # HTTP 302?
```

Note: within ~5 min of the release the worker may still serve the previous
tag from cache.

## What updates itself (no site step)

- **npm launcher consumers** (`npx @geravant/sinain`): `setup-overlay.js` /
  `setup-sck-capture.js` query the GitHub Releases API for the newest release
  matching their hardcoded tag prefixes (`overlay-v*`, `sck-capture-v*`) —
  new releases are picked up automatically. Don't rename those prefixes.
- **DMG over-install**: the bundle carries a `BUILD_ID`; on launch over an
  older install it refreshes provisioned python deps automatically
  (`tools/dmg/stage-backend.sh`). User config (`.env`, `agents.json`) and
  models are never touched.

## Pre-release hygiene check

After assembling the app, scan it for credential patterns and undocumented
HTTPS destinations:

```bash
tools/dmg/check-binary-hygiene.sh build/Sinain.app
```

The command also accepts a mounted DMG directory. `assemble-app.sh` runs it as
a warning; a release operator must resolve any report before publishing. The
DMG build prints its SHA-256 checksum after notarization for release notes and
independent download verification.
