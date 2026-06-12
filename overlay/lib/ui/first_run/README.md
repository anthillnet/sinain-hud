# first_run — tiered install wizard (SEED-001 Phase 5 SCAFFOLD)

This is the **DMG first-run wizard** for non-developer installs. It is distinct
from `lib/ui/onboarding/` (which orients an already-configured user). This flow
runs once, on first launch with no `~/.sinain/.env`, and productizes the
`setup-local-stt.sh` / `start.sh --paranoid` terminal flows into a GUI.

See [`docs/dmg-distribution-spec.md`](../../../../docs/dmg-distribution-spec.md) §6.

## Status

| File | What it is | Status |
|------|------------|--------|
| `install_tier.dart` | `InstallTier` enum + display metadata for T0/T1/T2 | done (data model) |
| `tier_selection_view.dart` | Tier-picker step widget | visual stub (reports selection; no downstream) |

## Intended wizard steps (NOT YET BUILT)

1. Welcome + privacy pitch.
2. macOS permissions (Screen Recording + Accessibility) — deep-link to System
   Settings, poll for grant. (Can reuse `core/services/onboarding_service.dart`
   permission checks.)
3. **Tier picker** — `TierSelectionView` (this scaffold).
4. Tier-specific config:
   - T0: OpenRouter API key field.
   - T1: key + whisper model download (drives
     `sinain-core/src/distribution/download-manager.ts` via core).
   - T2: Ollama detect → install handoff → start daemon → model picker
     (`phi4-mini` + `qwen2.5vl:7b`) → pull via `/api/pull` with progress →
     whisper model download.
5. Smoke test — start core, poll `/health`; for T2 confirm Ollama tags +
   whisper-cli (mirrors `start.sh --paranoid` preflight).
6. Write `~/.sinain/.env` from the tier mapping (SPEC §1), launch overlay.

## Wiring TODO

- Add a `FirstRunService` (ChangeNotifier) holding wizard state + tier choice.
- Gate it in `main.dart` on "no `~/.sinain/.env` yet".
- Add a Settings entry "Re-run setup" so tiers can be switched without reinstall.
- The model-download progress UI binds to the download manager's
  `DownloadProgress` stream, surfaced over the existing WebSocket bridge.
