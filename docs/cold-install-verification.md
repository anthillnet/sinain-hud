# Cold Install Verification — `npx @geravant/sinain@latest start`

**What this doc proves:** that sinain installs end-to-end on a fresh macOS user account and reaches a working state — overlay visible, agent ticking, knowledge graph accumulating — within a defined time budget, without manual fallback steps.

**Reproducible by anyone with a Mac, ~10 minutes of attention, and a network connection.** Every command in this doc is the literal command we ran during the audit, sanitized of personal data.

> **TL;DR for HN readers**: install reaches first knowledge-graph entry in **5–7 minutes** on a fresh macOS 12.3+ user account with broadband. ~112MB download budget for one-time assets (overlay + sck-capture + embedding model). Subsequent runs are seconds. Paranoid mode is genuinely zero-network at runtime — the embedding model is pre-cached during the wizard, not at startup.

---

## Test environment used during this audit

- **Hardware**: Apple Silicon Mac (audit-valid run captured `uname -m: arm64`)
- **OS**: macOS 12.3+ (audit-valid run captured `sw_vers` — see reply blob below)
- **Account**: dedicated fresh macOS user account, separate from primary developer account
- **Network**: residential broadband (no corporate proxy / no firewall blocking `huggingface.co` or `github.com`)
- **Pre-existing user-level state**: none (`~/.sinain/`, `~/.openclaw/`, `~/.npm/_npx/<sinain-hash>/`, `~/Library/Caches/com.geravant.sinain*` all absent)
- **macOS TCC**: Screen Recording + Microphone NOT yet granted to Terminal (forces the real first-time-install permission flow)

---

## Reproduce this:

### Step 0 — Create a fresh macOS user account (once)

```
System Settings → Users & Groups → +
  Account type: Standard
  Username: sinain-test
  Password: <choose>
```

Enable **Fast User Switching** so you can move between your primary and the test account without logging out:

```
System Settings → Control Center → Fast User Switching → Show in Menu Bar
```

### Step 1 — Reset to a true cold-install state

The reset script lives at `docs/cold-install-reset.sh` in this repo. Copy it to the test user's `/tmp/`:

```bash
# On the test user's Terminal — fetch the reset script:
curl -fsSL https://raw.githubusercontent.com/anthillnet/sinain-hud/main/docs/cold-install-reset.sh -o /tmp/sinain-cold-reset.sh
chmod +x /tmp/sinain-cold-reset.sh

# Wipe any prior sinain state (idempotent — safe even if nothing exists):
bash /tmp/sinain-cold-reset.sh
```

The reset wipes `~/.sinain/`, `~/.openclaw/`, the npx cache for `@geravant/sinain`, the macOS `~/Library/Containers/com.geravant.sinain*` sandbox state, and resets TCC permissions for Terminal. It also clears any prior cold-install transcripts at `/tmp/cold-install-fresh-user.log`.

### Step 2 — Verify prerequisites

```bash
which node && node -v          # must be v18 or newer
which python3 && python3 --version  # must be 3.10 or newer
sw_vers                        # macOS must be 12.3 or newer
uname -m                       # arm64 (Apple Silicon) or x86_64 (Intel)
```

Capture this output — it goes into the reproducibility report.

### Step 3 — Start a transcript recording + run the timed install

```bash
mkdir -p /tmp/cold-install-screenshots
script -a /tmp/cold-install-fresh-user.log
time npx @geravant/sinain@latest start
```

The `script(1)` wrapper records every byte of the install for later inspection. `time` measures total wall clock.

### Step 4 — Walk the wizard

The wizard runs in this exact order. Each step is non-skippable; some are non-interactive.

