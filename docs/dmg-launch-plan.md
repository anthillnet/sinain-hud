# DMG Launch Plan (SEED-001 Phase 6)

> SCAFFOLD. Sequencing + README/landing rewrite plan for flipping Sinain's
> primary install path from npm to a signed DMG. Execute only after Phases 3–5
> are green on a fresh Mac. See [`docs/dmg-distribution-spec.md`](dmg-distribution-spec.md) §7.

## Gate

Do not flip the primary CTA until:
- [ ] Signed + notarized `Sinain.dmg` passes Gatekeeper on a fresh Mac (Phase 3).
- [ ] First-run wizard completes all three tiers end-to-end (Phase 5).
- [ ] Sparkle delivers a signed update vN → vN+1 (Phase 4).
- [ ] `brew install --cask sinain` works from the tap (this phase).

## README rewrite

Current README leads with `npx @geravant/sinain`. After launch:

1. **Lead with the DMG.** Top of README:
   > **[⬇ Download Sinain.dmg](https://github.com/anthillnet/sinain-hud/releases/latest)** — drag to Applications, open, pick your privacy tier. No terminal required.
2. **Demote npm to "For developers".** Move the existing npm + `flutter`/`npm run dev`
   instructions under a `## For developers` heading. Keep them intact — the dev
   workflow is unchanged.
3. **Tier table.** Add the T0/T1/T2 table from SPEC §1 so users know what each
   tier costs in privacy / disk / speed before downloading.
4. **Homebrew line.** `brew install --cask geravant/tap/sinain` (or `sinain`
   once in homebrew/cask).

## Landing page (`docs/index.html`)

- Replace the npm-command hero with a "Download for macOS" button → latest DMG.
- Keep a small "or install via npm / Homebrew" secondary link.

## Homebrew submission

1. Iterate in `geravant/homebrew-tap` (`Casks/sinain.rb` — this repo's copy is
   the source of truth; mirror it to the tap).
2. `brew audit --new --cask` + `brew style` clean.
3. Once the DMG is stable across a few releases, PR to `homebrew/cask`.

## Launch-reflection guardrails (from MILESTONES.md v1.0)

- **Owned channels won.** DMG via GitHub Releases + landing-page CTA is an owned
  channel — aligned. Don't lean on rented channels for the launch.
- **Ship the number, not the proxy.** Only flip the CTA because the audience-
  expansion math justifies the signing/notarization cost — not just to ship a DMG.
- **One credibility piece at a time.** Per v1.0 lesson #4, this milestone must not
  open until v2.0 (memory-eval / LongMemEval-S) closes.
