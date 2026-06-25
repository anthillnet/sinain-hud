# Design — ChatGPT ⇄ local sinain over a public MCP tunnel

**Status:** design, pre-implementation. **Date:** 2026-06-25.
**Owner:** geravant. **Decision basis:** the §0 findings below are verified against
OpenAI's live docs; the build choices (frp; accountless OAuth AS) are settled.

## Goal

Let a user connect **their ChatGPT** to **their own local sinain-core** so ChatGPT
can call the sinain MCP tools (`sinain_context`, `sinain_roi`, `sinain_memory_*`,
`sinain_respond`, …). ChatGPT is cloud-side; sinain-core is on the user's Mac behind
NAT. We bridge them with a reverse tunnel terminating at a public, branded HTTPS URL
under `sinain.com`, fronted by the existing Strato box, and we gate access with OAuth
because ChatGPT accepts nothing weaker.

Non-goals: Windows (the Windows client is retired — macOS only); multi-tenant SaaS
identity; exposing sinain to arbitrary third-party MCP clients (this design is
ChatGPT-shaped, though the AS is generic OAuth).

## 0. Findings that shape the design (verified 2026-06)

1. **ChatGPT MCP connector auth is OAuth-or-nothing.** The connector "Authentication"
   field accepts **OAuth** or **No authentication** only. OpenAI: *"ChatGPT does not
   support machine-to-machine OAuth grants … nor can it present custom API keys or
   customer-provided mTLS certificates."* → **No bearer-token/header paste.** Our MCP
   tools stream the user's **screen OCR**, so "No authentication" is unacceptable. We
   build OAuth.
2. **OAuth shape:** Authorization Code **+ PKCE (S256)**. ChatGPT attaches
   `Authorization: Bearer <token>` to MCP calls after the flow. The resource server
   must, when unauthenticated, return `401` with
   `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`
   so ChatGPT can discover the AS.
3. **Client registration:** **CIMD** (Client ID Metadata Documents) is OpenAI's
   recommended path — ChatGPT sends a hosted `client.json` URL as `client_id`, so the
   **AS needs no client-registration database**. DCR is the fallback; we support CIMD.
4. **Adoption gate (not infra):** custom MCP connectors live behind ChatGPT
   **Developer Mode** (beta) — on Plus/Pro for individuals, but on
   **Business/Enterprise/Edu an admin must enable it** workspace-wide. Document this as
   a user prerequisite; it is outside our control. (Connectors were renamed **"apps"**
   on 2025-12-17 — UI wording only.)

## 1. What already exists in the repo

- `sinain-mcp-server/index.ts` — MCP server proxying sinain-core (`localhost:9500`).
  Already has a **StreamableHTTP** transport on `localhost:9510/mcp`, stateful
  (session-id correlated). Startup log: *"tunnel this port over HTTPS for ChatGPT."*
- Harness gate: `chatgptHarnessEnabled` + `set_chatgpt_harness` runtime toggle, OFF by
  default (`sinain-core/src/index.ts:1545`, `:2468`). The `chatgpt_desktop` roster
  profile is already filtered behind it (`:1590`).
- Device identity: ED25519 keypair, `deviceId = fingerprintPublicKey(pubkey)`, at
  `~/.sinain/device-identity.json` (`escalation/openclaw-ws.ts:60`). **Reused** as the
  tunnel handle source and the tunnel-auth signer.

The client is wired to *expect* a tunnel. Nothing builds or runs one, and the MCP
endpoint has no auth. This design fills exactly those two gaps.

## 2. Architecture

```
ChatGPT (OpenAI cloud)
  │  ① OAuth (authorize at auth.sinain.com, PKCE)         ┌────────────────────────┐
  │  ② MCP calls: GET/POST https://<handle>.mcp.sinain.com/mcp   Authorization: Bearer <JWT>
  ▼                                                        │      STRATO BOX        │
Caddy :443  ── TLS terminate ──┐                           │   85.214.180.247       │
  • *.mcp.sinain.com           │ forward_auth → mcp-authz (loopback :18796): verify JWT,
  •  auth.sinain.com           │   scope==handle-from-Host; else 401 + WWW-Authenticate
  │                            └─ reverse_proxy → frps vhost :7080 (loopback)
  │                                                         │
  ├─ auth.sinain.com → AS (loopback :18797): /authorize /token /.well-known/* /pair
  │                                                         └────────────────────────┘
  ▼  frps control :7000 (public) ⇄ frpc  ── frp tunnel, TLS ──►  user's Mac
                                                  frpc → localhost:9510/mcp → localhost:9500
```

