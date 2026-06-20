# first_run — tiered install wizard (SEED-001 Phase 5)

This is the **DMG first-run wizard** for non-developer installs. It is distinct
from `lib/ui/onboarding/` (which orients an already-configured user). This flow
runs once, on first launch with no `~/.sinain/.env`, and productizes the
`setup-local-stt.sh` / `start.sh --paranoid` terminal flows into a GUI.

The graphic redesign recreates the Claude Design handoff
(`.planning/ai-powered-screen-context-overlay 4/project/Setup Wizard.dc.html`):
a 340×420 dark card sharing the post-install feature tour's card language
(Ring UI green `0xFF1F8039` on `0xFF1E1F22`, the eye glyph, progress dots) via
`wizard_theme.dart`.

See [`docs/dmg-distribution-spec.md`](../../../../docs/dmg-distribution-spec.md) §6.

## Status

| File | What it is | Status |
|------|------------|--------|
| `wizard_theme.dart` | Shared palette + eye glyph, button, progress dots, card chrome | done |
| `install_tier.dart` | `InstallTier` enum + display metadata for T0/T1/T2 | done (data model) |
| `tier_selection_view.dart` | Cloud / Hybrid / Private tier cards (green-selected + check) | done |
| `first_run_wizard.dart` | Full wizard: welcome → tier → config → permission → finishing | done |
| `provisioning_banner.dart` | 360×230 "Setting up Sinain" progress card | done |

## Wizard steps (built)

1. **Welcome** — eye glyph + concentric rings + privacy pitch.
2. **Tier picker** — `TierSelectionView` (Cloud / Hybrid / Private).
3. **Config** — OpenRouter key field (Cloud / Hybrid) or local-mode note (Private).
4. **Screen Recording permission** — pre-warn → waiting → granted. The pre-warn
   triggers the macOS prompt via `WindowService.requestScreenRecording`
   (`CGRequestScreenCaptureAccess`); the waiting state deep-links to System
   Settings and polls `screenRecordingStatus` (`CGPreflightScreenCaptureAccess`).
   A `FirstRunService` checkpoint (tier + key) lets the flow resume here if macOS
   relaunches Sinain to apply the grant.
5. **Finishing** — `completeSetup` writes `~/.sinain/.env` from the tier mapping
   (SPEC §1) and relaunches the backend.

For local tiers, model download progress shows after relaunch via
`provisioning_banner.dart`, fed by `ProvisioningService`
(`~/.sinain/provisioning/*.status`).

## Future work (not yet built)

- T2 Ollama detect → install handoff → start daemon → model picker
  (`phi4-mini` + `qwen2.5vl:7b`) → pull via `/api/pull` with live progress —
  currently the Private tier shows the manual `ollama pull` command instead.
5. Smoke test — start core, poll `/health`; for T2 confirm Ollama tags +
   whisper-cli (mirrors `start.sh --paranoid` preflight).
6. Write `~/.sinain/.env` from the tier mapping (SPEC §1), launch overlay.

## Wiring (done) / TODO

- `FirstRunService` (ChangeNotifier) holds env state + the permission checkpoint;
  `main.dart` gates the wizard on "no `~/.sinain/.env` yet". ✓
- TODO: a Settings entry "Re-run setup" so tiers can be switched without reinstall.
- TODO: bind local-mode model-download progress to the download manager's
  `DownloadProgress` stream over the WebSocket bridge (today the banner polls
  `~/.sinain/provisioning/*.status` files directly).