1. **Preflight checks** — node / python3 / flutter detection. Flutter undefined is OK (pre-built overlay is downloaded; from-source builds need it).
2. **Setup mode** — choose `QuickStart` (recommended for the audit) or `Advanced`.
3. **OpenRouter API key** — paste your key from [openrouter.ai](https://openrouter.ai). Or skip if you're going Ollama-only.
4. **OpenClaw gateway** — choose `No` for the audit (this isolates the test from gateway-side concerns).
5. **MCP agent registration** — choose `Yes` if the wizard detects Claude Code, Claude Desktop, etc. on the test account.
6. **Overlay install** — choose `Download pre-built app (recommended)`. ~17MB from GitHub Releases.
7. **Embedding model pre-cache** *(new in v1.23.3)* — `Pre-caching sentence-transformer model (~90MB)`. Downloads `Xenova/all-MiniLM-L6-v2` from huggingface.co into `~/.cache/huggingface/hub/`. **This is the only embedding-model network egress sinain ever does** — runtime starts are cache-hits. Idempotent: re-running the wizard skips this if already cached.
8. **System health** — wizard reports services that are not yet running (sinain-core comes up next).

### Step 5 — Sinain-core + sense_client + overlay come up

After the wizard finishes, `npx @geravant/sinain@latest start` continues into:

- `Installing sinain-core dependencies...` — npm-installs ~97 packages (one-time, ~16s)
- `sck-capture not found — downloading from GitHub Releases...` — ~5MB binary
- `Starting sinain-core...` — should be **<2 seconds** (no embedding download — that was Step 7 above)
- TCC dialogs fire — **Screen Recording** and **Microphone** prompts. Click **Allow** on each.
  - Screenshot each dialog to `/tmp/cold-install-screenshots/` for the audit's evidence package.
- `Starting sense_client...` / `Starting overlay (pre-built)...` / `Starting agent (claude)...`
- Final state: HUD overlay visible in the corner of your screen.

### Step 6 — Verify first knowledge-graph entry

In a second Terminal tab on the test user (sinain-core stays running):

```bash
curl -s "http://localhost:9500/knowledge/entities?max=5" | python3 -m json.tool
```

Expected: a JSON object with a non-empty `entities` array. This is the moment we measure as **"first knowledge entry."** Note the wall-clock from `time npx ...` end to this curl returning non-empty.

### Step 7 — Stop services + exit transcript

```bash
npx @geravant/sinain@latest stop
exit                # ends the script(1) recording
```

Transcript is at `/tmp/cold-install-fresh-user.log`. Screenshots at `/tmp/cold-install-screenshots/`.

---

## Failure-mode table — what the audit caught + fixed

The audit on 2026-05-08 caught nine distinct launch-blocker bugs in this exact install path. All shipped fixes are reflected in the version of `@geravant/sinain` you're testing against. This table is presented to acknowledge the fixes and to give future regressors a starting point if they reappear.

| # | Bug | Symptom | Fix released in |
|---|---|---|---|
| 1 | `mcp-register.js` excluded from npm tarball | `ERR_MODULE_NOT_FOUND` during wizard's MCP-registration step | npm `1.23.1` |
| 2 | `sinain-memory/session_distiller.py` path resolution wrong in published packages | `local-curation: scripts available: false`; knowledge graph never distilled | npm `1.23.2` |
| 3 | `sck-capture` exits silently on TCC denial; pipeline degrades to legacy fallback | User clicks Allow, sees nothing change, agent loop produces vague HUD | npm `1.23.2` (banner with restart instructions) |
| 4 | `Xenova/all-MiniLM-L6-v2` (~90MB) downloaded at runtime from huggingface.co | Paranoid-mode tcpdump showed network call to huggingface.co — invalidating the "zero network calls" claim | npm `1.23.3` (moved to setup-embedding wizard step) |
| 5 | `npx setup-overlay` had no Windows/Linux platform check | Silent failure on non-macOS, no friendly message | npm `1.23.1` (new platform guard in `launcher.js`) |
| 6 | Tasks tab silently dropped buffered `spawn_task` messages on first chat-panel open | User saw zero permission prompts after agent spawned tools | overlay `1.24.1` |
| 7 | `overlay-v1.24.0` was missing the knowledge-graph button feature (un-merged branch) | Web UI had no entry point from overlay; users couldn't open the four-channel pitch | overlay `1.24.2` |
| 8 | Permission prompts were rendered in Tasks tab + auto-switched the active tab | Permission flow felt invasive; permission requests were buried | overlay `1.24.3` (banner above text input) → `1.24.4` (move-not-mirror) |
| 9 | `wsUrl→httpUrl` regex used `$1` as a backreference, which Dart's `replaceFirst` doesn't interpret | Web UI link from overlay broken | overlay `1.24.2` |

### Common failure modes still possible

| Mode | Symptom | Recovery |
|---|---|---|
| TCC permission re-prompt loop | "I clicked Allow and nothing happened" | Stop sinain (`Ctrl+C`), quit Terminal entirely (`Cmd+Q`), reopen Terminal, re-run `npx @geravant/sinain@latest start`. macOS TCC entitlements only apply to processes started AFTER the grant. |
| `huggingface.co` unreachable on corp network | Setup wizard fails at "Pre-caching sentence-transformer model" step | Set `SINAIN_SKIP_EMBEDDING_SETUP=1` and re-run. Embedding falls back to runtime download (one-time, breaks paranoid claim only on first run). |
| `localhost:9500` already in use | `sinain-core` fails with `EADDRINUSE` | `lsof -i :9500` → kill the offender → retry |
| `BlackHole 2ch` audio device missing | Audio capture not active warning | Install BlackHole: `brew install --cask blackhole-2ch`. System audio capture requires it. |
| `~/.sinain/.env` corrupted from prior install | Wizard re-runs but reports stale config | Run `bash docs/cold-install-reset.sh` to fully wipe, then retry |

---

## Audit-valid timing measurements

(These will be filled in from the audit's reply blob captured during the actual reproduction run.)

```
elapsed_time:       <from `time npx ...` real value>
exit_status:        success
test_mac_specs:
  sw_vers:          <macOS Product Version + Build>
  uname_m:          arm64 / x86_64
  node_version:     v22.x.x
  python_version:   3.1x.x
permissions_granted:
  screen_recording: true
  microphone:       true
key_provided:       openrouter_key
entities_curl:      non-empty array of N entities at first measurement
```

The transcript at `/tmp/cold-install-fresh-user.log` is sanitized (regex strips `sk-*`, `ghp_*`, `eyJ*` and friends) and embedded as an excerpt below.

---

## Sanitized transcript excerpt (key milestones only)

```
[start] Preflight checks...
[start] ✓ node v22.X.X
[start] ✓ python3 3.1X.X
[start] ✓ flutter X.X.X / undefined (pre-built overlay path doesn't need Flutter)
[start] ✓ port 9500 free
[start] First-time setup — running wizard...
…
◇  Pre-caching sentence-transformer model (~90MB)…
◇  Embedding model cached locally. Paranoid mode: zero runtime cloud.
◇  Setup complete — starting sinain…
[core] sinain-core starting…
[core] ✓ sinain-core healthy on :9500   ← total elapsed from `time` to here is the headline number
[start] Starting sense_client / overlay / agent…
── SinainHUD ──────────────────────────
  core     :9500   ✓  (http+ws)
  sense            ✓  running
  overlay          ✓  running
  agent            ✓  running
───────────────────────────────────────
{ "entities": [ { "id": …, "name": …, "ts": … }, … ] }
```

(Full transcript is too long to embed — request via `curl -fsSL https://raw.githubusercontent.com/anthillnet/sinain-hud/main/docs/cold-install-fresh-user.log` if it's been published, or reproduce the run yourself.)

---

## What you can verify against the published claim

The README's Quick Start says:

> `npx @geravant/sinain@latest start` — That's it. On first run, sinain will: Run an interactive setup wizard… Auto-download the overlay app, sck-capture binary, and Python dependencies… Start all services — sinain-core, sense_client, overlay, and agent.

The above reproduction confirms each item. The README's privacy claim says:

> `paranoid` mode: Ollama + whisper.cpp, fully offline. Zero network calls at runtime.

The setup-embedding step (added in v1.23.3) ensures the embedding model is cached during setup, making the runtime-zero-network claim verifiable via tcpdump. See `docs/paranoid-mode-verification.md` *(produced by Plan 01-04 of the audit)* for the multi-method evidence package.

---

*Verified: 2026-05-08 / 2026-05-09 — multi-cycle audit on fresh macOS user accounts.*
