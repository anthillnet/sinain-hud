# tools/dmg — macOS DMG distribution build tooling

**Status: SCAFFOLD.** These scripts are stubs for SEED-001 Phase 2 (bundle
staging). They document the intended build steps and exit with a clear
"not implemented" message until the milestone is executed. See
[`docs/dmg-distribution-spec.md`](../../docs/dmg-distribution-spec.md) §3.

## Target bundle layout

```
Sinain.app/Contents/
  MacOS/Sinain                     # Flutter overlay launcher (entry point)
  Resources/
    sinain-core/                   # compiled dist/ + prod node_modules
    node/                          # bundled Node 22 runtime (universal)
    sense_client/                  # PyInstaller one-folder build
    sck-capture                    # universal (arm64 + x86_64) binary
    embedding-model/               # pre-warmed all-MiniLM-L6-v2 weights
    scripts/                       # app-internal launch orchestration
  Frameworks/                      # Sparkle.framework + embedded dylibs
  Info.plist                       # bundle id, version, SUFeedURL, entitlements
```

Model weights (whisper, Ollama models) are NOT bundled — they download into
`~/.sinain/models/` at first run via the download manager
(`sinain-core/src/distribution/download-manager.ts`).

## Scripts

| Script | Purpose | Status |
|--------|---------|--------|
| `build-sck-universal.sh` | `lipo` arm64 + x86_64 sck-capture into one universal binary | stub |
| `sense_client.spec` | PyInstaller spec for sense_client one-folder build | stub |
| `prewarm-embedding.sh` | Fetch all-MiniLM-L6-v2 into the bundle at build time | stub |
| `stage-bundle.sh` | Assemble `Contents/Resources/` from all build outputs | stub |

## Open questions (see SPEC §9)

- Q2: bundle full Node runtime vs. compile sinain-core to a single binary?
- Q3: PyInstaller one-folder vs. one-file vs. optional download for sense_client?
- Q6: universal vs. Apple-Silicon-only?
