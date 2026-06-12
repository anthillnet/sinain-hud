# Plan: macOS DMG Distribution with Tiered Local-Mode Install

> **Status:** forward-design SPEC. Authoritative artifact for SEED-001
> (`SEED-001-dmg-distribution.md`). Reconstructed 2026-05-29 from the seed's
> phase outline + the existing CLI flows it productizes. Sections 2 (pre-reqs)
> and 9 (open questions) gate any implementation work — resolve them in the
> discuss/plan phase before writing the milestone proper.

## Context

SinainHUD currently ships to developers via npm + a four-command terminal
setup (`./start.sh`, `./start-local.sh`, `./setup-local-stt.sh`,
`./start.sh --paranoid`). That locks the audience to people comfortable with
Node/Python. A signed, notarized `Sinain.dmg` with a first-run wizard opens the
door to designers, marketers, and "I'm not a Node person" Mac users — the
5–10× audience expansion the v1.0 launch reflection (`.planning/MILESTONES.md`)
flagged as missing.

The differentiator is **local mode as a one-click install**. v1.0's archived
plan (`.planning/archive/v1.0-launch/phases/11-macos-dmg-distribution/00-PLAN.md`)
covered only the cloud-mode build/sign/notarize/Sparkle pipeline. This SPEC
builds on top of it and adds the tiered local-mode install that turns "fully
offline, fully private" into a wizard step rather than a terminal session.

**Constraint:** invent no new model stack. T2 (full local) productizes the
existing `start.sh --paranoid` + `.env.paranoid` flow verbatim — two-concurrent-
Ollama-model coordination, whisper.cpp local STT, and privacy-paranoid env
overrides already work end-to-end. The DMG work is a UX layer + install wizard
+ notarization, not a new product.

---

## 1. Install Tiers

The first-run wizard selects exactly one tier. All three share the same
sinain-core + overlay binaries; they differ only in which models run where.

| Tier | Name | Analyzer | Vision (screen OCR) | Transcription | Cloud egress | Productizes |
|------|------|----------|---------------------|---------------|--------------|-------------|
| **T0** | Cloud-only (default) | OpenRouter | OpenRouter | OpenRouter | Yes (redacted by privacy mode) | `./start.sh` |
| **T1** | Cloud + local Whisper | OpenRouter | OpenRouter | whisper.cpp (local) | Audio stays local | `./start-local.sh` |
| **T2** | Full local / paranoid | Ollama `phi4-mini` | Ollama `qwen2.5vl:7b` | whisper.cpp `large-v3-turbo` | **None** | `./start.sh --paranoid` |

Tier → env mapping (the wizard writes `~/.sinain/.env`):

- **T0:** `OPENROUTER_API_KEY=…`, `PRIVACY_MODE=standard`
- **T1:** T0 + `TRANSCRIPTION_BACKEND=local`, `LOCAL_WHISPER_MODEL=~/.sinain/models/whisper/ggml-large-v3-turbo.bin`
- **T2:** `SINAIN_LOCAL_MODE=true`, `SINAIN_LOCAL_LLM=phi4-mini`, `SINAIN_LOCAL_VISION=qwen2.5vl:7b`, `PRIVACY_MODE=paranoid`, `TRANSCRIPTION_BACKEND=local`, `OPENROUTER_API_KEY=` (empty) — i.e. exactly `.env.paranoid`.

> **Daemon vs. model distinction (correction folded in):** Ollama is a *daemon*
> the wizard detects/installs/starts; `phi4-mini` and `qwen2.5vl:7b` are *models*
> the wizard pulls. whisper.cpp is a *binary* (`whisper-cli`, via Homebrew or
> bundled) plus a *model file*. The wizard must treat these three install axes
> independently — a user can have Ollama running but no models pulled, or
> whisper-cli installed but no model downloaded.

---

## 2. Pre-requisites (ship independently, before the milestone opens)

Both are entry conditions, not milestone work. They landed on a feature branch
ahead of the milestone (commit `289229d`, branch `feat/dmg-distribution-scaffold`).