Plaintext exists only on each end's loopback (Caddy↔frps↔frpc legs are TLS;
frpc↔frps is `transport.tls.enable`). The box decrypts at Caddy to read the JWT and
route — unavoidable for auth. See §6 (Privacy).

## 3. Components to build

### 3.1 Tunnel — frp (`frps` on Strato, `frpc` bundled in the app)

**Why frp, not a hand-rolled relay:** a bespoke reverse-tunnel is permanent,
security-sensitive networking code we'd own forever (request correlation, SSE,
backpressure, auth surface). frp is battle-tested; frpc is a single Go binary that
rides the **exact macOS provisioning rails we already built for sck-capture** in #217
(version-pin, hash-check, notarize, self-heal). Windows is retired, so it's **one arch**
(`darwin/arm64`, + `darwin/amd64` if Intel still supported) — same platform as
sck-capture. frp upstream ships prebuilt darwin binaries; nothing to compile.

frp routes by **Host header**, so each user gets a **subdomain** (`<handle>`) — this is
why we need wildcard `*.mcp.sinain.com`, not a single path-routed host.

**`/etc/frp/frps.toml`** (new systemd unit):
```toml
bindPort = 7000               # public — frpc control connections land here
vhostHTTPPort = 7080          # loopback — Caddy proxies to this
subDomainHost = "mcp.sinain.com"
# Per-handle tunnel authorization via an HTTP server-plugin (below):
[[httpPlugins]]
name = "device-authz"
addr = "127.0.0.1:18798"
path = "/handle"
ops = ["NewProxy"]
```
Bind `vhostHTTPPort` to loopback; only `bindPort` 7000 is public (plus 443 via Caddy).

**Tunnel auth (frpc→frps) — device signature, no shared secret in the app.**
The naïve `auth.token` is a single shared secret; embedding it in the app makes it
extractable and lets anyone claim any subdomain. Instead, frpc sends its device
identity as proxy **metadata**, and an frps **server plugin** (`device-authz`,
loopback :18798, ~40 lines Node) authorizes each `NewProxy`:
- frpc config carries `metadatas.pubkey = <spki pem>` and
  `metadatas.sig = ed25519_sign(privkey, handle)`, with `subdomain = handle`.
- plugin checks: `handle == fingerprint(pubkey)` **and** `sig` verifies over `handle`.
- A static signature is fine: it proves "I hold this device key," which is exactly the
  authorization. A replay still only ever claims **its own** handle.

→ **No shared frp secret on clients, no minter for the tunnel.** Handle uniqueness =
device-key uniqueness; collisions are cryptographically impossible.

`handle = base32(sha256(devicePubkey))[0:16]` (lowercased, DNS-label-safe). Stable,
unguessable. The existing `deviceId` fingerprint is the input.

**`frpc` config** (written by sinain-core when the harness is ON):
```toml
serverAddr = "mcp.sinain.com"
serverPort = 7000
transport.tls.enable = true
metadatas.pubkey = "<spki pem>"
metadatas.sig    = "<base64 ed25519 over handle>"
[[proxies]]
name = "sinain-mcp"
type = "http"
localPort = 9510
subdomain = "<handle>"
```

### 3.2 DNS + TLS — wildcard `*.mcp.sinain.com`

- Cloudflare A records (we hold the DNS-edit token): `*.mcp.sinain.com` and
  `auth.sinain.com` → `85.214.180.247`. **Grey-cloud (DNS-only)** like `turn.sinain.com`.
- Wildcard cert via **certbot DNS-01 / Cloudflare** (the coturn pattern,
  `docs/deploy/strato.md:396`) **or** Caddy's Cloudflare DNS plugin with on-the-fly
  DNS-01. Recommend the Caddy DNS plugin so Caddy owns the whole `*.mcp` + `auth` cert
  lifecycle in one place. (`auth.sinain.com` can use plain HTTP-01.)

### 3.3 Caddy edge

