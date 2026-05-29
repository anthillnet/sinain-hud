---
id: SEED-001
status: dormant
planted: 2026-05-27
planted_during: v2.0 phase 01 (memory-eval, paper-protocol-baseline)
trigger_when: when a distribution / packaging / non-developer-install milestone opens (v2.X distribution, "ship a DMG", "ship to Mac App audience", or any milestone with packaging/DMG/installer scope)
scope: large
spec_reference: docs/dmg-distribution-spec.md
---

# SEED-001: macOS DMG Distribution with Tiered Local-Mode Install

A signed/notarized `Sinain.dmg` for non-developer Mac users, with a first-run wizard that selects from three tiers: T0 cloud-only (default), T1 cloud + local Whisper, T2 full local (Ollama-served `phi4-mini` analyzer + `qwen2.5vl:7b` vision + whisper.cpp `large-v3-turbo`). Designed to productize the existing CLI-only `start-local.sh` and `start.sh --paranoid` flows without inventing any new model stack.

A full forward-design SPEC already exists at **`docs/dmg-distribution-spec.md`** — that is the authoritative artifact. This seed exists only to re-surface it when the right milestone opens.

## Why This Matters

1. **Audience expansion (5–10×).** The current npm + manual setup path locks Sinain to developers comfortable with Node/Python. A signed DMG addresses designers, marketers, AI-curious non-developers, and "I'm not a Node person" Mac users — the audience the v1.0 launch reflection (`.planning/MILESTONES.md`) flagged as missing.
2. **Already partially demand-tested.** Phase 11 of v1.0 was activated, plan-written, and explicitly deferred to "next milestone" pending PH traction. Archived PLAN at `.planning/archive/v1.0-launch/phases/11-macos-dmg-distribution/00-PLAN.md` covers the cloud-mode build/sign/notarize/Sparkle pipeline.
3. **Local-mode is the differentiator.** v1.0's archived PLAN did NOT cover Ollama / full-local install. The new SPEC fills that gap and turns "fully offline, fully private" into a one-click install rather than a four-command terminal session. That's the credibility-flywheel asset MILESTONES.md identifies as missing.
4. **Existing CLI flow is the contract.** T2 productizes `start.sh --paranoid` + `.env.paranoid`. The hard parts (two-concurrent-Ollama-model coordination, whisper.cpp local STT, privacy-paranoid env overrides) already work end-to-end. The DMG phase is mostly a UX layer + install wizard + notarization, not a new product.

## When to Surface

**Trigger:** when any of the following come into a milestone's scope:
- Public DMG download as a CTA (landing page, README primary install path)
- Homebrew Cask distribution
- Non-developer audience expansion (designers, marketers, "post-npm" Mac users)
- Apple Developer Program + code-signing infrastructure decisions
- Sparkle auto-update or any signed-update mechanism
- Bundle-vs-runtime-download strategy for model weights
- First-run wizard / onboarding flow for the macOS overlay
- Productizing local-mode (Ollama + whisper.cpp) into a single-install package

This seed should also surface if Sinain's launch positioning shifts from "developer tool" to "consumer-grade Mac productivity app" — that's a strategic trigger even without explicit DMG scope.

**Soft trigger (consider before opening v2.X):** when v1.x credibility-flywheel work (per `MILESTONES.md` v1.0 closeout lessons) moves to "ship the substrate" stage — DMG is one of the substrate pieces identified there.

## Scope Estimate

**Large — full milestone (v2.X distribution, ~6 phases).**

Indicative phase shape derived from the SPEC:
1. **Phase 1: Pre-requisite cleanup** — PR-1 (env-var consolidation: `LOCAL_VISION_*` → `SINAIN_LOCAL_*`) + PR-2 (Whisper model path: `~/models/` → `~/.sinain/models/whisper/`). Small, can ship before the milestone even formally opens.
2. **Phase 2: Bundle staging** — Node + Python runtimes, sense_client PyInstaller, sck-capture universal binary, embedding model pre-warming, bundle layout finalized.
3. **Phase 3: Code-sign + notarize pipeline** — Apple Developer cert in GH Secrets, `release-app.yml` workflow, first signed DMG on a test tag, Gatekeeper verification on a fresh Mac.
4. **Phase 4: Download Manager + Sparkle** — `sinain-core/src/distribution/download-manager.ts` (resumable, integrity-checked, atomic install), manifest hosting on GitHub Pages, Sparkle EdDSA appcast, in-app update flow verified.
5. **Phase 5: First-Run Wizard + tier selection** — Overlay UI for permission steps + tier picker + Ollama detection/handoff + model picker + smoke test. Productize `start-local.sh` / `start.sh --paranoid` flows.
6. **Phase 6: Homebrew Cask + launch** — Cask submission, README rewrite (DMG primary, npm demoted to "for developers"), landing-page CTA flip.

Two pre-reqs (PR-1 + PR-2 from the SPEC) can be promoted to standalone `/gsd-quick` work-items on `main` *before* this milestone opens — they're entry conditions, not part of the milestone proper.

## Breadcrumbs

