# Installing sinain with NemoClaw

sinain is a privacy-first AI overlay for macOS that watches your screen and audio and surfaces real-time advice in a ghost overlay invisible to screen capture. It connects to a **NemoClaw** instance (NVIDIA Brev cloud) which runs the OpenClaw agent that provides the actual intelligence.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| macOS 13+ (Ventura) | Required for ScreenCaptureKit screen capture |
| Node.js 18+ | For sinain-core runtime |
| Python 3.9+ | For sense_client screen pipeline |
| Flutter 3.27+ | To build the overlay (or use a prebuilt binary) |
| NemoClaw instance on Brev | NVIDIA Brev account with a running OpenClaw container |
| OpenRouter API key | Free at [openrouter.ai](https://openrouter.ai) — used for screen OCR and audio transcription |
| Microphone + Screen Recording permissions | System Settings → Privacy & Security → Microphone / Screen Recording |

---

## Architecture overview

```
Mac                                  NemoClaw (Brev cloud)
─────────────────────────────        ──────────────────────────
sck-capture   ← audio + screen       OpenClaw gateway (port 18789)
     ↓                                    ↑ WebSocket
sinain-core ←→ WebSocket ─────────────────┘
     ↓                               sinain plugin (agent loop)
overlay (ghost window)               sinain-memory (playbook, eval)
     ↓
sense_client (OCR pipeline)
```

- **sinain-core** — central hub on your Mac (port 9500); manages audio, screen context, and the agent connection
- **overlay** — macOS ghost window; invisible to screen capture via `NSWindow.sharingType = .none`
- **sense_client** — Python pipeline that detects screen changes and sends OCR'd text to sinain-core
- **sck-capture** — Swift binary (ScreenCaptureKit); captures screen frames and system audio simultaneously
- **NemoClaw agent** — OpenClaw instance running in Brev cloud; receives context, runs analysis, sends advice back

---

## Step 1 — Server: NemoClaw setup

### 1a. Expose port 18789 in Brev dashboard

1. Open your Brev dashboard and go to your NemoClaw instance
2. Find **"Expose Port(s)"** → enter `18789` → select **TCP**
3. Note the IP address shown (e.g. `35.238.211.113`)

> The HTTPS links Brev provides use session auth that sinain-core can't use. Raw TCP/IP on port 18789 is required for the WebSocket connection.

### 1b. Run `npx @geravant/sinain` in the Code-Server terminal

1. Click the **Code-Server terminal** link in your Brev dashboard
2. In that browser terminal, run:

```bash
npx @geravant/sinain
# or, if you have a memory backup repo:
SINAIN_BACKUP_REPO=git@github.com:yourname/sinain-memory.git npx @geravant/sinain
```

`npx @geravant/sinain` will:
- Copy plugin files to `~/.openclaw/extensions/sinain/`
- Copy `sinain-memory/` scripts to `~/.openclaw/sinain-sources/`
- Install Python dependencies
- Patch `openclaw.json` (adds plugin config, compaction settings, enables LAN binding)
- Reload the OpenClaw gateway

3. At the end you'll see:
```
✓ sinain installed successfully.
  Auth token: check your Brev dashboard → 'Gateway Token'
  Then run ./setup-nemoclaw.sh on your Mac.
```

4. **Note your auth token** — find it in the Brev dashboard under "Gateway Token"

---

## Step 2 — Mac: run setup-nemoclaw.sh

```bash
git clone https://github.com/anthillnet/sinain-hud
cd sinain-hud
./setup-nemoclaw.sh
```

The wizard asks 5 fields:

| Prompt | What to enter |
|---|---|
| **[1/5] OpenRouter API key** | Your key from openrouter.ai |
| **[2/5] Audio transcription** | `a` for cloud (OpenRouter), `b` for local Whisper (~1.5 GB download) |
| **[3/5] NemoClaw URL** | `ws://YOUR-IP:18789` (e.g. `ws://35.238.211.113:18789`) |
| **[4/5] Auth token** | The token from Step 1b above |
| **[5/5] Memory backup repo** | Private GitHub repo URL (optional — keeps your playbook portable across Brev instances) |

> **Security**: the memory backup repo must be private. The wizard will verify this via the GitHub API and abort with an error if the repo is public.

After you answer all prompts, `setup-nemoclaw.sh` writes `sinain-core/.env` and calls `./start.sh` to launch all services.

---

## Manual configuration (advanced)

Skip this section if you ran the wizard above.

`setup-nemoclaw.sh` writes these variables to `sinain-core/.env`:

```bash
OPENROUTER_API_KEY=sk-or-...
TRANSCRIPTION_MODE=openrouter          # or: local
OPENCLAW_WS_URL=ws://35.x.x.x:18789
OPENCLAW_HTTP_URL=http://35.x.x.x:18789/hooks/agent
OPENCLAW_WS_TOKEN=<48-char hex token>
OPENCLAW_HTTP_TOKEN=<48-char hex token>
OPENCLAW_SESSION_KEY=agent:main:sinain
```

> `OPENCLAW_SESSION_KEY` must be exactly `agent:main:sinain` — the sinain plugin on the server is registered under this key.

See `sinain-core/.env.example` for the full list of available variables.

---

## Verifying the installation

1. **Overlay appears** — a small HUD window should be visible on your screen
2. **Health check**:
   ```bash
   curl http://localhost:9500/health
   # → {"status":"ok"}
   ```
3. **Agent active** — in the Code-Server terminal, run `/sinain_status` — should show the agent session as active
4. **End-to-end test** — speak a sentence or show text on screen; the overlay should update within ~10 seconds

---

## Updating sinain

**Server side** (in Code-Server terminal):
```bash
npx @geravant/sinain           # re-runs install, updates plugin files and patches openclaw.json
```

**Mac side**:
```bash
git pull
./start.sh           # restarts all services with latest code
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "401 Unauthorized" or "Token error" | Re-run `npx @geravant/sinain` in Code-Server to regenerate token; update `OPENCLAW_WS_TOKEN` in `.env` |
| Port not reachable / connection refused | Re-expose port 18789 in Brev dashboard (port exposures can expire) |
| Screen OCR not working | Check **System Settings → Privacy & Security → Screen Recording** — sinain-core must be listed |
| Overlay not appearing | Check **System Settings → Privacy & Security → Accessibility** |
| `agent:main:sinain` session key mismatch | Verify `OPENCLAW_SESSION_KEY=agent:main:sinain` in `sinain-core/.env` |
| Camera blocked in Google Meet | Ensure you're using the `ffmpeg`-based audio path (not `sox rec`) — see `start.sh` |
| SCP ownership errors (manual deploy) | Run the `/fix-workspace-permissions` skill in an OpenClaw session |
| sinain-core not picking up `.env` changes | Touch any source file (`touch sinain-core/src/index.ts`) or kill and restart the process |
