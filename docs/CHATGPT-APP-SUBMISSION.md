# ChatGPT app submission — Sinain

Everything needed to submit Sinain to the ChatGPT app directory. Pairs with
[`DESIGN-CHATGPT-ACCOUNTS.md`](DESIGN-CHATGPT-ACCOUNTS.md) and
[`DESIGN-CHATGPT-MCP-TUNNEL.md`](DESIGN-CHATGPT-MCP-TUNNEL.md). Submit at
**platform.openai.com → apps**. Review ≈ 2 weeks; one version in review at a time.

## 0. Status checklist

| Item | State |
|---|---|
| Stable public HTTPS MCP endpoint | ✅ `https://mcp.sinain.com/mcp` |
| OAuth 2.1 (PKCE) per MCP spec | ✅ AS + Auth0 (`auth.sinain.com`) |
| Tool annotations (readOnly/destructive/openWorld) | ✅ all 8 tools |
| Data minimization (`<private>` strip + secret redaction) | ✅ in `sinain-mcp-server` + `sense_client` |
| Demo account → fixture device (reviewer access) | ✅ **live** (§6) — needs the Auth0 demo user (§6.1) |
| Developer identity/business verification | ⏳ **Igor** (platform.openai.com) |
| Privacy policy | ✅ `docs/privacy.html` → `https://sinain.com/privacy` (live on next site deploy) |
| Logo | ✅ `docs/logo-512.png` (existing brand asset) |
| Listing copy + test prompts | ✅ below |
| Screenshots | ✅ `docs/media/flow-demo-ux-redesign/flow-1…6.png` (retina HUD flow) |

## 1. Listing metadata

- **Name:** Sinain
- **Tagline:** Bring your live screen & work context into ChatGPT — privately, from your own machine.
- **Short description (≤ ~100 chars):** Connect ChatGPT to your own running Sinain to use your live screen, audio, and memory context.
- **Long description:**
  > Sinain is a privacy-first ambient context layer that runs on your Mac. With this
  > connector, ChatGPT can pull your *current* situation — what's on screen (OCR), recent
  > audio transcripts, the region you flagged for help, and your long-term knowledge —
  > straight from your own device, and write back notes or notifications to your overlay.
  > Nothing about your screen or audio is stored on Sinain's servers; the connector
  > relays it from your machine to your ChatGPT only while you have Sinain running and
  > the connector enabled.
- **Category:** Productivity / Developer tools
- **Auth:** OAuth (sign in with your Sinain account)
- **Screenshots (capture from the running app):** (1) the HUD overlay with a region eye, (2) the settings connector panel ("Connected as …"), (3) a ChatGPT thread calling `sinain_context`, (4) the Auth0 sign-in.

## 2. MCP server

- **URL (concrete, for review + listing):** `https://mcp.sinain.com/mcp`
- **Transport:** Streamable HTTP. **Auth:** OAuth 2.1 + PKCE; AS metadata at
  `https://mcp.sinain.com/.well-known/oauth-protected-resource` →
  `https://auth.sinain.com`. Login federates to Auth0.
- **Not a Template URL** — one fixed endpoint; the account (token `sub`) selects the
  user's device, so no `{placeholder}` is needed.

## 3. Tools (name · annotations · purpose)

| Tool | read-only | destructive | openWorld | Purpose |
|---|---|---|---|---|
| `sinain_context` | ✅ | – | ✗ | Current digest + context window (screen OCR, audio transcript, app history). |
| `sinain_roi` | ✅ | – | ✗ | The region the user flagged in the HUD (text + optional cropped screenshot). |
| `sinain_memory_query` | ✅ | – | ✗ | Hybrid retrieval over the user's local knowledge graph. |
| `sinain_get_escalation` | ✅ | – | ✗ | The pending escalation in the agent loop. |
| `sinain_health` | ✅ | – | ✗ | sinain-core health. |
| `sinain_memory_store` | ✗ | ✗ (idempotent) | ✗ | Add facts to the user's local knowledge graph (dedup'd). |
| `sinain_respond` | ✗ | ✗ | ✗ | Respond to a pending escalation. |
| `sinain_notify` | ✗ | ✗ | ✗ | Post a message to the user's HUD feed. |

All `openWorldHint: false` — every tool touches only the user's **own local** Sinain;
none reach external systems or create publicly-visible content.

## 4. Test prompts (for reviewers — expected against the demo account)

1. **"What am I currently working on?"** → calls `sinain_context`; returns the demo
   fixture's digest + context window (a sample coding session).
