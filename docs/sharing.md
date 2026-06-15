# Sharing concepts between machines

Sinain's web UI lets you share an entity page with another sinain user as a single link. The recipient pastes the link, and the entity page loads on their machine — no manual file step.

## How to share

1. Open an entity page at `/knowledge/ui/entity/<id>`.
2. Click **📤 Share** in the page header.
3. The URL is copied to your clipboard. A toast confirms what was copied.
4. Open `/knowledge/ui/shares` to see the share's status, copy the URL again, or revoke it.

## Two share modes

The Share button picks between two transports automatically based on bundle size — you don't choose.

### Fragment mode (≤ 6 KB)

Small entities (1–2 facts with all metadata) ride directly inside the URL itself: the entire concept bundle is gzipped, base64-encoded, and placed after the URL's `#`.

```
https://sinain.duckdns.org/share.html#e=ZmFjdDpmb28&p=9500&bundle=H4sIAAAAA…
```

The concept name, port, and bundle all live after the `#`, so the redirector's
host never receives any of them (see Privacy below). The `e=` value is the
base64url-encoded entity id — so the raw concept name isn't visible in the link
at a glance either.

| Property | Value |
|---|---|
| Source needs to be online when recipient opens | **No** — the data is in the URL itself |
| Time-limited | **No** — the link works forever |
| Revocable | **No** — anyone holding the URL can still import (the bundle is the URL) |
| Touches our redirector server | Yes, but it learns **nothing** — all share data is in the fragment (see Privacy below) |
| Touches any other server | No |

### Peer mode (> 6 KB)

Larger entities use WebRTC peer-to-peer transfer. The URL contains a peer ID (a 16-character random hex token), and the recipient's browser opens a direct connection to your browser through the **peerjs.com** public signaling cloud.

```
https://sinain.duckdns.org/share.html#e=ZW50aXR5OmZvbw&p=9500&peer=ab12cd34ef567890
```

| Property | Value |
|---|---|
| Source needs to be online when recipient opens | **Yes** — your browser tab needs to be open |
| Time-limited | Auto-expires after `SINAIN_SHARE_TTL_HOURS` (default 24h) |
| Revocable | **Yes** — clicking Revoke in the Shares view tears down the peer connection |
| Touches our redirector server | Yes, but it learns **nothing** — entity, port, and peer token are all in the fragment |
| Touches peerjs.com | Yes — but only the signaling handshake (SDP + ICE), not the bundle bytes |
| Touches any other server | No |

## Privacy

This is the part worth being precise about.

### Our redirector at `sinain.duckdns.org/share.html` sees nothing about the share

