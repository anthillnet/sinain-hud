# OpenClaw Setup for sinain-core

How to deploy an OpenClaw gateway and configure sinain-core to send escalations to it.

For the technical details of the escalation pipeline itself, see [ESCALATION.md](./ESCALATION.md).

## Prerequisites

- **Anthropic API key** — get one at <https://console.anthropic.com>
- **OpenClaw repo cloned** — `git clone <openclaw-repo-url>`
- For AWS: an AWS account with CloudFormation permissions and an EC2 key pair
- For local: Docker and Docker Compose

## 1. Deploy the OpenClaw Gateway

Pick one of two deployment paths.

### Option A: AWS (EC2 + CloudFormation)

The `aws/deploy.sh` script provisions an EC2 instance with the gateway pre-configured:

```bash
cd <openclaw-repo>
./aws/deploy.sh \
  --key-pair my-key \
  --api-key sk-ant-... \
  --gateway-token $(openssl rand -hex 24)
```

| Flag | Default | Description |
|------|---------|-------------|
| `--key-pair` | *(required)* | EC2 key pair name for SSH access |
| `--api-key` | *(required)* | Anthropic API key |
| `--gateway-token` | *(required)* | 48-char hex token for gateway auth |
| `--instance-type` | `t3.small` | EC2 instance type |
| `--region` | AWS CLI default | AWS region |
| `--ssh-cidr` | `0.0.0.0/0` | CIDR allowed for SSH |
| `--stack-name` | `openclaw-gateway` | CloudFormation stack name |

**Ports exposed:**

| Port | Protocol | Purpose |
|------|----------|---------|
| 18789 | WS + HTTP | Gateway WebSocket and HTTP hooks |
| 18790 | HTTP | Bridge HTTP API |
| 2222 | SSH | Container SSH access |

The stack creates an EFS volume mounted at `/mnt/openclaw-state` for persistent data.

After deployment, note the instance's public IP — you'll need it for the `OPENCLAW_WS_URL` below.

### Option B: Local Docker

```bash
cd <openclaw-repo>

# Create a .env file with required variables
cat > .env <<'EOF'
ANTHROPIC_API_KEY=sk-ant-...
OPENCLAW_GATEWAY_TOKEN=<your-48-char-hex-token>
EOF

docker compose -f docker-compose.openclaw.yml up -d
```

The gateway listens on `localhost:18789` (WS + HTTP) and `localhost:18790` (bridge). State is persisted in a Docker volume (`openclaw-state`).

**Optional env vars** (add to `.env` as needed):

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI provider access |
| `GEMINI_API_KEY` | Google Gemini provider access |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | AWS Bedrock provider access |
| `OPENCLAW_GATEWAY_PORT` | Override gateway port (default 18789) |

## 2. Configure sinain-core

