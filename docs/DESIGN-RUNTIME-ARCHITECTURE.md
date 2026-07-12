# Runtime architecture — reliability for non-dev users

> Motivated by the 2026-07-10/11 field-failure catalog (below). The goal is
> that a non-developer never sees a raw error, never edits an env var, and
> never runs a terminal command — including for updates.

## 1. Failure catalog (all observed live, one 24h window)

| # | Failure | Class |
|---|---|---|
| 1 | `start.sh` supervisor died → children bled out via EPIPE; core survived **headless** (port bound, no capture, no logs → "range was idle" saves) | supervision |
| 2 | Analyzer silently disabled for weeks (missing API key env var); memory distiller keyless | config |
| 3 | Installed `sck-capture` rejected `--mic` (flag existed only in the spawner, and in the Windows helper — never in the macOS binary) | binary/version skew |
| 4 | "distiller failed: Command failed: python3 /Users/…" shown verbatim on a receipt card | error surfacing |
| 5 | `tsx watch` hot-reload restarting core mid-call; debug overlay builds in daily use | dev artifacts in prod |

None of these are language failures. A rewrite (Rust/Swift monolith) fixes #1
and #3 by construction and none of the others, while forfeiting iteration
speed (the offer feature changed five times in one day) and the Flutter
Windows overlay. **Rejected as the primary move**; revisit only as a
substrate optimization if profiling demands it (§6).

## 2. The split that matters: kernel vs userland, by churn rate

- **Kernel (boring, native, signed, ~never changes):** a small Swift
  supervisor that IS the menu-bar app. Owns capture (sck-capture folds in),
  owns every child process — restart policies with backoff, health probes,
  EPIPE-proof pipe ownership, single structured log. `start.sh` and the
  terminal cease to exist for users. Retires failure class 1.
- **Userland (fast-iterating brain):** core's agent/capture/memory logic.
  May crash, restart, self-update — capture and the overlay never go down
  with it.

Consolidations (no rewrite):
- sense_client folds into the kernel (it is mostly a pump: SSIM gate + POST).
- Per-call Python spawns (distiller/integrator) finish migrating into the
  resident memoryd.
- Target: **kernel (Swift) · core (Node, compiled — no tsx) · memoryd
  (Python, resident) · overlay (Flutter)** — four processes, one owner, zero
  per-call spawns, zero bash.

**Vision stays LLM-based.** Screen understanding is semantic image
recognition (regions, image ticks, scene description) — only a vision LLM
does that; Apple's Vision framework is at most a complementary local text
layer, never a replacement.

## 3. Errors become states, not strings

Closed vocabulary, each with an auto-remediation and one human sentence:
`needs-permission · reconnecting · update-required · model-unavailable ·
offline`. Raw stderr goes to the log and a crash reporter, never to a card.
The eye wears degraded state (the `/health` service map already exists —
surface it).

## 4. Config gets one home with a UI

No user-facing env vars. Provider/key/model selection lives in Settings (the
wizard already exists); the backend reads one config file. This would have
caught failure #2 at setup time ("no key for the analysis provider").

## 5. Update management (partially SHIPPED)

Requirements: the app **auto-checks for updates (opt-out) and updates
itself**.

As built (`overlay/lib/core/services/update_check_service.dart`):
- Daily check of GitHub releases (`macos-v*`) against the baked
  `DMG_VERSION`; paranoid/full-local modes imply no beacons.
- **NEW:** explicit Settings toggle "Check for updates automatically"
  (default on, persisted, `auto_update_check`).
- **NEW:** background self-update — when a newer DMG is found it downloads
  and stages silently; Settings shows **"Restart to update"**. The swap is
  quit-then-replace (native `installUpdate`), so the app never yanks itself
  out from under the user. Manual "Download & install" reuses the staged
  file.

Next steps (backlog):
- **Apply-on-quit:** when an update is staged, run the swap script (minus
  relaunch) on normal termination — updates happen invisibly between
  sessions.
- **Atomic bundles:** the DMG carries overlay + core + kernel + whisper at
  pinned versions; retire loose npx-installed binaries in `~/.sinain`
  (the direct cause of failure #3).
- Delta/quiet updates + release channel (stable/edge) once volume warrants.

## 6. When native rewrites earn a place

If ambient pipelines hurt on CPU/battery (VAD, SSIM, embeddings), grow the
**kernel** into the native pipeline substrate incrementally behind the same
process boundary. The brain is never rewritten wholesale.

## 7. Sequencing

1. **Supervisor-as-app** (retires the failure class users actually hit) —
   plus compiled core, release overlay builds. **SHIPPED (first cut):**
   `tools/sinaind/` — native Swift supervisor. Detached (`setsid`, SIGHUP
   ignored), owns child stdout→log pipes, restart-with-backoff, gives up on
   a child that dies instantly 8× in a row (`failed` state instead of an
   eternal crash-loop), probes `/health` every 30s and restarts a
   live-but-deaf core after 3 misses, writes
   `~/.sinain/supervisor/state.json` for the eye to surface (§3). Prod mode
   runs compiled core (`node dist`) + built overlay app — no tsx watch
   (failure 5). Entry: `./start.sh --supervised`. Not yet the menu-bar app;
   that shell comes with §2 consolidation.
2. **Error-state vocabulary + eye health** (§3) — `state.json` now exists
   as the input.
3. **Config UI** (§4) and **apply-on-quit updates** (§5).
4. Consolidation (§2), then substrate work only if measured.
