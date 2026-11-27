# SinainHUD — macOS Install & Setup-Wizard Design Brief

**Audience:** product designer
**Purpose:** describe, end-to-end, what a brand-new macOS user goes through from downloading the DMG to a running HUD — including **every macOS permission dialog the OS will raise, when, and why** — so the install/setup experience (and especially the permission-granting moments) can be designed properly.

**Status of today's build:** the setup *wizard* exists (4 screens) but it covers **config only**. There is **no in-app permission UX** in the packaged flow today — the macOS Screen-Recording prompt fires "raw" after setup, with no coaching screen. Designing that permission moment is the main opportunity here. (The recently-shipped onboarding *feature tour* is a separate, later step — see §6 — and deliberately assumes permissions are already handled "in the install guide," i.e. here.)

---

## 1. The end-to-end journey (one pass)

| # | Moment | What the user sees / does | Designed today? |
|---|--------|----------------------------|-----------------|
| 1 | **Download** | Gets `Sinain.dmg` from sinain.com / GitHub Releases (signed + notarized) | n/a |
| 2 | **Mount** | Double-clicks the DMG → a Finder window opens, volume named **"Sinain"** | ❌ plain `hdiutil` window, no styling |
| 3 | **Drag-install** | Drags `Sinain.app` onto the **Applications** shortcut | ❌ no background art / layout |
| 4 | **First open** | Launches `/Applications/Sinain.app`. Because it's notarized, **no Gatekeeper warning** | ✅ transparent (no "unidentified developer") |
| 5 | **Setup wizard** | 4-screen panel: Welcome → Choose tier → Config (API key / local note) → Finishing | ✅ exists (functional, minimal) |
| 6 | **Config write + relaunch** | Wizard writes `~/.sinain/.env`, app relaunches itself | ✅ (invisible to user) |
| 7 | **Backend boot + provisioning** | Bundled backend starts; for local tiers a **"Setting up Sinain"** progress banner shows model downloads | ✅ exists (banner) |
| 8 | **🔐 macOS permission prompts** | **Screen Recording** dialog fires when capture starts (see §4). **No in-app coaching today.** | ❌ **needs design** |
| 9 | **Feature tour** | 11-scene product walkthrough (the eye, regions, chat/agents, memory, share, privacy) | ✅ just shipped |
| 10 | **HUD** | The eye appears top-right; product is live | ✅ exists |

> **The critical design gap is moment #8**, and arguably its placement: the only blocking permission (Screen Recording) currently fires *after* the wizard and relaunch, attributed to a helper binary, with zero in-app guidance. A designer should decide where in this sequence the permission ask belongs and what the coaching screen looks like.

---

## 2. Install mechanics (moments 1–4)

- **DMG contents:** a single signed `Sinain.app` + an `Applications` symlink. The `.app` bundles *everything* needed to run offline-capable: the Flutter overlay, a bundled **Node runtime + sinain-core**, the **sck-capture** screen/audio helper, the Python sense pipeline, and the knowledge-graph scripts. (Local AI models are *not* bundled — they download on first run, see §5.)
- **No custom DMG presentation today:** volume name "Sinain", standard compressed (UDZO) image, no background image, no icon positioning, no custom window size. *Opportunity:* a branded DMG background with an arrow "drag me to Applications" is a common, easy win.
- **Gatekeeper:** the app is code-signed with a Developer ID and **notarized + stapled**, so a fresh Mac opens it **without** the "unidentified developer" warning and **without** a right-click-open workaround. This is already smooth; no design needed.
- **Versioning:** each build stamps `DMG_VERSION` + `BUILD_ID` inside the bundle; an in-app update check later surfaces "a newer version is available" (manual download, no auto-update).

---

## 3. The setup wizard (moments 5–7) — screen by screen

A **frameless, draggable panel**, dark (black @ 94%, 12px corner radius), accent **neon green `#00FF88`**, **340×420 px**. A small dim **"Quit"** link sits at the bottom of every screen except "Finishing".

> Note: this is the *current* visual language (the brighter `#00FF88`). It is **not** the same palette as the feature tour, which uses the design system's deeper green `#1F8039`. Unifying the two is a design decision worth making.