Edit `sinain-core/.env` (copy from `.env.example` if you haven't yet):

```bash
cd <sinain-hud-repo>/sinain-core
cp .env.example .env
```

Set the OpenClaw variables:

```ini
# ── OpenClaw Gateway ──
OPENCLAW_WS_URL=ws://<gateway-ip>:18789       # or ws://localhost:18789 for local
OPENCLAW_WS_TOKEN=<your-48-char-hex-token>     # must match gateway-token from step 1
OPENCLAW_HTTP_URL=http://<gateway-ip>:18789/hooks/agent
OPENCLAW_HTTP_TOKEN=<hook-token>               # only needed if hooks use a separate token

OPENCLAW_SESSION_KEY=agent:main:sinain         # session routing key

# ── SITUATION.md ──
SITUATION_MD_PATH=~/.openclaw/workspace/SITUATION.md

# ── Escalation ──
ESCALATION_MODE=selective                      # off | selective | focus | rich
ESCALATION_COOLDOWN_MS=30000
```

### Variable reference

| Variable | Description |
|----------|-------------|
| `OPENCLAW_WS_URL` | Gateway WebSocket address. Use the EC2 public IP for AWS, `localhost` for local Docker. |
| `OPENCLAW_WS_TOKEN` | 48-char hex token. Must match the `--gateway-token` used at deploy time. |
| `OPENCLAW_SESSION_KEY` | Session routing key. Default `agent:main:sinain` routes to the main agent namespace. |
| `SITUATION_MD_PATH` | Where sinain-core writes the SITUATION.md context file. Must point to the OpenClaw workspace dir for local deployments. Irrelevant for remote (context is sent inline via HTTP). |
| `ESCALATION_MODE` | `selective` — score-based, recommended for production. `focus` — every change triggers escalation. `rich` — enhanced context mode. `off` — disables escalation. |

See `.env.example` for the full list of all configuration variables.

## 3. How It Works

```
sinain-core (Mac)                        OpenClaw Gateway (AWS or local Docker)
─────────────────                        ─────────────────────────────────────

  Screen capture + Audio                   Agent (Claude)
       │                                        ▲
       ▼                                        │
  Relay Agent                                   │
   (digest)                                     │
       │                                        │
       ├──[1]── SITUATION.md ──────────►  Workspace (local only)
       │        (local only)                    │
       │                                        │
       ├──[2]── POST /hooks/agent ─────►  Gateway receives escalation
       │        (HTTP, works remote)       with inline context
       │                                        │
       │                                   Agent runs with SITUATION.md
       │                                   or inline context injected
       │                                        │
       └──[3]── agent.wait (WS RPC) ◄──  Agent response flows back
                    │
                    ▼
              HUD Overlay (Flutter)
```

1. **SITUATION.md (passive)** — Every relay tick writes a structured context file to `~/.openclaw/workspace/SITUATION.md`. OpenClaw reads this when an agent starts. Only works when both run on the same machine (or share a filesystem).

2. **HTTP hook (active)** — When escalation triggers (based on `ESCALATION_MODE`), sinain-core POSTs full context inline to the gateway. Works across networks.

3. **WebSocket response** — sinain-core waits for the agent's response via `agent.wait` RPC over the persistent WebSocket connection. The response is pushed to the HUD overlay feed.

## 4. Verification Checklist

Run these checks after setup to confirm everything is working:

### Gateway is reachable

```bash
# Install wscat if needed: npm i -g wscat
wscat -c ws://<gateway-ip>:18789
# Should connect (then get a challenge event). Ctrl+C to exit.
```

### SITUATION.md is being written

```bash
ls -la ~/.openclaw/workspace/SITUATION.md
# Should exist and have a recent timestamp after sinain-core runs a tick
```

### Escalations are flowing

```bash
# In sinain-core logs, look for:
grep '\[openclaw' ~/.sinain-core/traces/*.log

# Successful escalation shows:
#   [openclaw-ws] connected
#   [openclaw] escalation sent (runId: ...)
#   [openclaw] agent response received
```

### Agent receives context

Trigger an escalation (switch to `focus` mode temporarily) and check gateway logs:

```bash
# Switch to focus mode to force an escalation
curl -X POST http://localhost:9500/agent/config \
  -H 'Content-Type: application/json' \
  -d '{"escalationMode": "focus"}'

# Watch for the escalation in sinain-core output, then switch back
curl -X POST http://localhost:9500/agent/config \
  -d '{"escalationMode": "selective"}'
```

## 5. Troubleshooting

### Circuit breaker tripped (5 consecutive failures)

The WebSocket client stops reconnecting after 5 failures. Check that the gateway is running:

```bash
# AWS
ssh -p 2222 node@<gateway-ip> "openclaw gateway status"

# Local Docker
docker compose -f docker-compose.openclaw.yml logs openclaw-gateway
```

Restart sinain-core after fixing the gateway to reset the circuit breaker.

### SITUATION.md not updating

- Verify `SITUATION_MD_PATH` points to the correct directory
- Check that `~/.openclaw/workspace/` exists and is writable
- Confirm `SITUATION_MD_ENABLED` is not set to `false` (it defaults to `true`)

### WebSocket auth failures

```
[openclaw] auth failed: invalid token
```

Verify the token matches what the gateway expects:

```bash
# On the gateway machine
openclaw config get gateway.auth.token
```

This value must match your `OPENCLAW_WS_TOKEN` exactly.

### Hook returns 405

Hooks are not enabled on the gateway. Enable them in `openclaw.json`:

```json
{
  "hooks": {
    "enabled": true,
    "token": "your-hook-token"
  }
}
```

Restart the gateway after changing this config.

### No escalations in selective mode

The score threshold (>= 3) wasn't met. Common reasons:
- Digest doesn't contain error patterns (worth +3)
- No question phrases in audio transcripts (worth +2)
- Cooldown hasn't elapsed (default 30s)
- Same digest as last escalation (duplicate suppression)

Switch to `focus` mode to verify the pipeline works, then switch back.

See [ESCALATION.md](./ESCALATION.md) for the full scoring table and configuration reference.