Append to `/etc/caddy/Caddyfile`:
```
*.mcp.sinain.com {
    tls { dns cloudflare {env.CF_DNS_TOKEN} }     # wildcard needs DNS-01

    # Discovery doc — templated by the request Host (= <handle>.mcp.sinain.com)
    handle /.well-known/oauth-protected-resource {
        header Content-Type application/json
        respond `{"resource":"https://{host}","authorization_servers":["https://auth.sinain.com"]}` 200
    }

    handle /mcp* {
        forward_auth 127.0.0.1:18796 {            # mcp-authz: JWT check vs Host
            uri /verify
            copy_headers X-Mcp-Handle              # authz tells the backend the verified handle
        }
        reverse_proxy 127.0.0.1:7080 {             # frps vhost; preserve Host for frp routing
            header_up Host {host}
        }
    }
    handle { respond 404 }
}

auth.sinain.com {
    reverse_proxy 127.0.0.1:18797                  # the OAuth AS
}
```

**`mcp-authz`** (loopback :18796, small Node `forward_auth` service):
- Reads `Authorization: Bearer <JWT>` and the original Host.
- Verifies the JWT signature (AS public key), `exp`, and that the token's
  `resource`/`aud` claim == `https://<Host>` (i.e. token minted **for this handle**).
- Pass → `204` (+ `X-Mcp-Handle`). Fail/missing →
  `401 WWW-Authenticate: Bearer resource_metadata="https://<Host>/.well-known/oauth-protected-resource"`
  so ChatGPT auto-discovers the AS.

The local MCP server stays **auth-agnostic**: only edge-authorized traffic ever enters
the tunnel. Clean separation, and no auth code in the shipped app.

### 3.4 OAuth Authorization Server — `auth.sinain.com` (loopback :18797)

Accountless, device-pairing-code grant. A small Node service. **One signing key**
(Ed25519/RS256, persisted) + **one HMAC secret** (`as-secret`, persisted). The only
mutable state is a short-lived `pairing-code → handle` map (TTL ~10 min, in-memory;
loss on restart just means re-pair).

Endpoints:
- `GET /.well-known/oauth-authorization-server` — metadata: `issuer`,
  `authorization_endpoint`, `token_endpoint`, `response_types_supported:["code"]`,
  `code_challenge_methods_supported:["S256"]`,
  `client_id_metadata_document_supported: true` (CIMD).
- `POST /pair` — **device-authenticated** (sinain-core posts `{pubkey, sig over
  nonce+ts}`). AS verifies the Ed25519 signature, derives `handle = fingerprint(pubkey)`,
  mints a short human-typable **pairing code** (e.g. 8 chars base32), stores
  `code→handle` with TTL, returns `{code, expiresIn}`. The overlay displays it.
- `GET /authorize` — params from ChatGPT: `client_id` (CIMD URL), `redirect_uri`,
  `code_challenge`, `state`, `resource` (= `https://<handle>.mcp.sinain.com`). AS fetches
  & trusts the CIMD doc (OpenAI-hosted https) to validate `redirect_uri`. Renders a
  minimal consent page: *"Enter the pairing code shown in your Sinain overlay."* On a
  correct code whose `handle` matches `resource`'s subdomain → issues a **signed,
  stateless auth code** (JWT, ~60s) binding `{handle, code_challenge, redirect_uri}` →
  302 back to `redirect_uri` with `code` + `state`.
- `POST /token` — Authorization Code + PKCE: verify `code` signature/expiry, verify
  `SHA256(code_verifier) == code_challenge`, verify `redirect_uri` match → issue
  **access token = JWT** `{ iss, resource: https://<handle>.mcp.sinain.com, scope:"mcp",
  exp ~1h }` signed by the AS key, plus a rotating refresh token. `mcp-authz` validates
  these.

CIMD removes the client DB; signed auth codes remove auth-code storage; only the
pairing map is stateful and ephemeral. The whole AS is a few hundred lines and mirrors
the HMAC/minter pattern already running on the box for TURN.

### 3.5 Client wiring (sinain-core + launcher)

