# Installing sinain with Local OpenClaw

Run the entire sinain stack — including the OpenClaw agent gateway — on your Mac. No cloud VM, no Docker, no SSH tunnels. Everything communicates over localhost.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| macOS 13+ (Ventura) | Required for ScreenCaptureKit screen capture |
| Node.js 22+ | For sinain-core, openclaw gateway, and plugin installer |
| npm | Used to install `openclaw` globally |
| Python 3.9+ | For sense_client screen pipeline |
| Flutter 3.27+ | Only for development — pre-built overlay available via `sinain setup-overlay` |
| Anthropic API key | Used by OpenClaw gateway for the agent — configured in `auth-profiles.json` |
| OpenRouter API key | Free at [openrouter.ai](https://openrouter.ai) — optional if using local vision (Ollama) + local whisper |
| Ollama | Optional — for local vision AI without cloud API. Install: `brew install ollama && ollama pull llava` |
| Microphone + Screen Recording permissions | System Settings → Privacy & Security → Microphone / Screen Recording |

---

## Architecture overview

```
Mac (all localhost)
──────────────────────────────────────────
openclaw gateway (port 18789, native Node.js)
  └─ sinain-hud plugin
       └─ sinain-knowledge (memory, playbook, eval)

sinain-core (port 9500) ←→ ws://localhost:18789
  ↓
overlay (private HUD)
sense_client (OCR pipeline)
sck-capture (audio + screen)

Ollama (port 11434, optional)
  └─ llava / moondream (local vision + text analysis)
```

- **OpenClaw gateway** — native Node.js process on port 18789; runs the Claude agent with sinain plugin, memory, playbook, and evaluation
- **sinain-core** — central hub (port 9500); manages audio, screen context, and the agent connection; uses Ed25519 device identity for scope-gated auth
- **overlay** — macOS private HUD; invisible to screen capture via `NSWindow.sharingType = .none`
- **sense_client** — Python pipeline that detects screen changes and sends OCR'd text to sinain-core
- **sck-capture** — Swift binary (ScreenCaptureKit); captures screen frames and system audio simultaneously

---

## Quick start (automated)

```bash
git clone https://github.com/anthillnet/sinain-hud
cd sinain-hud
./setup-local.sh
```

The wizard handles everything: API keys, gateway install, plugin setup, `.env` config, optional snapshot restore, then launches sinain.

The wizard asks 6 things:

| Prompt | What to enter |
|---|---|
| **[1/6] OpenRouter API key** | Your key from [openrouter.ai](https://openrouter.ai) — optional if using local vision + whisper |
| **[2/6] Audio transcription** | `a` for cloud (OpenRouter), `b` for local Whisper (~1.5 GB download) |
| **[2b/6] Local vision** | Optional — detects/installs Ollama + pulls llava model for local screen understanding |
| **[3/6] Install & start gateway** | Automatic — installs `openclaw` via npm if needed, starts the gateway, installs the sinain plugin |
| **[4/6] Verify Anthropic auth** | Checks if your Anthropic API key is configured in `auth-profiles.json` |
| **[5/6] Snapshot backup repo** | Optional — private GitHub repo URL to backup knowledge snapshots (playbook, modules, eval). Leave blank to skip. |
| **[6/6] Restore snapshot** | If you have a knowledge snapshot at `~/.sinain/knowledge-snapshots/`, optionally restore it |

After the wizard completes, sinain launches automatically.

---

---

## Local Vision (Ollama)

sinain can use [Ollama](https://ollama.com) for local vision AI instead of OpenRouter. This enables fully private operation — no screen data leaves your machine.

### Automatic (via setup wizard)

The `setup-local.sh` wizard detects Ollama and offers to enable local vision automatically. If Ollama isn't installed, it offers to install it via Homebrew.

### Manual setup

```bash
# 1. Install Ollama
brew install ollama

# 2. Pull a vision model
ollama pull llava

# 3. Add to your .env
echo "LOCAL_VISION_ENABLED=true" >> .env
echo "LOCAL_VISION_MODEL=llava" >> .env

# 4. Start with local transcription + local vision
./start-local.sh
```

Startup confirms local vision:
```
[local]   vision:   Ollama (llava) — local
```

### Available models

| Model | Size | Speed (warm) | Quality | Best for |
|-------|------|-------------|---------|----------|
| `llava` | 4.7 GB | ~2s/frame | Good | General use (recommended) |
| `llama3.2-vision` | 7.9 GB | ~4s/frame | Best | Maximum accuracy |
| `moondream` | 1.7 GB | ~1s/frame | Fair | Low-memory machines |

### Privacy mode compatibility

When local vision is enabled, sinain routes **all** agent analysis through Ollama — both vision (with images) and text-only ticks. OpenRouter is only used as a fallback when Ollama fails.

| Privacy Mode | Vision source | Fallback |
|-------------|---------------|----------|
| `off` | OpenRouter (cloud) | — |
| `standard` | OpenRouter (cloud) | — |
| `strict` | Ollama if enabled, else OpenRouter | OpenRouter |
| `paranoid` | **Ollama only** (cloud blocked) | None — fully local |

With `PRIVACY_MODE=paranoid` and `LOCAL_VISION_ENABLED=true`, zero data leaves your machine.

---

## Manual steps (reference)

Skip this section if you ran the wizard above. These steps explain what `setup-local.sh` does under the hood.

### 1. Install the openclaw CLI

```bash
npm install -g openclaw
```

### 2. Configure gateway

```bash
mkdir -p ~/.openclaw

# Patch openclaw.json (or create it) — gateway.mode=local is required
python3 -c "
import json, os
path = os.path.expanduser('~/.openclaw/openclaw.json')
cfg = json.load(open(path)) if os.path.exists(path) else {}
cfg.setdefault('gateway', {})['mode'] = 'local'
cfg['gateway'].setdefault('auth', {})['mode'] = 'token'
cfg.setdefault('agents', {}).setdefault('defaults', {}).setdefault('sandbox', {})['sessionToolsVisibility'] = 'all'
cfg['agents']['defaults'].setdefault('compaction', {})['mode'] = 'safeguard'
json.dump(cfg, open(path, 'w'), indent=2)
"
```

### 3. Configure Anthropic API key

The gateway reads API keys from `auth-profiles.json`, not from environment variables or `openclaw.json`.

```bash
# Option A: use the interactive configurator
openclaw config

# Option B: create the file manually
mkdir -p ~/.openclaw/agents/main/agent
cat > ~/.openclaw/agents/main/agent/auth-profiles.json << 'EOF'
{"profiles":[{"provider":"anthropic","apiKey":"sk-ant-YOUR-KEY-HERE"}]}
EOF
```

### 4. Start the gateway

```bash
openclaw gateway --bind loopback --port 18789 --force &
```

Wait for it to be healthy:
```bash
for i in $(seq 1 60); do
  curl -sf http://localhost:18789/healthz && break
  sleep 1
done
```

### 5. Install sinain plugin

```bash
openclaw plugin install @geravant/sinain
```

This installs the sinain-hud plugin, deploys HEARTBEAT.md and SKILL.md, and patches `openclaw.json` with plugin config.

### 6. Extract auth token

```bash
python3 -c "
import json
d = json.load(open('$HOME/.openclaw/openclaw.json'))
print(d.get('gateway',{}).get('auth',{}).get('token',''))
"
```

If this prints nothing, wait a few more seconds for the gateway to initialize and retry.

### 7. (Optional) Restore knowledge snapshot

If you have a knowledge snapshot repo at `~/.sinain/knowledge-snapshots/`:

```bash
npx tsx sinain-hud-plugin/sinain-knowledge/deploy/cli.ts \
  snapshot restore HEAD --workspace ~/.openclaw/workspace
```

### 8. Configure sinain-core/.env

Create or update `sinain-core/.env`. If the file already exists, remove any existing lines for these keys first to avoid duplicates:

```bash
OPENROUTER_API_KEY=sk-or-...
TRANSCRIPTION_BACKEND=openrouter      # or "local" if using Whisper
OPENCLAW_WS_URL=ws://localhost:18789
OPENCLAW_HTTP_URL=http://localhost:18789/hooks/agent
OPENCLAW_WS_TOKEN=<48-char hex token from step 6>
OPENCLAW_HTTP_TOKEN=<48-char hex token from step 6>
OPENCLAW_SESSION_KEY=agent:main:sinain
SINAIN_SNAPSHOT_REPO=git@github.com:yourname/sinain-snapshots.git  # optional
```

> **Note:** `ANTHROPIC_API_KEY` is NOT needed in sinain-core's `.env` — it's only used by the gateway, configured in `auth-profiles.json`.

> `OPENCLAW_SESSION_KEY` must be exactly `agent:main:sinain` — the sinain plugin on the server is registered under this key.

### 9. Launch

```bash
./start.sh
```

---

## Verifying the installation

1. **Health check**:
   ```bash
   curl http://localhost:9500/health
   # → {"ok":true,...}
   ```
2. **Gateway connected** — in the health response, check `escalation.gatewayConnected: true`
3. **Agent responding** — after ~10–20 seconds, `escalation.totalResponses` should be > 0
4. **Overlay appears** — a small HUD window should be visible on your screen
5. **End-to-end test** — speak a sentence or show text on screen; the overlay should update within ~10 seconds

---

## Updating

**Update the sinain plugin**:
```bash
openclaw plugin install @geravant/sinain
```

**Update sinain-core**:
```bash
cd sinain-hud && git pull && ./start.sh
```

**Update the gateway**:
```bash
npm update -g openclaw
```

---

## Stopping / restarting

```bash
# Stop sinain (Ctrl-C in the start.sh terminal, or):
pkill -f "tsx watch" ; pkill -f sense_client

# Stop the gateway:
pkill -f "openclaw gateway"

# Restart the gateway:
pkill -f "openclaw gateway"
openclaw gateway --bind loopback --port 18789 --force &
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No API key found for provider "anthropic"` | Check `~/.openclaw/agents/main/agent/auth-profiles.json` has a valid Anthropic key |
| `gateway.mode` errors | Ensure `"gateway": {"mode": "local"}` is set in `~/.openclaw/openclaw.json` |
| `missing scope: operator.admin` | sinain-core 1.0.x+ uses device identity (auto-handled); ensure you're on latest sinain-core |
| `workspace not initialized` | Run `openclaw plugin install @geravant/sinain` to initialize the workspace |
| Port 18789 already in use | Check `lsof -i :18789` — kill the existing process or use a different port |
| `gatewayConnected: false` in `/health` | Check tokens in `.env` match `~/.openclaw/openclaw.json` → `gateway.auth.token` |
| Token mismatch after plugin reinstall | Re-extract token from `openclaw.json` (step 6) and update `.env` |
| Plugin not loading | Check gateway logs: `openclaw gateway` runs in foreground to see errors |
| Snapshot restore fails | Ensure `~/.sinain/knowledge-snapshots/.git` exists and has commits |
| Screen OCR not working | Check **System Settings → Privacy & Security → Screen Recording** |
| Overlay not appearing | Check **System Settings → Privacy & Security → Accessibility** |
| `agent:main:sinain` session key mismatch | Verify `OPENCLAW_SESSION_KEY=agent:main:sinain` in `sinain-core/.env` |
| Camera blocked in Google Meet | Ensure you're using the `ffmpeg`-based audio path (not `sox rec`) — see `start.sh` |
| sinain-core not picking up `.env` changes | Touch any source file (`touch sinain-core/src/index.ts`) or restart the process |
| `Ollama 500: no slots available` | Ollama is busy processing a previous frame. sinain auto-skips and retries next tick. Normal at high FPS. |
| Vision shows "cloud (OpenRouter)" at startup | Set `LOCAL_VISION_ENABLED=true` in `.env` and restart |
| `local ollama failed` then falls back to OpenRouter | Ollama server may not be running. Start it: `ollama serve` |
| 401 "User not found" in paranoid mode | OpenRouter API key is invalid or revoked. With `LOCAL_VISION_ENABLED=true`, this is expected — Ollama handles everything. |