2. **"Help me with the area I flagged."** → calls `sinain_roi`; returns the fixture ROI
   (sample code snippet + cropped screenshot).
3. **"What do you remember about my project?"** → calls `sinain_memory_query`; returns
   sample facts from the fixture knowledge graph.
4. **"Remember that the launch date is July 10."** → calls `sinain_memory_store`; returns
   a stored-confirmation.
5. **"Post a reminder to my HUD to take a break."** → calls `sinain_notify`; returns posted.

## 5. Data handling / minimization

- The connector returns the user's **own** context to the user's **own** ChatGPT.
- `<private>`-tagged screen text is stripped (`sinain-mcp-server/index.ts` `stripPrivateTags`);
  `sense_client/privacy.py` auto-redacts credit cards, API keys, bearer/AWS tokens, passwords.
- **No** government IDs, health, or payment data is solicited; auth secrets are never returned.
- **Server-side storage is email + the account↔device map only** — never screen, audio,
  memory, or OCR. Those flow device → ChatGPT and are not persisted by Sinain.
- Relay (`mcp.sinain.com`) terminates TLS to route, but does not store payloads.

## 6. Demo account for reviewers (REQUIRED — build remaining)

OpenAI reviewers must *"log into a demo account with no further configuration"*. Since
real users' backends are their own Macs, we provide a **server-side fixture device**:

1. **Auth0:** create a demo user `demo@sinain.com` (password; no MFA/expiry).
2. **Fixture backend on the box:** a small MCP server returning realistic sample data for
   all 8 tools, fronted by an frpc that registers a fixed **fixture handle** (always online).
3. **AS seed:** `accounts.ensureDemo("auth0|<demo-sub>", "demo@sinain.com", <fixtureHandle>)`
   (the AS already supports `DEMO_FIXTURE_HANDLE`/`DEMO_EMAIL`). The demo account's token
   then resolves to the fixture handle → reviewers get sample responses with zero setup.

**Built & live** (`deploy-fixture.sh`): fixture-core (canned data) + the real
sinain-mcp-server + a box-side frpc registering the always-online fixture handle.
Verified: a demo-account token → `mcp.sinain.com/mcp` → `sinain_context` returns the
fixture's sample digest + context window.

### 6.1 Create the Auth0 demo user (Igor — dashboard)

The Regular Web App isn't authorized for the Auth0 Management API, so create the user in
the dashboard:
1. Auth0 → **User Management → Users → Create User**.
2. Email `demo@sinain.com`, a strong password (no MFA), Connection
   `Username-Password-Authentication`; mark **email verified**.
3. Put that email/password in the OpenAI submission's demo-account field. On the demo
   user's **first login**, the AS auto-links it to the fixture handle (email match), so
   the reviewer's tools return the fixture data with zero further setup.

(An interim test account currently holds the fixture link so the path is testable now;
the real demo login transfers it.)

### 9. Screenshots

**Available:** `docs/media/flow-demo-ux-redesign/flow-1…6.png` — retina captures of the
real HUD flow (the overlay is visible in these), e.g. flow-1 "Sinain highlights actionable
regions on the screen", flow-4 "CLI agent opens preseeded with the same knowledge". Use
these for the listing; they tell the region-highlight → context-enhance → agent-preseed
story. (Captioned for the demo; crop/use as-is.) A clean shot of the **settings connector
panel** ("Connected as …") is a nice optional add if you want one without a caption.

> Note for future shots: the HUD is normally capture-invisible (`sharingType = .none`);
> these were captured for the UX-redesign demo. To grab new ones, build with
> `sharingType = .readOnly`.

## 7. Privacy policy

**Done:** [`docs/privacy.html`](privacy.html) (styled to the marketing site;
[`PRIVACY.md`](PRIVACY.md) is the markdown source). It serves at
**`https://sinain.com/privacy`** once `docs/` is deployed (merge to main → Firebase).
Use that URL in the submission. **Logo:** `docs/logo-512.png` (existing).

## 8. Submission steps

1. Igor completes **identity/business verification** in the OpenAI Platform Dashboard.
2. Build the **demo fixture** (§6); create the Auth0 demo user.
3. Capture **screenshots**; finalize copy (§1).
4. Publish the **privacy policy** (§7).
5. platform.openai.com → apps → new submission: MCP URL `https://mcp.sinain.com/mcp`,
   OAuth, the §1 metadata, §4 test prompts, demo creds, privacy URL → submit → Case ID.
6. Address review feedback; resubmit if needed.
