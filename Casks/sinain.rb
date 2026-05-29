# SEED-001 Phase 6 — Homebrew Cask (SCAFFOLD / TEMPLATE).
#
# NON-FUNCTIONAL until the first signed+notarized DMG ships (Phase 3) and a
# stable download URL + sha256 exist. `version`/`sha256` are placeholders.
# See docs/dmg-distribution-spec.md §7 and docs/dmg-launch-plan.md.
#
# Distribution path: iterate in a personal tap (geravant/homebrew-tap) first,
# then submit to homebrew/cask once the DMG is stable. Sparkle owns updates
# in-app, hence `auto_updates true`.
#
# Lint before submitting:  brew audit --new --cask Casks/sinain.rb
#                          brew style Casks/sinain.rb

cask "sinain" do
  version "2.0.0"
  sha256 :no_check # TODO(Phase 6): pin real sha256 once the DMG is published

  url "https://github.com/anthillnet/sinain-hud/releases/download/app-v#{version}/Sinain.dmg"
  name "Sinain"
  desc "Privacy-first AI overlay for macOS — invisible to screen capture"
  homepage "https://github.com/anthillnet/sinain-hud"

  auto_updates true # Sparkle handles in-app updates (SPEC §5b)
  depends_on macos: ">= :ventura" # matches Info.plist minimumSystemVersion 13.0

  app "Sinain.app"

  # Knowledge graph + config + downloaded models live under ~/.sinain.
  # `zap` is opt-in (brew uninstall --zap); the wizard/uninstaller should still
  # prompt before deleting the knowledge graph — it is user-owned data (SPEC §9 Q8).
  zap trash: [
    "~/.sinain",
    "~/Library/Preferences/com.geravant.sinain.plist",
    "~/Library/Caches/com.geravant.sinain",
  ]
end