**Authoritative artifacts:**
- `docs/dmg-distribution-spec.md` — full SPEC (this seed's primary reference; read this first when surfacing)
- `.planning/archive/v1.0-launch/phases/11-macos-dmg-distribution/00-PLAN.md` — archived v1.0 plan covering cloud-mode pipeline (sign / notarize / Sparkle / Cask). Still valid; SPEC builds on top of it.
- `.planning/MILESTONES.md` v1.0 row 11: "macOS DMG Distribution — Activated but DEFERRED to next milestone"

**Existing CLI flows that DMG must productize:**
- `start-local.sh` — current T1 entry point (local Whisper, cloud LLM); requires `whisper-cli` via `brew install whisper-cpp`
- `start.sh --paranoid` — current T2 entry point; sources `.env.paranoid`
- `.env.paranoid` — canonical T2 config: `SINAIN_LOCAL_MODE=true`, `SINAIN_LOCAL_LLM=phi4-mini`, `SINAIN_LOCAL_VISION=qwen2.5vl:7b`, `LOCAL_WHISPER_MODEL=~/models/ggml-large-v3-turbo.bin`
- `setup-local-stt.sh` — referenced by `start-local.sh` for prerequisite install

**Code that needs to change for the pre-requisites:**
- `sense_client/config.py` — default model still `"llava"` (legacy; should be `qwen2.5vl:7b`)
- `sense_client/ollama_vision.py` — default parameter + docstring still `"llava"`
- `.env` — legacy `LOCAL_VISION_ENABLED` / `LOCAL_VISION_MODEL=llava`
- `.env.example` — needs new `SINAIN_LOCAL_*` namespace as primary
- `docs/INSTALL-LOCAL.md` — still recommends `LOCAL_VISION_*` legacy vars

**Related design docs:**
- `docs/local-mode.md` — current local-mode architecture, hardware tiers, benchmarked models
- `docs/INSTALL-LOCAL.md` — current install instructions (will be largely replaced by DMG wizard)
- `docs/nemoclaw-setup-spec.md` — sibling setup-spec; mirrored its format for `dmg-distribution-spec.md`
- `docs/CONFIGURATION.md` — env-var reference (will need updates after PR-1)

**Repository context:**
- Apple Developer enrollment confirmed (Igor Gerasimov individual, 2026-05-15) — prerequisite already cleared
- `tools/sck-capture/` — Swift ScreenCaptureKit binary, needs universal-binary build script for DMG
- `overlay/macos/Runner/` — Flutter+Swift overlay; needs `Info.plist` bundle-ID + Sparkle wiring + entitlements update

## Progress (2026-05-29)

Surfaced and scaffolded on branch `feat/dmg-distribution-scaffold`. The full
milestone remains **gated** (do not open until v2.0 closes — see Notes below);
this branch only lands the unblocked pieces:

- ✅ **PR-1 + PR-2 fully implemented** (commit `289229d`). Env vars consolidated
  to `SINAIN_LOCAL_*`, `llava`→`qwen2.5vl:7b` defaults, whisper path moved to
  `~/.sinain/models/whisper/`. Type-checks + `flutter analyze` clean.
- ✅ **Missing SPEC reconstructed** at `docs/dmg-distribution-spec.md` (the seed's
  authoritative reference did not exist in the repo — now it does, with the 3
  tiers, bundle layout, sign/notarize pipeline, download manager, wizard,
  Homebrew, **8 open questions**, and verification checklist).
- 🟡 **Phases 2–6 scaffolded as honest stubs** (clearly marked, non-functional
  until external creds / fresh-Mac verification):
  - Phase 2: `tools/dmg/` (stage-bundle, build-sck-universal, prewarm-embedding, PyInstaller spec)
  - Phase 3: `.github/workflows/release-app.yml` (secret-gated; no-ops without Apple/Sparkle secrets)
  - Phase 4: `sinain-core/src/distribution/download-manager.ts` (working resumable/integrity/atomic core; manifest fetch + wiring TODO) + `docs/distribution/{models-manifest.example.json,appcast.xml}`
  - Phase 5: `overlay/lib/ui/first_run/` (tier model + tier-picker visual stub + design README)
  - Phase 6: `Casks/sinain.rb` + `docs/dmg-launch-plan.md`

**Still blocked on (cannot be done autonomously):** Apple Developer cert +
notarytool key + Sparkle EdDSA key in GH Secrets; GitHub Pages hosting for
appcast/manifest; verification on a fresh/clean Mac. The 8 open questions in
SPEC §9 must be resolved in the discuss/plan phase before executing 2–6.

## Notes

- The current SPEC has **8 open questions** (Section 9) and **2 pre-requisites** (Section 2) that the discuss/plan phase should address before any implementation work.
- Two pre-requisites (PR-1, PR-2) are explicitly designed to ship as quick-phase PRs on `main` independently of this milestone opening. If a window opens during v2.0 to ship them, do so — it'll de-risk the eventual v2.X distribution work.
- The SPEC was written 2026-05-27 during a conversation with the user; it iterated through three correction rounds (cloud-vs-tiered, daemon-vs-model distinction, llava→qwen2.5vl:7b model correction). All corrections are folded into the final SPEC. If anything in the SPEC seems off when this surfaces, check the git history of `docs/dmg-distribution-spec.md` for context.
- v1.0 launch reflection lessons that bear on this milestone:
  - "Owned channels won; rented channels failed." DMG distribution is an owned channel (GitHub Releases + landing-page CTA) — aligns.
  - "Headline metric needs to be the underlying number, not its proxy." Don't ship a DMG just to ship — ship it because the audience-expansion math justifies the cost.
- **Do not** open this milestone until v2.0 (memory-eval, 80% LongMemEval-S) closes — the v2.0 milestone's whole point is to land *one* credibility piece (the benchmark number) before another launch surface. Stacking distribution work on top of in-flight memory work was explicitly rejected per `MILESTONES.md` v1.0 lesson #4.