### PR-1 — env-var consolidation `LOCAL_VISION_*` → `SINAIN_LOCAL_*`  ✅ done
- `sense_client` reads `SINAIN_LOCAL_VISION` / `SINAIN_LOCAL_MODE` as primary; `LOCAL_VISION_*` kept as legacy fallback.
- default vision model `llava` → `qwen2.5vl:7b`.
- `.env.example` documents the unified `SINAIN_LOCAL_*` block; docs updated.

### PR-2 — Whisper model path `~/models/` → `~/.sinain/models/whisper/`  ✅ done
- Namespaced under `~/.sinain/` so the DMG owns one predictable model root for the download manager and uninstaller. `config.ts`, `start*.sh`, `setup-local-stt.sh`, `.env.*`, docs all moved.

> These were the seed's two `/gsd-quick`-able items. With them landed, the
> bundle layout (§3) and download manager (§5) have a stable model root to
> target.

---

## 3. Bundle Layout (Phase 2)

`Sinain.app` is a self-contained `.app` — no system Node/Python required.

```
Sinain.app/Contents/
  MacOS/Sinain                     # Flutter overlay launcher (entry point)
  Resources/
    sinain-core/                   # compiled dist/ + node_modules (prod only)
    node/                          # bundled Node 22 runtime (universal)
    sense_client/                  # PyInstaller one-folder build (no system Python)
    sck-capture                    # universal (arm64 + x86_64) ScreenCaptureKit binary
    embedding-model/               # pre-warmed all-MiniLM-L6-v2 (384d) weights
    scripts/                       # launch orchestration (start.sh equivalent, app-internal)
  Frameworks/                      # Sparkle.framework, embedded dylibs
  Info.plist                       # bundle id, version, Sparkle feed URL, entitlements refs
```

**Not bundled (runtime-downloaded into `~/.sinain/models/`, see §5):**
- whisper.cpp model (`ggml-large-v3-turbo.bin`, ~1.5 GB) — T1/T2 only
- Ollama daemon + `phi4-mini` / `qwen2.5vl:7b` — T2 only, via Ollama's own installer/pull

Rationale: bundling multi-GB model weights into the DMG would make it
unshippable (>10 GB) and duplicate Ollama's own model store. Bundle the
*runtimes*, download the *weights* on tier selection. (See open question Q4.)

Phase-2 deliverables (scaffolded under `tools/dmg/`):
- `stage-bundle.sh` — assemble `Contents/Resources/` from build outputs
- `build-sck-universal.sh` — `lipo` the two-arch sck-capture into a universal binary
- `sense_client.spec` — PyInstaller spec (one-folder, hidden imports for OCR/vision deps)
- `prewarm-embedding.sh` — fetch all-MiniLM-L6-v2 into the bundle at build time

---

## 4. Code-Sign + Notarize Pipeline (Phase 3)

Apple Developer enrollment confirmed (Igor Gerasimov, individual, 2026-05-15).

GitHub Actions workflow `release-app.yml` (triggered by `app-v*` tags), on
`macos-latest`:

1. Build overlay (`flutter build macos --release`) + sinain-core (`npm ci && npm run build`) + sense_client (PyInstaller) + sck-capture (universal).
2. `stage-bundle.sh` → assemble `Sinain.app`.
3. `codesign --deep --options runtime` every binary + framework with the Developer ID Application cert (hardened runtime).
4. Build DMG (`create-dmg` or `hdiutil`).
5. `xcrun notarytool submit --wait` → `xcrun stapler staple` (auth via app-specific password).
6. Verify: `spctl --assess --type install` + `codesign --verify --deep --strict`.
7. Upload to GitHub Releases + publish Sparkle appcast (§5).

> **This is direct distribution, not the App Store.** The DMG is downloaded from
> GitHub Releases / the landing page and dragged to Applications — no App Store
> listing, no App Review. The Developer ID cert + notarization are still required:
> they're what lets Gatekeeper open a downloaded app without the "unidentified
> developer" block. They are *not* App-Store-only.

**Required GH Secrets** (placeholders documented in the workflow; pipeline is
non-functional until provisioned):