### Screen 1 — Welcome
- **Header:** `SINAIN` (caps, bold, accent, wide letter-spacing).
- **Body:** *"A private AI overlay that watches your screen and audio, and is invisible to screen capture."*
- **Primary:** `Get started`.

### Screen 2 — Choose how Sinain runs (tier selection)
Title: *"Choose how Sinain runs."* Three tap-to-select cards (no radios; selected = green border + lighter fill). A disk-size hint sits top-right of each. **Continue** is disabled until one is picked.

| Card | Disk hint | Tagline | Cloud egress line | Implies |
|------|-----------|---------|-------------------|---------|
| **Cloud** | "no download" | *"Fastest setup. Uses OpenRouter for everything."* | *"Screen + audio context (redacted per privacy mode)"* | needs API key; nothing local; privacy=standard |
| **Hybrid** | "~1.6 GB" | *"Audio transcribed on-device; analysis still in the cloud."* | *"Screen context only — audio never leaves your Mac"* | needs API key; local Whisper; privacy=standard |
| **Private** | "~9 GB" | *"Fully offline. Needs Ollama + ~9 GB of models."* | *"Nothing — zero cloud requests"* | no API key; Ollama+Whisper; privacy=paranoid |

### Screen 3 — Config
Two variants depending on tier:
- **Cloud / Hybrid:** title *"Paste your OpenRouter API key"*, a password field (placeholder `sk-or-...`, autofocus), helper *"Get a free key at openrouter.ai"*. Error if empty: *"An OpenRouter API key is required for this tier."*
- **Private:** no input — an instruction block: *"Full local mode needs Ollama running with the models pulled: `ollama pull phi4-mini qwen2.5vl:7b` and whisper.cpp installed. Zero data leaves your Mac."*
- **Primary:** `Finish setup`.

