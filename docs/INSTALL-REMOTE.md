# Installing sinain with a Remote Server

Run the OpenClaw agent gateway on a bare-metal Linux server (e.g. Hetzner, Strato, any VPS) and connect sinain on your Mac over WAN. No Docker, no Kubernetes — just a native Node.js process managed by systemd.

This is the production deployment path used by the Strato server architecture.

---

## Prerequisites

### Server (Linux)

| Requirement | Notes |
|---|---|
| Linux (Debian/Ubuntu recommended) | Any distro with systemd |
| Root or sudo access | For installing packages and creating systemd services |
| Node.js 22+ | The setup script installs it if missing |
| Public IP or port forwarding | Port 18789 must be reachable from your Mac |
| Anthropic API key | Used by the OpenClaw agent — configured in `auth-profiles.json` on the server |

### Mac

| Requirement | Notes |
|---|---|
| macOS 13+ (Ventura) | Required for ScreenCaptureKit screen capture |
| Node.js 18+ | For sinain-core runtime |
| Python 3.9+ | For sense_client screen pipeline |
| Flutter 3.27+ | To build the overlay (or skip with `--no-overlay`) |
| SSH key with server access | Used by setup script to configure the server |
| OpenRouter API key | Free at [openrouter.ai](https://openrouter.ai) — used for screen OCR and audio transcription |
| Microphone + Screen Recording permissions | System Settings → Privacy & Security → Microphone / Screen Recording |

---

## Architecture overview

```
Mac                                  Remote Server (Linux)
─────────────────────────────        ──────────────────────────────
sck-capture   ← audio + screen       OpenClaw gateway (port 18789)
     ↓                                 ├─ sinain-hud plugin
sinain-core ←→ WebSocket (WAN) ───────┘  ├─ sinain-knowledge
     ↓                                    └─ memory, playbook, eval
overlay (ghost window)
     ↓                               systemd: openclaw-gateway.service
sense_client (OCR pipeline)          (auto-restarts on crash/reboot)
```

- **sinain-core** — central hub on your Mac (port 9500); manages audio, screen context, and the agent connection
- **overlay** — macOS ghost window; invisible to screen capture via `NSWindow.sharingType = .none`
- **sense_client** — Python pipeline that detects screen changes and sends OCR'd text to sinain-core
- **sck-capture** — Swift binary (ScreenCaptureKit); captures screen frames and system audio simultaneously
- **OpenClaw gateway** — native Node.js process on the server (port 18789); runs the Claude agent with sinain plugin, managed by systemd

---

## Quick start (automated)

```bash
git clone https://github.com/anthillnet/sinain-hud
cd sinain-hud
./setup-remote.sh
```

The wizard SSHes into your server, installs everything, configures your Mac, and launches sinain. It asks 7 things:

| Prompt | What to enter |
|---|---|
| **[1/7] OpenRouter API key** | Your key from [openrouter.ai](https://openrouter.ai) |
| **[2/7] Audio transcription** | `a` for cloud (OpenRouter), `b` for local Whisper (~1.5 GB download) |
| **[3/7] Server SSH connection** | `user@host` (e.g. `root@YOUR-SERVER-IP`) + SSH key path |
| **[4/7] Server setup** | Automatic — installs Node.js, openclaw, sinain plugin, systemd service, firewall |
| **[5/7] Verify Anthropic auth** | Checks if the server has an Anthropic API key in `auth-profiles.json`; if not, shows how to configure it |
| **[6/7] Memory backup repo** | Private GitHub repo URL (optional — seeds workspace with existing memory) |
| **[7/7] Write .env + launch** | Automatic — writes `sinain-core/.env` and runs `start.sh` |

The script is idempotent — safe to re-run. It sources the existing `.env` and skips already-configured values.

> **Security**: the memory backup repo must be private. The wizard verifies this via the GitHub API and aborts if the repo is public.

---

## Manual steps (reference)

Skip this section if you ran the wizard above. These steps explain what `setup-remote.sh` does under the hood.

### Step 1: Server — Install Node.js and openclaw CLI

```bash
ssh root@YOUR-SERVER

# Install Node.js 22 (if not present)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Install openclaw CLI
npm install -g openclaw
```

### Step 2: Server — Configure Anthropic API key

The gateway reads API keys from `auth-profiles.json`, not from environment variables.

```bash
# Option A: use the interactive configurator (recommended)
openclaw config

# Option B: create the file manually
mkdir -p ~/.openclaw/agents/main/agent
cat > ~/.openclaw/agents/main/agent/auth-profiles.json << 'EOF'
{"profiles":[{"provider":"anthropic","apiKey":"sk-ant-YOUR-KEY-HERE"}]}
EOF
```

### Step 3: Server — Install sinain plugin

```bash
npx @geravant/sinain install
# or, with a memory backup repo:
SINAIN_BACKUP_REPO=git@github.com:yourname/sinain-memory.git npx @geravant/sinain install
```

This copies plugin files, patches `openclaw.json` (sets `gateway.bind = "lan"`, `sessionToolsVisibility: "all"`, compaction params), and optionally clones the memory repo into `~/.openclaw/workspace/`.

> **Note:** The same `@geravant/sinain` package also provides `sinain start` for running the full sinain stack locally on your Mac. See the [main README](../README.md#quick-start) for details.

### Step 4: Server — Remove stale Docker workspace path (migration only)

If the server previously ran OpenClaw in Docker, the workspace path may point to `/home/node/` which doesn't exist on bare metal:

```bash
python3 -c "
import json, os
path = os.path.expanduser('~/.openclaw/openclaw.json')
cfg = json.load(open(path))
ws = cfg.get('agents',{}).get('defaults',{}).get('workspace','')
if '/home/node/' in ws:
    del cfg['agents']['defaults']['workspace']
    json.dump(cfg, open(path, 'w'), indent=2)
    print('Removed stale Docker workspace path')
"
```

### Step 5: Server — Create systemd service

```bash
cat > /etc/systemd/system/openclaw-gateway.service << 'EOF'
[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root
ExecStart=/usr/bin/env openclaw gateway --bind lan --port 18789
Restart=always
RestartSec=10
Environment=HOME=/root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now openclaw-gateway
```

Verify it's running:
```bash
systemctl status openclaw-gateway
curl http://localhost:18789/healthz
```

### Step 6: Server — Open firewall

```bash
# If using ufw:
ufw allow 18789/tcp

# If using iptables directly:
iptables -A INPUT -p tcp --dport 18789 -j ACCEPT
```

### Step 7: Server — Extract auth token

```bash
python3 -c "
import json, os
d = json.load(open(os.path.expanduser('~/.openclaw/openclaw.json')))
print(d.get('gateway',{}).get('auth',{}).get('token',''))
"
```

Note this token — you'll need it for the Mac `.env` file.

### Step 8: Server — Seed memory (optional)

If you have a private GitHub repo with existing memory/playbook:

```bash
# If workspace doesn't exist yet:
git clone git@github.com:yourname/sinain-memory.git ~/.openclaw/workspace

# If workspace already exists, update the remote:
cd ~/.openclaw/workspace
git remote set-url origin git@github.com:yourname/sinain-memory.git
git pull --ff-only
```

### Step 9: Mac — Configure sinain-core/.env

```bash
OPENROUTER_API_KEY=sk-or-...
TRANSCRIPTION_BACKEND=openrouter         # or "local" for Whisper
OPENCLAW_WS_URL=ws://YOUR-SERVER-IP:18789
OPENCLAW_HTTP_URL=http://YOUR-SERVER-IP:18789/hooks/agent
OPENCLAW_WS_TOKEN=<48-char hex token from step 7>
OPENCLAW_HTTP_TOKEN=<48-char hex token from step 7>
OPENCLAW_SESSION_KEY=agent:main:sinain
```

> `OPENCLAW_SESSION_KEY` must be exactly `agent:main:sinain` — the sinain plugin is registered under this key.

### Step 10: Mac — Launch

```bash
./start.sh
```

---

## Verifying the installation

1. **Server health check**:
   ```bash
   ssh root@YOUR-SERVER curl http://localhost:18789/healthz
   # → {"status":"ok"}
   ```

2. **Mac health check**:
   ```bash
   curl http://localhost:9500/health
   # → {"ok":true,...}
   ```

3. **Gateway connected** — in the Mac health response, check `escalation.gatewayConnected: true`

4. **Agent responding** — after ~10–20 seconds, `escalation.totalResponses` should be > 0

5. **Overlay appears** — a small HUD window should be visible on your screen

6. **End-to-end test** — speak a sentence or show text on screen; the overlay should update within ~10 seconds

---

## Updating

**Server side**:
```bash
ssh root@YOUR-SERVER
npx @geravant/sinain            # updates plugin files + patches openclaw.json
systemctl restart openclaw-gateway
```

> After using `scp` to deploy files, always fix ownership: `chown -R $(id -u):$(id -g) ~/.openclaw/sinain-sources/ ~/.openclaw/workspace/`

**Mac side**:
```bash
cd sinain-hud
git pull
./start.sh
```

---

## Migration gotchas

These issues are specific to servers that previously ran OpenClaw in Docker and have been migrated to native Node.js:

| Issue | Fix |
|---|---|
| `agents.defaults.workspace` points to `/home/node/.openclaw/workspace` | Delete the key from `openclaw.json` — native installs default to `~/.openclaw/workspace` |
| Git PATs in workspace remote expire | Update with `git -C ~/.openclaw/workspace remote set-url origin <new-url>` |
| SCP deploys break file ownership | Files land as `root:root`; the gateway process may not be able to write them. Run `chown -R $(id -u):$(id -g) ~/.openclaw/sinain-sources/ ~/.openclaw/workspace/` after any SCP deploy |
| `compaction` config at wrong nesting level | Must be under `agents.defaults.compaction`, not top-level. The installer handles this, but verify after manual edits |
| Bedrock `AccessDeniedException` in logs | Harmless — gateway probes AWS on startup and falls back to Anthropic API |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| SSH connection refused | Verify SSH key, user, and IP. Test: `ssh -i KEY user@host "echo ok"` |
| Port 18789 unreachable from Mac | Check firewall (`ufw status`), verify `gateway.bind` is `"lan"` (not `"loopback"`), test: `nc -z -w3 SERVER-IP 18789` |
| "401 Unauthorized" or token error | Re-extract token from server's `~/.openclaw/openclaw.json` → `gateway.auth.token`; update both `OPENCLAW_WS_TOKEN` and `OPENCLAW_HTTP_TOKEN` in `.env` |
| `gatewayConnected: false` in `/health` | Check tokens match; verify port is reachable; check server: `systemctl status openclaw-gateway` |
| `No API key found for provider "anthropic"` | Check `~/.openclaw/agents/main/agent/auth-profiles.json` on the server has a valid Anthropic key |
| Gateway keeps restarting | Check logs: `journalctl -u openclaw-gateway -f` |
| `totalResponses` stuck at 0 | Normal for first ~20s. If persistent, check gateway logs and verify the sinain plugin is loaded |
| `workspace not initialized` | Run `npx @geravant/sinain` on the server to initialize |
| Screen OCR not working | Check **System Settings → Privacy & Security → Screen Recording** on Mac |
| Overlay not appearing | Check **System Settings → Privacy & Security → Accessibility** on Mac |
| `agent:main:sinain` session key mismatch | Verify `OPENCLAW_SESSION_KEY=agent:main:sinain` in `sinain-core/.env` |
| Camera blocked in Google Meet | Ensure you're using the `ffmpeg`-based audio path (not `sox rec`) — see `start.sh` |
| sinain-core not picking up `.env` changes | Touch any source file (`touch sinain-core/src/index.ts`) or restart the process |
