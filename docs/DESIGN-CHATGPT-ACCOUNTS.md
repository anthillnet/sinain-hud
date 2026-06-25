# Design — Sinain accounts (optional, ChatGPT-only)

**Status:** design + first implementation. **Date:** 2026-06-25.
Builds on [`DESIGN-CHATGPT-MCP-TUNNEL.md`](DESIGN-CHATGPT-MCP-TUNNEL.md). Adds a thin
identity layer so Sinain can ship as a **published ChatGPT app**: a user picks
"Sinain" in ChatGPT, logs in, and it routes to their own running machine.

## Why accounts (and why now)

The accountless device-pairing tunnel works, but it can't be a *published* ChatGPT
app: (a) the connector URL is per-user, and (b) OpenAI's review team must
*"log into a demo account with no further configuration required"* — impossible
when the MCP backend is each user's local Mac. Standard OAuth against **accounts**
fixes both: one connector, one login, and a demo account that maps to a hosted
fixture for reviewers.

## Principles (non-negotiable)

1. **Optional.** Accounts are required ONLY for the ChatGPT-connector path. Local
   use, escalation, gateway, and the existing device-pairing connector keep working
   with **no account**.
2. **Local-first preserved.** The only new server-side data is an **email + an
   account↔device map**. **No screen/audio/memory/OCR ever lands server-side** —
   MCP traffic still flows straight to the user's local device. Accounts are an
   *auth/routing* layer, never a data layer.
3. **Don't hand-roll auth.** Login (signup, email verification, magic-link, social,
   recovery, MFA) is delegated to a **managed IdP** over standard **OIDC**, so we own
   none of that security-sensitive surface. Vendor-neutral; any OIDC provider works
   (Auth0 / WorkOS / Stytch / Clerk). Examples below use Auth0 naming.

## Model

- **Account** = `{ id: "acct_<24hex>", email, idpSub, created }`. Nothing else.
- **Device** = the existing Ed25519 identity (`handle = base32(sha256(pubkey))[:16]`).
  New: a device may **link** to an account (`accountId ↔ handle`, many devices/account).
- **Online device** = a handle with a live frps proxy (frps already knows this).

## Token + routing change

Extends the single-endpoint design; only the token *subject* changes.

| | subject claim | edge routing |
|---|---|---|
| device-pairing (existing) | `sub = handle` | route straight to that handle |
| **account (new)** | `sub = acct_…` | resolve account → **online** device handle → route there |

Public URL is the single `https://mcp.sinain.com/mcp` for everyone; the per-handle
subdomains become **internal** routing only (`mcp-authz` resolves the handle and
Caddy sets the upstream `Host`). One account, many machines, always lands on
whichever Sinain is currently running.

## The IdP: federated, not fronted

Our AS (`auth.sinain.com`) stays the **OAuth Authorization Server ChatGPT talks to**
(MCP-spec: PKCE, CIMD — already built). It is also an **OIDC Relying Party to the
IdP**: at `/authorize` it redirects the user to the IdP to authenticate, gets back
`{ idpSub, email }`, resolves-or-creates the Sinain account, and issues the MCP token
with `sub = accountId`. ChatGPT never talks to the IdP directly; the IdP never sees
MCP traffic. Swapping IdPs is an OIDC config change (issuer + client id/secret).

```
ChatGPT ──OAuth──▶ auth.sinain.com /authorize
                      │  OIDC redirect
                      ▼
                   IdP (Auth0…) login  ──▶ /idp/callback
                      │  {idpSub,email} → account
                      ▼
                   issue MCP token  sub=acct_…  ──▶ ChatGPT
ChatGPT ──Bearer──▶ mcp.sinain.com/mcp ─▶ mcp-authz: acct → online handle ─▶ frps ─▶ user's frpc
```

## Flows

1. **Link device → account** (in the app, once; optional). Enabling the ChatGPT
   harness offers "Sign in to Sinain." The app opens `auth.sinain.com/device-link`
   with a device-signed challenge; the user logs into the IdP; the AS records
   `accountByDevice[handle] = accountId`. Skip it → keep the accountless pairing path.
2. **ChatGPT (published app).** As in the diagram: select Sinain → log in → use.
   The token's `sub` is the account; the edge routes to the account's online device.
3. **Demo (reviewers).** A seeded demo account → a **server-side fixture device**
   that's always "online" returning sample context/ROI/memory. Reviewers log in with
   the demo credentials and the tools work with zero config → passes OpenAI review.

## Storage

A small JSON store on the box at `${AS_KEY_DIR}/accounts.json` (atomic tmp+rename):
```
{ accounts: { acct_…: {email, idpSub, created} },
  devicesByAccount: { acct_…: [handle, …] },
  accountByDevice:  { handle: acct_… } }
```
Retention: email + map only, deletable on request. No content. (SQLite is a drop-in
later if scale warrants.)

## Coexistence

The single `mcp.sinain.com/mcp` endpoint serves **both** token kinds: a `handle`
subject routes directly (Developer-Mode users, no account); an `acct_` subject
resolves to the online device. The deployed `*.mcp.sinain.com` per-subdomain path
stays valid for back-compat. Nothing about escalation/gateway/local changes.

## Security & privacy

- IdP owns credentials; we store only email + the device map. The MCP `resource`
  claim is the shared host; cross-token misuse is still rejected by `mcp-authz`.
- Device→account link requires an Ed25519 device signature (proves device ownership)
  *and* an authenticated IdP session (proves account ownership).
- "Off means off" unchanged: the tunnel teardown is the kill switch; a revoked/offline
  account simply has no online device to route to → `503`.
- Privacy policy must state plainly: **Sinain stores your email and which devices are
  yours; it never receives your screen, audio, or memory** — those go from ChatGPT to
  your local device over the relay you run.

## Components

| Piece | File | Status |
|---|---|---|
| Account store | `infra/mcp-tunnel/accounts.mjs` | this change |
| OIDC adapter (+ stub) | `infra/mcp-tunnel/idp.mjs` | this change |
| AS account flow + `/link` | `infra/mcp-tunnel/oauth-as.mjs` | this change (behind `ACCOUNTS_ENABLED`) |
| Edge account→online resolution | `infra/mcp-tunnel/mcp-authz.mjs` | this change |
| Online-handle tracking + `/online` | `infra/mcp-tunnel/frps-device-authz.mjs` | this change |
| Account-flow test (stub IdP) | `infra/mcp-tunnel/test-accounts.mjs` | this change |
| Single-endpoint Caddy site | `infra/mcp-tunnel/Caddyfile.snippet` | follow-up (deploy) |
| App "Sign in to Sinain" UX | overlay/core | follow-up |
| MCP tool annotations | `sinain-mcp-server` | follow-up (publishing) |

## Gated on you (Igor)

- **Provision the managed IdP** (create the tenant, an OIDC app → issuer URL + client
  id/secret + callback `https://auth.sinain.com/idp/callback`). Until then the AS runs
  the **stub IdP** (`IDP_MODE=stub`) so the flow is testable end-to-end locally.
- **OpenAI developer identity/business verification** (publishing gate).
- **Host the privacy policy** at a sinain.com URL + a logo.