### Screen 4 — Finishing
Spinner + *"Writing config and starting the backend…"*. No Quit link (can't interrupt). On success the app relaunches into the backend-boot path.

### Provisioning banner (local tiers only, moment 7)
After relaunch, while models download, a **360×230** banner titled **"Setting up Sinain"** lists per-item rows (e.g. *Installing Python runtime*, *Whisper model*, *Ollama*) each with a thin progress bar and ✓ / `!` / `NN%` / `…` status. Footer: *"You can keep working — this runs in the background and only happens once."* It auto-dismisses ~4s after the last activity.

---

## 4. 🔐 macOS permissions — the part to design

macOS gates certain capabilities behind **TCC** privacy prompts. Below is exactly what Sinain triggers, based on the current code. **The app is not sandboxed in release builds**, so these are standard system privacy dialogs.

### 4.1 Screen Recording — **the one prompt that actually fires** ⚠️
- **Why:** screen capture (and system-audio capture) go through Apple's **ScreenCaptureKit**, which requires Screen-Recording permission.
- **When:** the **first time capture starts** — i.e. *after* the wizard finishes and the backend boots (moment 8), not during the wizard. The OS shows: *"… would like to record this screen."* and capture is blocked until the user grants it in **System Settings → Privacy & Security → Screen Recording** (often requiring a relaunch).
- **Naming wart:** the capture is performed by a separate helper binary, **`sck-capture`**, so the system dialog and the Settings toggle may read **"sck-capture"** rather than **"Sinain."** This is confusing for users and is worth an engineering fix (embed/rename the helper) *and* a design accommodation (a screen that says "you'll see a prompt for *sck-capture* — that's us").
- **In-app guidance today:** **none in the packaged flow.** (An older onboarding screen with grant instructions exists in the codebase but is **retired** / not shown.) **This is the screen to design:** explain why, show the exact path, ideally deep-link to the Settings pane, and handle the "granted → please relaunch" round-trip.

### 4.2 Microphone — **not currently prompted**
- Default capture is **system audio via ScreenCaptureKit**, which rides under Screen Recording — **no separate mic prompt**.
- Caveat for the designer/PM: the product talks about "mic and system sound," and there's a mic toggle in the HUD. **True microphone capture would require a `NSMicrophoneUsageDescription` string (currently not defined) and would raise its own prompt.** If mic-in is a real feature, it needs both the plist string (eng) and a permission moment (design). Today, treat audio as "system sound, no extra prompt."

### 4.3 Accessibility — **not currently requested**
- The app positions its windows and markers via standard `NSWindow`/`NSPanel` APIs and a Carbon hotkey, **not** the Accessibility API — so **no Accessibility prompt fires today**.
- Caveat: earlier design explorations imagined Accessibility "to keep markers attached to content." If marker-anchoring ever needs the Accessibility API, that becomes a **second** permission moment to design. Flag as an open product decision.

### 4.4 Camera — **not used, no prompt**
- Sinain never opens the camera. (There's deliberate engineering to *avoid* camera-subsystem contention so video calls keep working.) No design needed.

### 4.5 Apple Events — present but effectively silent
- The only usage-description string in the app is `NSAppleEventsUsageDescription = "SinainHUD needs access for overlay functionality."` Modern macOS rarely surfaces this. No design needed.

### Permission summary

| Permission | Fires today? | When | Dialog attribution | In-app coaching today | Designer action |
|---|---|---|---|---|---|
| **Screen Recording** | ✅ yes (blocking) | after setup, on first capture | **"sck-capture"** (helper binary) | **none** | **design the coaching + Settings deep-link + relaunch handoff** |
| Microphone | ❌ no (system audio rides Screen Recording) | — | — | — | decide if true mic-in is a feature; if so, design it |
| Accessibility | ❌ no (not used) | — | — | — | decide if marker-anchoring needs it later |
| Camera | ❌ no | — | — | — | none |
| Apple Events | rare/silent | — | "SinainHUD" | — | none |

---

## 5. What's downloading (so "why is it slow" is designable)

For **Hybrid** and **Private** tiers the first run downloads/installs in the background (the provisioning banner, §3): a self-contained **Python runtime** (for the sense pipeline), the **Whisper** speech model (~1.6 GB, Hybrid+Private), and **Ollama + LLM/vision models** (~9 GB, Private). It's idempotent and resumable. **Cloud** tier downloads nothing. This is the "your Mac is setting itself up, one time" story to design around.

---

## 6. Where the feature tour fits (context, already built)

After setup + permissions, a one-time **11-scene feature tour** runs (then the HUD). It teaches: the invisible eye, auto-detected markers, drag-a-region, where chat lands (HUD vs. pop-out app), pick agents, hand a thread to a terminal agent, the **knowledge browser**, **sharing a concept**, **screen & audio toggles**, **privacy / demo mode**, and "you're all set." It deliberately **does not** ask for permissions (it assumes the install wizard handled them) and **does** teach the capture *toggles*. Visual language: deeper green `#1F8039`, dark cards, the animated Sinain eye. Keeping the wizard and the tour visually consistent is a design goal.

---

## 7. Window geometry & visual reference

| Surface | Size (px) | Notes |
|---|---|---|
| Setup wizard | 340 × 420 | dark, accent `#00FF88`, draggable, "Quit" link |
| Provisioning banner | 360 × 230 | "Setting up Sinain", per-item progress |
| Feature tour | 460 × 504 | deeper green `#1F8039`, scene cards |
| HUD (collapsed eye) | 48 × 48 | top-right; expands to chat |

All setup surfaces are **frameless and drag-anywhere**.

---

## 8. Open decisions for product + design

1. **Where does the Screen-Recording ask live?** A dedicated wizard step *before* "Finishing" (pre-warn, then trigger), or a post-relaunch coaching overlay when the OS prompt fires? (Recommend: a pre-warn screen in the wizard + a "waiting for permission" state after.)
2. **The "sck-capture" naming** in the system dialog — fix in engineering, and/or set expectations in copy.
3. **Mic-in** — real feature or not? If yes, it needs a plist string + its own prompt moment.
4. **Accessibility** — only if marker-anchoring later needs it.
5. **Visual unification** — the wizard (`#00FF88`) vs. the tour (`#1F8039`) currently differ.
6. **Branded DMG window** — background art + drag-to-Applications affordance.

---

## 9. Proposed permission screens (a starting point, not a final design)

The single missing piece is the Screen-Recording moment (§4.1). Here is a concrete three-state starting point the designer can react to — same 340×420 dark wizard panel, inserted **between "Config" and "Finishing"** (pre-warn *before* we trigger the OS prompt), then a post-relaunch **waiting** state, then **done**. macOS lets us deep-link straight to the toggle pane:
`x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`.

### 9A — Pre-warn (new wizard step, before we trigger the OS dialog)
```
┌──────────────────────────────┐
│            SINAIN            │
│                              │
│   👁  One quick permission    │
│                              │
│  Sinain reads your screen to │
│  offer help in context, and  │
│  hears system audio the same │
│  way. macOS will ask you to  │
│  allow Screen Recording.     │
│                              │
│  ⚠  The system prompt says   │
│  “sck-capture” — that’s      │
│  Sinain’s capture helper.    │
│                              │
│   [ Allow Screen Recording ] │  ← triggers the OS prompt
│          Do this later       │
└──────────────────────────────┘
```

### 9B — Waiting for grant (after the OS prompt / relaunch)
```
┌──────────────────────────────┐
│            SINAIN            │
│                              │
│   ◴  Waiting for permission  │
│                              │
│  In System Settings:         │
│   Privacy & Security →       │
│   Screen Recording →         │
│   turn on Sinain             │
│   (listed as “sck-capture”)  │
│                              │
│   [ Open System Settings ]   │  ← deep-link above
│                              │
│  Sinain continues on its own │
│  once it’s enabled.          │
│  (macOS may ask to relaunch) │
└──────────────────────────────┘
```

### 9C — Granted
```
┌──────────────────────────────┐
│            SINAIN            │
│                              │
│         ✓  All set           │
│                              │
│  Screen Recording is on.     │
│  Sinain can now see your     │
│  screen and hear system      │
│  audio to help in context.   │
│                              │
│         [ Continue ]         │
└──────────────────────────────┘
```

**Behavioral notes for the designer/eng:**
- **Auto-advance:** 9B should detect the grant automatically (the backend reports capture going active) and move to 9C with no extra click.
- **The relaunch round-trip:** macOS frequently requires the app to relaunch before a freshly-granted Screen-Recording permission takes effect. 9B must survive a relaunch (it can re-enter the "waiting" state on next boot) and not look like an error.
- **"Do this later" path:** if the user defers, the HUD can still open but capture is dead until granted — design a persistent, gentle nag (e.g. the eye shows a "needs permission" state) rather than blocking the whole app.
- **Naming fix is preferable:** if engineering renames/embeds the helper so the OS dialog reads "Sinain" instead of "sck-capture," delete the ⚠ lines in 9A/9B.

---

### Appendix — source references (for engineering follow-up)
- Wizard: `overlay/lib/ui/first_run/first_run_wizard.dart`, `tier_selection_view.dart`, `install_tier.dart`; `core/services/first_run_service.dart` (writes `~/.sinain/.env`).
- Gate order: `overlay/lib/main.dart` (wizard → provisioning → tour → HUD).
- Provisioning: `core/services/provisioning_service.dart`, `ui/first_run/provisioning_banner.dart` (polls `~/.sinain/provisioning/*.status`).
- Backend launch: `overlay/macos/Runner/AppDelegate.swift` (`BackendLauncher`, `sinain_hud/backend` channel), `tools/dmg/stage-backend.sh` (generated `launch-backend.sh`).
- Capture / Screen Recording: `tools/sck-capture/main.swift` (ScreenCaptureKit), `sinain-core/src/audio/capture-spawner-macos.ts`.
- Permissions/entitlements: `overlay/macos/Runner/Info.plist`, `ReleaseDMG.entitlements`, `Node.entitlements`.
- DMG build/sign/notarize: `tools/dmg/{stage-backend.sh, assemble-app.sh, build-full-dmg.sh}`, `.github/workflows/release*.yml`.
- Retired permission UI (reference for the new design): `overlay/lib/ui/onboarding/step_permissions.dart` (not currently shown).
