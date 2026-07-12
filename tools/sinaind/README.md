# sinaind — SinainHUD supervisor

Native (Swift) supervisor that owns every SinainHUD child service. Implements
step 1 of [docs/DESIGN-RUNTIME-ARCHITECTURE.md](../../docs/DESIGN-RUNTIME-ARCHITECTURE.md):
the supervision layer users actually hit failures in stops being bash.

## Why it exists

`start.sh` supervises through shell pipelines. When the launching terminal or
session dies, `start.sh` dies with it, the `pipe_log` consumers vanish, and
children bleed out one by one on EPIPE at their next stdout write — except
core, which doesn't log often enough and survives *headless* (port bound, no
capture, "range was idle" saves). Observed live 2026-07-11.

`sinaind` closes that class:

- **Detached by construction** — `--daemon` re-execs into its own session
  (`setsid`), SIGHUP ignored. No terminal, no teardown path.
- **Owns the pipes** — child stdout/stderr are read by the supervisor and
  appended to the session log (`~/.sinain/logs/backend.log`, same format the
  overlay's "Open Session Log" expects). A dying sibling can't sever anyone's
  log path.
- **Restart with backoff** — crashed children come back (1→2→5→15→60s).
  A child that dies instantly 8× in a row is marked `failed` and left down:
  one loud log line instead of an eternal crash-loop.
- **Deaf-core detection** — `/health` is probed every 30s; a core process
  that is alive but fails 3 consecutive probes gets restarted. Previously that
  state persisted silently until a human noticed.
- **State surface** — `~/.sinain/supervisor/state.json` (child states, pids,
  restart counts) for the overlay to render degraded state (design §3).

## Usage

```bash
./start.sh --supervised            # build if stale, hand off, return
./start.sh --supervised --dev      # dev toolchain (tsx watch, flutter run)

# or directly:
tools/sinaind/sinaind [--dev] [--no-sense] [--no-overlay] [--paranoid]
                      [--daemon] [--root <repo-root>]
```

Default (prod) mode runs the **compiled** core (`node dist/index.js`, building
once if `dist/` is missing) and the **built** overlay app if present under
`overlay/build/macos/Build/Products/{Release,Debug}` — no `tsx watch`
hot-reload restarts mid-call, no debug toolchain in daily use (design §1
failure 5). `--dev` opts back into `npm run dev` + `flutter run -d macos`.

Stopping: `kill $(cat ~/.sinain/supervisor/sinaind.pid)` — children get
SIGTERM, core last with a 25s grace (an in-flight distillation child must not
die mid-RocksDB-write), then the orphan sweep (memoryd, kg_daemon,
whisper-server, sck-capture). Launching a new sinaind takes over from a
running one the same way.

## What it replicates from start.sh

Stale-process cleanup (including setproctitle-renamed daemons and
core-orphaned helpers), port-9500 sweep, 5 MB log rotation, umask 077,
`PRIVACY_MODE` → sense_client env mapping, capture-ownership env
(`SINAIN_CAPTURE_OWNER=sense`, `AUDIO_CAPTURE_CMD=fifo`), `.env.paranoid`
loading, and core-health-gated sibling startup.

Not replicated (degrade gracefully or belong elsewhere): Ollama/region-SLM
model pulls, paranoid-mode model verification, npm-install-on-missing.

## Build

```bash
bash build.sh    # swiftc -O, macOS 13+, no deps beyond Foundation
```