URL fragments — the part of a URL after `#` — are **never sent to servers by browsers**. This is part of the URI specification ([RFC 3986 §3.5](https://www.rfc-editor.org/rfc/rfc3986#section-3.5)) and is enforced consistently by every major browser.

Every piece of share data — the concept name, port, and bundle/peer token — lives in the fragment:

```
https://sinain.duckdns.org/share.html#e=ZmFjdDpmb28&p=9500&bundle=H4sIA…
                                      ┬ ──────────────────────────────────
                                      │ all stays in the browser
                          sent to our server: just "GET /share.html"
```

Our Caddy server only ever sees `GET /share.html` with an empty query string. The `#e=…&p=…&bundle=…` part is read by JavaScript inside your browser, used to construct the `location.href = "http://localhost:9500/knowledge/ui/entity/fact:foo#bundle=H4sIA…"` redirect, and decoded only by your local sinain-core's SPA. It never crosses the network to anything except the recipient's own machine.

What our redirector logs see (Caddy access logs, kept on the VPS):

| Field | Example |
|---|---|
| Timestamp | `2026-05-07T15:13:42Z` |
| Source IP | (recipient's public IP) |
| User-Agent | `Mozilla/5.0 …` |
| Method + Path | `GET /share.html` |
| Query string | **Empty** |
| Fragment | **Not present** (browsers never send it) |
| Body | None (GET request) |

We see "an IP loaded the redirector page" — nothing about *which* concept, the port, the facts, or any bundle content. (The entity id is base64url-encoded in the `e=` fragment param purely so it isn't readable at a glance in the link; the privacy guarantee comes from the fragment never being transmitted, not from the encoding, which is trivially reversible.)

> **Legacy links** created before this change carried `?entity=…&port=…` in the query string, which the host *did* log. The redirector still accepts that old format (so those links keep working), but new links emit the fragment-only form above.

### Peerjs.com signaling never sees the bundle

In peer mode, the bundle bytes flow over a WebRTC DataChannel directly between the sender's browser and the recipient's browser. peerjs.com brokers the handshake (SDP offer/answer + ICE candidates) but the application data is end-to-end between the two browsers.

What peerjs.com sees during a successful share:

- Peer IDs (16-char random hex tokens) of both sides
- SDP descriptions (codec parameters, supported features — no application content)
- ICE candidates (network paths, including each browser's public IP)
- Connection lifecycle events (open, close)

What peerjs.com does *not* see:

- The bundle JSON
- The entity name
- Anything you send through the DataChannel

This is the same threat model as Apple AirDrop, FaceTime, or Discord voice/video — the signaling broker sees who connected to whom, not what they exchanged.

If you want to avoid peerjs.com entirely, set `SINAIN_PEERJS_HOST` to a self-hosted peerjs broker. Bundle bytes still wouldn't transit the broker even on the public cloud.

### Existing redaction still applies

Both share modes use the same `concept_export.py` pipeline as the manual ⬇ Export button. That means the same redaction rules run before any bundle leaves your machine:

- `<private>`-tagged content is dropped entirely
- Credit cards, API keys, AWS keys, bearer tokens, GitHub tokens, JWT tokens, passwords, SSNs, and private-key headers are redacted
- The same rules apply to the rendered_page summary and section text, not just to fact values

The redaction list lives in `sinain-hud-plugin/sinain-memory/concept_export.py`.

## The Shares view

`/knowledge/ui/shares` shows every share you've created:

- **Status pill** — `waiting` (peer registered, no recipient yet), `connecting` (recipient picked up), `delivered` (bundle confirmed received), `disconnected` (peer connection dropped, e.g., your tab closed), `revoked` (you tore it down), `expired` (24h auto-expiry), `permanent` (fragment shares — they don't expire).
- **Copy URL** — re-copy the URL to clipboard.
- **Revoke** — for peer shares, tears down the peer connection (recipient gets "source offline"). For fragment shares, marks as revoked in your records but **the URL still works** for anyone who has it (the bundle is in the URL itself; nothing for the system to invalidate). The revoke confirmation dialog states this explicitly.
- **Forget** — removes the row from your local list. Does not affect the URL itself.

The header shows an active-share count badge so you can quickly see how many peer shares are still waiting.

## Resume across SPA refresh

Peer shares are persisted in `~/.sinain/memory/web.db` (in the `shared_docs` table) along with their peer ID. On SPA load, `ShareManager.resumePeerShares()` reads the table and re-binds each peer using the stored peer ID — closing your browser tab and reopening sinain *resumes* the active shares rather than ending them.

If your machine reboots, the SPA tab is gone but the share metadata persists in `web.db`. Open the SPA again and the peer registrations are re-established.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `SINAIN_SHARE_BASE_URL` | `https://sinain.duckdns.org/share.html` | Public redirector. Override to self-host. |
| `SINAIN_SHARE_INLINE_MAX_BYTES` | `6000` | Fragment-vs-peer threshold. Raw JSON bytes before gzip. |
| `SINAIN_SHARE_TTL_HOURS` | `24` | Auto-expiry for `waiting`/`disconnected` shares. |
| `SINAIN_PEERJS_HOST` | _(empty → peerjs.com cloud)_ | Override the peerjs signaling broker. |

## Troubleshooting

### Recipient sees the redirector page and stays there

The auto-redirect from HTTPS to `http://localhost:9500` may be blocked by recent browser policies (Chrome's Private Network Access in particular). The redirector page also shows a manual fallback after a short delay: a port input + retry button. This handles the case where the recipient runs sinain-core on a non-default port too.

If the issue is consistent across browsers, you can override `SINAIN_SHARE_BASE_URL` to a self-hosted redirector on the same origin as your sinain-core (e.g., a Caddy that proxies `localhost:9500/.../share.html` from disk) — that eliminates the cross-origin HTTPS→HTTP hop.

### "Source went offline" on a peer share

Sender's browser tab must be open for peer shares to work. Sender can re-register the peer by reopening the SPA — `resumePeerShares()` will bring it back online with the same peer ID, so any unchanged URL continues to work.

### NAT/firewall blocks the WebRTC connection

About 10–20% of peer pairs fail to connect because peerjs.com's free cloud is STUN-only (no TURN relay). The recipient sees a "couldn't connect" error after a 15s timeout. Workarounds:

- Both endpoints on the same LAN — usually works.
- Self-host a TURN server and configure peerjs to use it (not in v1, follow-up).
- Fall back to the manual ⬇ Export button — file transfer over Slack/email always works.

### URL was truncated by a chat tool

Some link previewers strip the part after `#` because they treat fragments as page anchors. If this happens, the recipient lands on the redirector page with a "Missing share data" message. Workaround: paste the URL as a code block (so the previewer doesn't touch it), or send via a tool that preserves URLs verbatim.

## Self-hosting the redirector

The redirector is a single static HTML file (`docs/share.html` in the repo). Caddy currently serves it on `sinain.duckdns.org`. To host your own:

1. Copy `docs/share.html` to your web server.
2. Make sure it's served with `Content-Type: text/html`.
3. Set `SINAIN_SHARE_BASE_URL=https://your-domain/share.html` in `.env`.

The page is dependency-free, runs entirely client-side, and can live behind any HTTPS host. There's no application logic on the server — only static-file serving.
