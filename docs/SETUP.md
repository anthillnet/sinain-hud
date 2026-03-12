# SinainHUD — First-Install Setup Guide

This guide walks you through setting up sinain-hud from scratch on your Mac. It assumes you already have an OpenClaw gateway running. If you don't, see [OPENCLAW-SETUP.md](./OPENCLAW-SETUP.md) first.

---

## 1. Prerequisites

| Requirement | Install |
|---|---|
| macOS 13+ | (ScreenCaptureKit audio; 12.3+ for screen capture only) |
| Node.js 22+ | `brew install node` |
| Python 3.11+ | `brew install python` |
| Flutter 3.10+ | `brew install flutter` |
| Tesseract | `brew install tesseract` (used by sense_client for OCR) |
| Homebrew | [brew.sh](https://brew.sh) |
| OpenRouter API key | [openrouter.ai/keys](https://openrouter.ai/keys) — needed for the agent digest model and screen OCR vision calls |
| OpenClaw gateway | Already running (remote or local Docker) |

---

## 2. Clone and Install Dependencies

```bash
git clone <sinain-hud-repo-url>
cd sinain-hud

# sinain-core Node.js deps
cd sinain-core && npm install && cd ..

# sense_client Python deps
pip install -r sense_client/requirements.txt
```

---

## 3. Audio — Modern Path (ScreenCaptureKit, zero extra setup)

The default `AUDIO_CAPTURE_CMD=screencapturekit` captures all system audio directly via ScreenCaptureKit on macOS 13+. No virtual audio device, no Audio MIDI Setup changes.

macOS will prompt for **Screen Recording** permission on first launch (this permission covers both screen and audio capture via SCKit).

> **Legacy / BlackHole path** — only needed if you must route specific app audio or are on macOS 12:
> ```bash
> brew install blackhole-2ch
> ```
> Then in Audio MIDI Setup, create a Multi-Output Device with both your speakers and BlackHole 2ch. Set it as your system output. In `.env`, set `AUDIO_CAPTURE_CMD=ffmpeg` and `AUDIO_DEVICE=BlackHole 2ch`.

---

## 4. Local Transcription Setup (Recommended)

Run transcription on-device with whisper.cpp — faster, private, no token cost for audio:

```bash
./setup-local-stt.sh
# Installs whisper-cli via Homebrew and downloads ggml-large-v3-turbo (~1.5 GB)
```

This is a one-time setup. Afterward, use `./start-local.sh` instead of `./start.sh` — it automatically sets `TRANSCRIPTION_BACKEND=local`.

If you prefer OpenRouter transcription (no model download), skip this step and set `OPENROUTER_API_KEY` in `.env`. The `AGENT_MODEL` and vision calls always require `OPENROUTER_API_KEY` regardless.

---

## 5. Configure sinain-core

```bash
cd sinain-core
cp .env.example .env
```

Edit `.env`. Most defaults are fine — only the fields below need attention.

### Required fields

**`OPENROUTER_API_KEY`**
Used for the agent digest model (`AGENT_MODEL`) and screen OCR vision calls. Not needed for audio if using local whisper, but required for everything else.
Get one at [openrouter.ai/keys](https://openrouter.ai/keys).

**`OPENCLAW_WS_URL`** and **`OPENCLAW_HTTP_URL`**
Your gateway address. Examples:
```ini
# Remote server
OPENCLAW_WS_URL=ws://85.214.180.247:18789
OPENCLAW_HTTP_URL=http://85.214.180.247:18789/hooks/agent

# Local Docker
OPENCLAW_WS_URL=ws://localhost:18789
OPENCLAW_HTTP_URL=http://localhost:18789/hooks/agent
```

**`OPENCLAW_WS_TOKEN`**
48-char hex from the gateway config. To find it:
```bash
# SSH into the gateway machine (or exec into the Docker container)
cat ~/.openclaw/openclaw.json | python3 -m json.tool | grep -A5 '"gateway"'
# Look for: "auth": { "token": "<48-char-hex>" }
```
This token is set when the gateway is first deployed (`--gateway-token` flag or `OPENCLAW_GATEWAY_TOKEN` env var).

**`OPENCLAW_SESSION_KEY`**
Keep the default: `agent:main:sinain`

The format is `<namespace>:<root-session>:<sub-session>`. This key routes escalations to the sinain agent sub-session inside the main OpenClaw agent session. It is created automatically when the sinain-hud plugin is installed on the gateway. Only change it if you're running multiple sinain instances or using a custom session layout.

### Optional fields

**`ESCALATION_MODE`** — start with `selective` (score-based, fires only when patterns match). Switch to `focus` temporarily to test escalation end-to-end. See [ESCALATION.md](./ESCALATION.md) for the scoring table.

**`MIC_ENABLED`** — defaults to `false` (privacy). Set `true` to also transcribe your own microphone input.

See `.env.example` for the full list with inline comments.

---

## 6. Deploy sinain-hud Plugin to OpenClaw

This is the only server-side step. The plugin hooks into the agent lifecycle to sync knowledge files, run heartbeat tools, and write session summaries.

```bash
export SERVER=root@<your-gateway-ip>
export SSH_KEY=~/.ssh/id_ed25519   # adjust to your key

# Create plugin and sources directories
ssh -i "$SSH_KEY" "$SERVER" "mkdir -p /mnt/openclaw-state/extensions/sinain-hud /mnt/openclaw-state/sinain-sources"

# Upload plugin files
scp -i "$SSH_KEY" \
  sinain-hud-plugin/index.ts \
  sinain-hud-plugin/openclaw.plugin.json \
  "$SERVER:/mnt/openclaw-state/extensions/sinain-hud/"

# Upload knowledge sources
scp -r -i "$SSH_KEY" sinain-koog/ modules/ \
  "$SERVER:/mnt/openclaw-state/sinain-sources/"
```

Then SSH into the server and add the plugin entry to `~/.openclaw/openclaw.json` (or wherever your gateway stores it):

```json
{
  "plugins": {
    "entries": {
      "sinain-hud": {
        "enabled": true,
        "config": {
          "heartbeatPath": "/mnt/openclaw-state/sinain-sources/sinain-koog/memory/HEARTBEAT.md",
          "skillPath": "/mnt/openclaw-state/sinain-sources/sinain-koog/memory/SKILL.md",
          "koogPath": "/mnt/openclaw-state/sinain-sources/sinain-koog",
          "modulesPath": "/mnt/openclaw-state/sinain-sources/modules",
          "sessionKey": "agent:main:sinain",
          "userTimezone": "Europe/Berlin"
        }
      }
    }
  }
}
```

> `userTimezone` is optional — set it to your IANA timezone for time-aware context injection in agent prompts.

Restart the gateway to pick up the plugin:

```bash
ssh -i "$SSH_KEY" "$SERVER" \
  "cd /opt/openclaw && docker compose -f docker-compose.openclaw.yml restart"
```

**Important:** always use `-f docker-compose.openclaw.yml` — the default compose file uses unset env vars and will fail.

To verify the plugin loaded:
```bash
ssh -i "$SSH_KEY" "$SERVER" \
  "cd /opt/openclaw && docker compose -f docker-compose.openclaw.yml logs --tail 30 openclaw-gateway 2>&1 | grep -i plugin"
```

---

## 7. macOS Permissions

These are granted at first-run (macOS prompts automatically):

| Permission | Trigger | Where to grant |
|---|---|---|
| **Screen Recording** | sense_client or sck-capture starts | System Settings → Privacy & Security → Screen Recording |
| **Microphone** | Only if `MIC_ENABLED=true` | System Settings → Privacy & Security → Microphone |
| **Accessibility** | Overlay registers global hotkeys | System Settings → Privacy & Security → Accessibility |

If a prompt doesn't appear, open System Settings and add the app manually.

---

## 8. First Run

**With local whisper (recommended):**
```bash
./start-local.sh
```

**With OpenRouter transcription:**
```bash
./start.sh
```

Both scripts run preflight checks, build `sck-capture` if the binary is stale, and start all services with color-coded output per component.

**Flags (work with both scripts):**
```bash
./start-local.sh --no-sense    # audio + overlay only (skip screen capture)
./start-local.sh --no-overlay  # headless mode (core + sense, no HUD window)
```

You should see a status banner:
```
── SinainHUD ──────────────────────────
  core     :9500   ✓  (http+ws)
  sense    pid:…   ✓  (running)
  overlay  pid:…   ✓  (running)
───────────────────────────────────────
  Press Ctrl+C to stop all services
───────────────────────────────────────
```

---

## 9. Verification

**Overlay visible** — a semi-transparent window appears at the bottom-right of your screen.

**Audio feed working** — speak or play audio; transcript items appear in the HUD feed within a few seconds.

**Hotkey** — `Cmd+Shift+Space` toggles overlay visibility.

**Escalation check:**
```bash
# Temporarily switch to focus mode to force an escalation
curl -X POST http://localhost:9500/agent/config \
  -H 'Content-Type: application/json' \
  -d '{"escalationMode": "focus"}'

# Wait ~30s, watch HUD for an agent response card

# Switch back
curl -X POST http://localhost:9500/agent/config \
  -H 'Content-Type: application/json' \
  -d '{"escalationMode": "selective"}'
```

**Gateway connectivity:**
```bash
# Check sinain-core logs for WS connection
grep '\[openclaw' ~/.sinain-core/traces/*.log

# Successful connection shows:
#   [openclaw-ws] connected
#   [openclaw] escalation sent (runId: ...)
#   [openclaw] agent response received
```

---

## 10. Troubleshooting

**No audio in HUD**
- Default: check that `AUDIO_CAPTURE_CMD=screencapturekit` in `.env` and Screen Recording permission is granted
- BlackHole path: verify BlackHole is set as system output and `AUDIO_DEVICE=BlackHole 2ch` is set

**Screen capture denied**
Grant Screen Recording in System Settings → Privacy & Security → Screen Recording, then restart.

**`[openclaw] auth failed`**
`OPENCLAW_WS_TOKEN` doesn't match the gateway. Verify with:
```bash
ssh -i "$SSH_KEY" "$SERVER" "openclaw config get gateway.auth.token"
# or read openclaw.json directly
```

**Overlay not visible**
Press `Cmd+Shift+Space`. If still hidden, check that the Flutter build succeeded (`flutter analyze` in `overlay/`).

**sense_client exits immediately**
```bash
pip list | grep -E "pillow|scikit-image|numpy|pytesseract|requests"
# Reinstall if any are missing
pip install -r sense_client/requirements.txt
```

**No escalations in selective mode**
The score threshold (≥ 3) wasn't met. Switch to `focus` mode to confirm the pipeline works, then switch back. See [ESCALATION.md](./ESCALATION.md) § Scoring for what raises the score.

**Circuit breaker tripped (5 consecutive WS failures)**
The WS client stops reconnecting. Fix the gateway, then restart sinain-core to reset the breaker.

---

## Next Steps

- [ESCALATION.md](./ESCALATION.md) — how scoring and escalation triggering works
- [OPENCLAW-SETUP.md](./OPENCLAW-SETUP.md) — deploy a new OpenClaw gateway from scratch
- [PLUGINS.md](./PLUGINS.md) — full plugin architecture reference