| Secret | Purpose | Where to get it |
|--------|---------|-----------------|
| `APPLE_CERT_P12_BASE64` | Developer ID Application cert (.p12, base64) | developer.apple.com → Certificates → Developer ID Application (G2 Sub-CA) |
| `APPLE_CERT_PASSWORD` | .p12 password | set during Keychain export |
| `APPLE_TEAM_ID` | Apple Developer Team ID | developer.apple.com → Membership |
| `APPLE_ID` | Apple ID email for notarytool | your Apple ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password (`xxxx-xxxx-xxxx-xxxx`) | account.apple.com → Sign-In and Security → App-Specific Passwords |
| `SPARKLE_ED_PRIVATE_KEY` | EdDSA key for signing appcast updates (§5) | Sparkle `bin/generate_keys` |

> **Notarization auth:** uses the **app-specific password** method, not an App
> Store Connect API key. The API-key "Team Keys" tab is gated behind the
> Admin/Account Holder role and is unnecessary for a single-maintainer direct-
> distribution setup. `notarytool` accepts `--apple-id / --password / --team-id`.

Exit criterion: a signed DMG passes Gatekeeper on a *fresh* Mac (no dev tools,
quarantine bit set) — open question Q1 covers how we test this without a clean
machine on hand.

---

## 5. Download Manager + Sparkle (Phase 4)

### 5a. Model download manager
`sinain-core/src/distribution/download-manager.ts` — resumable, integrity-
checked, atomic install of model weights into `~/.sinain/models/`.

- **Resumable:** HTTP `Range` requests; persists `.part` + byte offset.
- **Integrity:** SHA-256 verified against a hosted manifest before promotion.
- **Atomic:** download to `*.part` → verify → `rename()` into final path (never a half-written model at the canonical path).
- **Manifest:** `models-manifest.json` hosted on GitHub Pages — `{ id, url, sha256, sizeBytes, tier }[]`.

The wizard (§6) drives this for the whisper model (T1/T2). Ollama models are
pulled via Ollama's own API (`/api/pull`), not this manager.

### 5b. Sparkle auto-update
- `Sparkle.framework` embedded in the bundle; `Info.plist` `SUFeedURL` → appcast on GitHub Pages.
- `appcast.xml` lists each release with an EdDSA signature (`SPARKLE_ED_PRIVATE_KEY`) — Sparkle refuses unsigned/tampered updates.
- In-app "Check for Updates" + automatic background check; update is itself a signed+notarized DMG.

---

## 6. First-Run Wizard + Tier Selection (Phase 5)

Overlay (Flutter) presents the wizard on first launch (no `~/.sinain/.env` yet).
Productizes `setup-local-stt.sh` / `start.sh --paranoid` interactively.

Steps:
1. **Welcome + privacy pitch** (the invisible-to-capture overlay is the hook).
2. **macOS permissions** — Screen Recording + Accessibility (deep-link to System Settings panes; poll for grant).
3. **Tier picker** — T0 / T1 / T2 with plain-language tradeoffs (cost, privacy, speed, disk).
4. **Tier-specific config:**
   - T0: OpenRouter API key field (+ "get one free" link).
   - T1: T0 key + whisper model download (drives §5a, progress bar).
   - T2: Ollama detection → install handoff if missing (link to ollama.com or `brew install ollama`) → start daemon → model picker (`phi4-mini` + `qwen2.5vl:7b` defaults, with the smaller alternatives from `docs/local-mode.md`) → pull via `/api/pull` with progress → whisper model download.
5. **Smoke test** — start sinain-core, hit `/health`, confirm green; for T2 also confirm Ollama tags + whisper-cli reachable (mirrors `start.sh --paranoid` preflight).
6. **Write `~/.sinain/.env`** from the tier mapping in §1, launch the overlay proper.

Wizard must be re-runnable (Settings → "Re-run setup") and tier-switchable
without reinstall.

---

## 7. Homebrew Cask + Launch (Phase 6)

- `Casks/sinain.rb` — Cask pointing at the GitHub Releases DMG, with `sha256`, `auto_updates true` (Sparkle owns updates), `app "Sinain.app"`, and a `zap` stanza removing `~/.sinain/`.
- Submit to `homebrew/cask` (or a `geravant/tap` first while iterating).
- README rewrite: DMG download as the primary CTA, npm demoted to a "For developers" section.
- Landing-page CTA flip (`docs/index.html`) from npm command to DMG download button.