- **`launcher.js`** — provision `frpc` (version-pinned, hash-checked, notarized,
  self-heal) in the **same block as sck-capture** (#217 machinery).
- **sinain-core** — on harness **ON**:
  1. ensure the MCP server runs with `MCP_TRANSPORT=http` on :9510;
  2. compute `handle` from the device pubkey; `POST /pair` (device-signed) → pairing code;
  3. write the `frpc` config (§3.1) and spawn `frpc` as a managed child;
  4. push `{connectorUrl: https://<handle>.mcp.sinain.com/mcp, pairingCode, expiresIn}`
     to the overlay via WS state.
  On harness **OFF**: kill `frpc`, stop the HTTP MCP transport, clear the WS state →
  the tunnel and the public URL disappear.
- **Overlay** — the existing harness toggle reveals a panel with the **connector URL**
  and **pairing code** (copy buttons), plus a one-line "ChatGPT → Settings → Connectors
  → add custom connector" hint and the Developer-Mode prerequisite (§0.4).

## 4. End-to-end flow

1. User flips the ChatGPT harness ON in overlay settings.
2. sinain-core starts the HTTP MCP transport + frpc; tunnel registers
   `<handle>.mcp.sinain.com` (device-sig authorized). Overlay shows the connector URL +
   pairing code.
3. User adds the connector URL in ChatGPT (Developer Mode), auth = OAuth.
4. ChatGPT hits `/mcp` unauthenticated → `401 + WWW-Authenticate` → discovers
   `auth.sinain.com` → runs Authorize (PKCE). The authorize page asks for the pairing
   code; user pastes what the overlay shows.
5. AS issues a JWT scoped to `<handle>`; ChatGPT calls `/mcp` with the bearer; `mcp-authz`
   validates scope==handle; Caddy proxies through frps→frpc→:9510→:9500. ChatGPT now
   reads sinain context / ROIs / memory and can `sinain_respond`.

## 5. Security model & hardening

- **No shared secret in the app.** Tunnel auth = device Ed25519 signature; AS auth =
  device-signed `/pair`. Both prove device-key possession; neither is replayable into
  another user's handle.
- **OAuth scoping.** Each access-token's `resource` claim is one handle; `mcp-authz`
  rejects a token used against any other handle's Host.
- **Tunnel is ephemeral.** frpc runs only while the toggle is ON; OFF removes the public
  surface entirely.
- Bind `vhostHTTPPort` (7080), `mcp-authz` (18796), AS (18797), and the frps plugin
  (18798) to **loopback**; only 7000 (frp control) + 443 (Caddy) are public.
- Short JWT TTL + rotating refresh; rotate the AS signing key on a schedule.
- Rate-limit `/pair` and `/authorize`; pairing codes single-use + TTL.
- Validate `<handle>` strictly (`^[a-z2-7]{16}$`); reject malformed subdomains at the edge.
- frp `transport.tls.enable` so the client↔box leg is encrypted on the wire.

## 6. Privacy

The box terminates TLS at Caddy and therefore sees **plaintext MCP traffic** — which is
exactly the screen context the user is **choosing to send to OpenAI anyway**. It is
self-hosted, in-house, and flows **only while the toggle is ON**. This is a weaker
guarantee than the TURN relay (which forwards opaque DTLS ciphertext,
`strato.md` §"Privacy model") — call it out honestly in user-facing copy. The **AS sees
no screen content** — only pairing/identity metadata. The MCP server already strips
`<private>` tags (`sinain-mcp-server/index.ts:31`), so redaction still applies on the
tunneled path.

## 7. Build phases

1. **Tunnel skeleton** — frps unit + wildcard cert + Caddy `*.mcp` site + frpc bundling.
   Raw tunnel reachable (auth OFF, **internal test only — never ship this state**).
2. **AS + edge auth** — `auth.sinain.com` AS (CIMD, PKCE, pairing) + `mcp-authz`
   forward_auth + `device-authz` frps plugin. Secured end-to-end.
3. **Client UX** — launcher frpc provisioning + sinain-core harness wiring + overlay
   panel (connector URL + pairing code).
4. **Docs + hardening + release** — add a "ChatGPT connector" runbook to `strato.md`,
   the hardening checklist, and bump `RELEASE_VERSIONS.json` (overlay + npm + the new
   frpc-bearing component) when Phase 3 ships.

## 8. Open items

- **Intel Macs:** confirm whether `darwin/amd64` frpc is still required or arm64-only.
- **AS pairing-code state:** in-memory is fine to start; revisit only if we run multiple
  AS replicas (single box → no).
- **Refresh-token UX:** decide TTLs (access ~1h / refresh ~30d?) and whether toggling the
  harness OFF should also revoke outstanding tokens (recommended: yes — OFF means off).
- **Cost tracking:** ChatGPT-driven tool calls hit sinain-core like any client; no extra
  LLM spend on our side, so no CostTracker change needed.

## References
- OpenAI — Developer mode, apps & full MCP connectors (Help Center).
- OpenAI Developers — Building MCP servers for ChatGPT (auth: OAuth, CIMD, PKCE).
- `docs/deploy/strato.md` — Caddy, certbot DNS-01, TURN minter patterns reused here.
