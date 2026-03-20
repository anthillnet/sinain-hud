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
| NemoClaw instance on Brev | NVIDIA Brev account with a running OpenClaw container ([NemoClaw README](https://github.com/NVIDIA/NemoClaw)) |
| NemoClaw onboarded | `nemoclaw onboard` completed (part of NemoClaw initial setup) |
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
3. Note the IP address shown (e.g. `34.26.234.177`)

> The HTTPS links Brev provides use session auth that sinain-core can't use. Raw TCP/IP on port 18789 is required for the WebSocket connection.

### 1b. Run `npx @geravant/sinain` in the Code-Server terminal

1. Click the **Code-Server terminal** link in your Brev dashboard
2. In that browser terminal, run:

```bash
# Brev containers set HTTPS_PROXY="" which breaks Node 22 npm requests.
# Unset it before running npx:
unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy

npx @geravant/sinain
# or, if you have a memory backup repo:
SINAIN_BACKUP_REPO=git@github.com:yourname/sinain-memory.git npx @geravant/sinain
```

`npx @geravant/sinain` will:
- Copy plugin files into the OpenShell sandbox at `/sandbox/.openclaw/extensions/sinain-hud/`
- Copy `sinain-memory/` scripts to `/sandbox/.openclaw/sinain-sources/`
- Patch `openclaw.json` in the sandbox (adds plugin config, `sessionToolsVisibility: all`)
- Restart the OpenClaw gateway inside the sandbox
- Forward sandbox port 18789 → VM port 18789 (so Brev's exposed port works)

3. At the end you'll see output like:
```
✓ sinain installed successfully.
  Sandbox:    sinain-test
  Auth token: 43bb3cd31fe38405791ba0c07530010a85e958f614706999

  Next steps:
    1. In your Brev dashboard → "Expose Port(s)" → enter 18789 → TCP
       (This makes the gateway reachable from your Mac — no SSH tunnel needed)
    2. Run ./setup-nemoclaw.sh on your Mac:
       NemoClaw URL:  ws://34.26.234.177:18789
       Auth token:    43bb3cd31fe38405791ba0c07530010a85e958f614706999
```

### 1c. Start the OpenClaw gateway

In a **second Code-Server terminal**, run:

```bash
openclaw gateway
```

Keep this terminal open — the gateway runs in the foreground. It will print its WebSocket URL and start accepting connections.

> To run it in the background instead: `nohup openclaw gateway > ~/.openclaw/gateway.log 2>&1 &`

4. **Note your auth token** — it's printed directly in the `npx` output (step 1b). If not visible, check `~/.openclaw/openclaw.json` → `gateway.auth.token`.

### 1d. Fix the port forward binding

`openshell forward start` binds to `127.0.0.1` instead of `0.0.0.0`, making port 18789 unreachable from your Mac even after Brev exposes it. This affects every installation — run these commands in the Code-Server terminal after `npx` completes:

```bash
# Find and kill the openshell forward
pid=$(ss -tlnp | awk -F"pid=" '/18789/{print $2}' | cut -d, -f1)
kill "$pid"
# Restart with 0.0.0.0 binding
nohup ssh -g -N -L 18789:localhost:18789 openshell-<your-sandbox-name> > /tmp/ssh-fwd-18789.log 2>&1 &
```

Replace `<your-sandbox-name>` with your actual sandbox name (e.g. `sinain-test`).

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
| **[3/5] NemoClaw URL** | `ws://YOUR-IP:18789` (printed by `npx` in step 1b) |
| **[4/5] Auth token** | The token printed by `npx` in step 1b — sets both `OPENCLAW_WS_TOKEN` and `OPENCLAW_HTTP_TOKEN` in `.env` |
| **[5/5] Memory backup repo** | Private GitHub repo URL (optional — keeps your playbook portable across Brev instances) |

> **Security**: the memory backup repo must be private. The wizard will verify this via the GitHub API and abort with an error if the repo is public.

After you answer all prompts, `setup-nemoclaw.sh` writes `sinain-core/.env`.

**Important**: Verify that `OPENCLAW_WS_TOKEN` and `OPENCLAW_HTTP_TOKEN` are both set in `sinain-core/.env`. The setup script may leave them blank — if so, copy the auth token from the `npx` output (step 1b) and paste it into both fields:

```bash
# In sinain-core/.env, both must have the same 48-char hex token:
OPENCLAW_WS_TOKEN=43bb3cd31fe38405791ba0c07530010a85e958f614706999
OPENCLAW_HTTP_TOKEN=43bb3cd31fe38405791ba0c07530010a85e958f614706999
```

Then start all services:
```bash
./start.sh
```

---

## Manual configuration (advanced)

Skip this section if you ran the wizard above.

`setup-nemoclaw.sh` writes these variables to `sinain-core/.env`:

```bash
OPENROUTER_API_KEY=sk-or-...
TRANSCRIPTION_MODE=openrouter          # or: local
OPENCLAW_WS_URL=ws://34.x.x.x:18789
OPENCLAW_HTTP_URL=http://34.x.x.x:18789/hooks/agent
OPENCLAW_WS_TOKEN=<48-char hex token>
OPENCLAW_HTTP_TOKEN=<48-char hex token>
OPENCLAW_SESSION_KEY=agent:main:sinain
```

> `OPENCLAW_SESSION_KEY` must be exactly `agent:main:sinain` — the sinain plugin on the server is registered under this key.

See `sinain-core/.env.example` for the full list of available variables.

---

## Verifying the installation

### NemoClaw side (Code-Server terminal)

1. **Gateway is running** — in the terminal running `openclaw gateway`, you should see:
   ```
   [gateway] Listening on ws://0.0.0.0:18789
   ```
2. **Plugin loaded** — run `openclaw status` and look for:
   ```
   sinain-hud: plugin registered
   ```
3. **Agent active** — run `/sinain_status` in any OpenClaw session — should show the sinain agent session as active

### Mac side

4. **Overlay appears** — a small HUD window should be visible on your screen
5. **Health check**:
   ```bash
   curl http://localhost:9500/health
   # → {"ok":true,...}
   ```
6. **Gateway connected** — in the health response, check `escalation.gatewayConnected: true`
7. **Agent responding** — after ~60–90 seconds, `escalation.totalResponses` should be > 0
   (Nemotron response latency is ~60s per escalation — this is normal)
8. **End-to-end test** — speak a sentence or show text on screen; the overlay should update within ~10 seconds

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

## Recovery after sandbox recreation

If your NemoClaw sandbox was destroyed and recreated (e.g. Brev instance restart, `nemoclaw <name> destroy` + recreate), all sandbox state is wiped. Re-run:

1. **Re-onboard NemoClaw** (if needed):
   ```bash
   nemoclaw onboard
   ```

2. **Re-deploy sinain**:
   ```bash
   npx @geravant/sinain
   # or with memory backup:
   SINAIN_BACKUP_REPO=git@github.com:yourname/sinain-memory.git npx @geravant/sinain
   ```

3. **Re-expose port 18789** in Brev dashboard (port exposures may reset on instance restart)

4. **Apply openshell forward workaround** (see [Step 1d](#1d-fix-the-port-forward-binding))

5. **Restart sinain-core on Mac** — the auth token will have changed:
   - Update `OPENCLAW_WS_TOKEN` and `OPENCLAW_HTTP_TOKEN` in `sinain-core/.env`
   - Run `./start.sh`

---

## Known issues / next steps

| Issue | Impact | Status |
|---|---|---|
| `openshell forward start` binds to `127.0.0.1` instead of `0.0.0.0` | Port 18789 not reachable from Mac without workaround (see [Step 1d](#1d-fix-the-port-forward-binding)) | Fix pending in installer |
| `uv` not installed in Brev sandbox | Memory/playbook curation pipeline disabled (`signal_analyzer.py`, `insight_synthesizer.py`, `feedback_analyzer.py` etc. all fail with `spawn uv ENOENT`) | Workaround: `pip install uv` in sandbox, or switch scripts to use `python3` directly |
| `setup-nemoclaw.sh` may leave tokens blank | Auth token must be manually verified/copied into `.env` (see Step 2) | Fix pending in setup script |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "401 Unauthorized" or "Token error" | Re-run `npx @geravant/sinain` in Code-Server to regenerate token; update `OPENCLAW_WS_TOKEN` in `.env` |
| Port not reachable / connection refused | Apply the `ssh -g` workaround in [Step 1d](#1d-fix-the-port-forward-binding); re-expose port 18789 in Brev dashboard (port exposures can expire) |
| `gatewayConnected: false` in `/health` | Check tokens in `.env`; verify port 18789 is open (`nc -z -w3 <IP> 18789`) |
| `totalResponses` stuck at 0 | Normal for up to ~90s on first connect; if it stays at 0, check gateway logs: `ssh -T openshell-<sandbox> "cat /tmp/oc-gateway.log"` |
| Screen OCR not working | Check **System Settings → Privacy & Security → Screen Recording** — sinain-core must be listed |
| Overlay not appearing | Check **System Settings → Privacy & Security → Accessibility** |
| `agent:main:sinain` session key mismatch | Verify `OPENCLAW_SESSION_KEY=agent:main:sinain` in `sinain-core/.env` |
| Camera blocked in Google Meet | Ensure you're using the `ffmpeg`-based audio path (not `sox rec`) — see `start.sh` |
| sinain-core not picking up `.env` changes | Touch any source file (`touch sinain-core/src/index.ts`) or kill and restart the process |
| `FailoverError: Unknown model: nvidia-nim/...` | Model mismatch — inside the sandbox, the model should be `inference.local` (OpenShell routes it). Re-run `npx @geravant/sinain` to reset config. |
| `FailoverError: No API key found for provider "anthropic"` | Agent model set incorrectly. Inside the sandbox, verify `agents.defaults.model` isn't set to `nvidia-nim/...` — OpenShell uses its own routing. |
| Sandbox recreated, nothing works | See [Recovery after sandbox recreation](#recovery-after-sandbox-recreation) above |
| `403 Forbidden` on npm install | `unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy` then retry `npx @geravant/sinain` |
