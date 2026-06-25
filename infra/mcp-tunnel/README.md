# Sinain MCP tunnel — Strato-side infra

Makes a user's **local** sinain-core MCP server reachable by **ChatGPT** at a
public, OAuth-secured URL `https://<handle>.mcp.sinain.com/mcp`. Design &
rationale: [`docs/DESIGN-CHATGPT-MCP-TUNNEL.md`](../../docs/DESIGN-CHATGPT-MCP-TUNNEL.md).

## Pieces (all on the Strato box)

| File | Runs as | Port (loopback unless noted) | Role |
|------|---------|------|------|
| `oauth-as.mjs` | `sinain-oauth-as` | 18797 | Accountless OAuth AS — `/pair`, `/authorize`, `/token`, `/.well-known/*`. CIMD + PKCE. Fronted by Caddy as `auth.sinain.com`. |
| `mcp-authz.mjs` | `sinain-mcp-authz` | 18796 | Caddy `forward_auth` — validates the JWT against the request Host; emits the `401 + WWW-Authenticate` discovery challenge. |
| `frps-device-authz.mjs` | `sinain-frps-authz` | 18798 | frps `NewProxy` plugin — authorizes tunnel registration by **device signature** (no shared frp secret in the app). |
| `frps` | `frps` | **7000 public**, 7080 loopback | Reverse-tunnel server; routes `<handle>.mcp.sinain.com` → the right `frpc`. |
| `lib.mjs` | — | — | Shared crypto/contract (handle derivation, EdDSA JWS, PKCE). Must match `sinain-core/src/mcp-tunnel/*`. |

Only **7000** (frp control) and **443** (Caddy) are public. Everything else is loopback.

## Auth model (why it's safe)

- **Tunnel registration** is authorized by an Ed25519 **device signature** sent as
  frp client metadata — no shared secret ships in the app, and a replay can only
  ever claim its *own* handle (`handle = base32(sha256(devicePubkey))[:16]`).
- **ChatGPT → MCP** is gated by OAuth (the only auth ChatGPT accepts). Each access
  token's `resource` claim is one handle; `mcp-authz` rejects cross-handle use.
- **Accountless**: the AS has no user DB. A device-signed `/pair` mints a short
  pairing code shown in the overlay; the user types it on the `/authorize` page,
  binding ChatGPT's token to that device.
- **"Off means off"**: toggling the harness off tears down `frpc` (the real kill
  switch — no tunnel to serve) and `/unpair` revokes refresh.

## Deploy

Prereqs on the box (already present per `docs/deploy/strato.md`): Caddy, certbot +
`python3-certbot-dns-cloudflare`, `/etc/letsencrypt/cloudflare.ini`, Node, and the
Cloudflare **grey-cloud (DNS-only)** A records `mcp.sinain.com`, `*.mcp.sinain.com`,
`auth.sinain.com` → `85.214.180.247`.

```bash
scp -i ~/.ssh/id_ed25519_strato -r infra/mcp-tunnel root@85.214.180.247:/root/
ssh -i ~/.ssh/id_ed25519_strato root@85.214.180.247
cd /root/mcp-tunnel
FRP_SHA256=<sha256 of frp_0.61.1_linux_amd64.tar.gz from the release page> ./deploy.sh
# review, then activate the Caddy site (validates before reload):
./deploy.sh --wire-caddy
```

`deploy.sh` is idempotent and **never reloads Caddy on an invalid config** (it
validates first), so it can't drop the live gateway WSS.

## Verify

```bash
curl -s https://auth.sinain.com/.well-known/oauth-authorization-server | jq .
# unauth MCP request must return the discovery challenge:
curl -si https://<handle>.mcp.sinain.com/mcp | grep -i www-authenticate
# full OAuth + tool-call flow: add the connector URL in ChatGPT (Developer Mode).
journalctl -u frps -u sinain-oauth-as -u sinain-mcp-authz -f
```

`node test-as.mjs` runs the AS flow offline (pair → authorize → token → refresh)
with a mock CIMD endpoint — no box required.

## Client side

`frpc` is bundled with the macOS app and provisioned by `sinain-hud-plugin/launcher.js`
(same rails as sck-capture). `sinain-core/src/mcp-tunnel/` derives the handle, runs the
device-signed `/pair`, and spawns/kills `frpc` with the harness toggle.