---

## 8. Indicative Phase Sequence

| Phase | Title | Gated on | Externally blocked? |
|-------|-------|----------|---------------------|
| 1 | Pre-req cleanup (PR-1 + PR-2) | — | No — **done** |
| 2 | Bundle staging | PR-1/PR-2 | No |
| 3 | Sign + notarize | Phase 2 + GH Secrets | **Yes** — Apple cert/notary secrets |
| 4 | Download manager + Sparkle | Phase 2 + EdDSA key + Pages hosting | Partly — code is unblocked; appcast hosting needs Pages |
| 5 | First-run wizard | Phase 2 (+4 for downloads) | No |
| 6 | Homebrew + launch | Phases 3–5 green on a fresh Mac | **Yes** — fresh-Mac verification |

---

## 9. Open Questions (resolve in discuss/plan before implementing)

1. **Fresh-Mac verification.** How do we test Gatekeeper/quarantine on a clean
   machine without one on hand — a throwaway VM, a CI macOS runner with the
   quarantine bit set manually, or a borrowed device?
2. **Node bundling strategy.** Bundle a full Node runtime (~50 MB, simplest) vs.
   compile sinain-core to a single binary (`bun build --compile` / `pkg`)?
   Affects bundle size, sign surface, and build complexity.
3. **Python bundling.** PyInstaller one-folder vs. one-file vs. shipping
   sense_client as an optional download. OCR/vision deps (Pillow, etc.) are heavy.
4. **Bundle-vs-download cutline for models.** Confirmed: download weights, bundle
   runtimes. But do we offer an "offline installer" variant that *does* bundle the
   whisper model for air-gapped T1/T2 users?
5. **Ollama handoff vs. embed.** Do we ever bundle/manage Ollama ourselves, or
   always hand off to the user's Ollama install? (Current lean: always hand off —
   Ollama has its own updater and model store.)
6. **Universal vs. Apple-Silicon-only.** Ship universal (arm64 + x86_64) or
   arm64-only? Intel Mac share vs. bundle-size/build-time cost.
7. **Sparkle channel strategy.** Single stable channel, or stable + beta appcasts?
8. **Uninstall / `zap` completeness.** What exactly does uninstall remove —
   `~/.sinain/` (config + models + memory graph)? Prompt before deleting the
   knowledge graph, which is user-owned data.

---

## 10. Verification Checklist

- [ ] `Sinain.dmg` opens, drags to /Applications, launches with no Gatekeeper prompt on a fresh Mac.
- [ ] First-run wizard completes all three tiers end-to-end; `~/.sinain/.env` matches the §1 mapping.
- [ ] T2 wizard detects missing Ollama and recovers; pulls both models with progress; whisper model downloads + verifies SHA-256.
- [ ] `/health` green for each tier; T2 makes zero cloud requests (verify with a network monitor).
- [ ] Sparkle delivers a signed update from vN to vN+1; refuses a tampered appcast.
- [ ] `brew install --cask sinain` installs; `brew uninstall --cask sinain` + `zap` cleans up (prompting before knowledge-graph deletion).
- [ ] README + landing page lead with the DMG; npm path still documented for developers.

---

## Breadcrumbs

- Seed: `SEED-001-dmg-distribution.md`
- v1.0 archived plan (cloud pipeline): `.planning/archive/v1.0-launch/phases/11-macos-dmg-distribution/00-PLAN.md`
- CLI flows productized: `start.sh` (+ `--paranoid`), `start-local.sh`, `setup-local-stt.sh`, `.env.paranoid`
- Local-mode reference: `docs/local-mode.md`, `docs/INSTALL-LOCAL.md`
- Format sibling: `docs/nemoclaw-setup-spec.md`
- Scaffolds for this SPEC: `tools/dmg/`, `.github/workflows/release-app.yml`, `sinain-core/src/distribution/`, `overlay/lib/ui/first_run/`, `Casks/sinain.rb`, `docs/dmg-launch-plan.md`
