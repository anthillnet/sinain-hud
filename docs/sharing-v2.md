# Sharing v2 — removing the mediator

Design note for making concept sharing fully peer-to-peer: eliminating the
`sinain.duckdns.org` redirector and, optionally, the peerjs.com signaling
cloud and the jsdelivr CDN. Status: **proposal — no code changed yet.**

## Goal

A share should involve **no infrastructure we operate** and, in the strictest
mode, **no third party at all**. Today's design already keeps bundle *content*
off every server (fragment trick + WebRTC DataChannel — see
[sharing.md](sharing.md)); what still leaks is *metadata*: who shared, what
entity name, which IPs, when.

Non-goals: sender/recipient identity or authenticity (bundles are unsigned
today; unchanged here), TURN relays for hostile NATs, multi-entity sync.

## Current architecture — three external touchpoints

```
SENDER (localhost:9500 SPA)                      RECIPIENT
   │                                                 │
   │ 1. sinain.duckdns.org/share.html  ◄─────────────┤  GET ?entity=foo&port=9500
   │    our VPS (Caddy): entity name, port,          │  (#fragment never sent)
   │    recipient IP, UA, timestamp                  │
   │                                                 │
   │ 2. peerjs.com cloud  ◄──────signaling──────────►│  >6KB shares: peer IDs,
   │    (SDP offer/answer + ICE)                     │  SDP, both public IPs
   │                                                 │
   │ 3. cdn.jsdelivr.net  ◄── peerjs@1.5.4 lib ─────►│  both sides, at runtime
   │                                                 │
   └────────── WebRTC DataChannel (bundle) ──────────┘
```

| # | Dependency | Role | Sees | Code |
|---|---|---|---|---|
| 1 | `sinain.duckdns.org/share.html` | HTTPS→localhost URL rewriter + install CTA | entity id, port, recipient IP/UA | `server.ts` `renderKnowledgeUiV2()` default; static page `docs/share.html` |
| 2 | peerjs.com cloud | WebRTC rendezvous for >6KB bundles | peer IDs, SDP, ICE (IPs both sides) | `ShareManager` in `server.ts` (`newPeer`, `createShare`) |
| 3 | cdn.jsdelivr.net | serves `peerjs.min.js` | request metadata; **can serve arbitrary JS** | `ensurePeerJsLoaded()` in `server.ts` |

### The key structural fact

**The recipient must already run sinain-core to import anything.** The entire
import pipeline (`#bundle=` ungzip → `POST /knowledge/concepts/import`,
`#peer=` → `connectAsRecipient`) lives in the recipient's own SPA
(`renderEntityPage` in `server.ts`). The redirector contributes nothing to
the transfer — it is a URL rewriter. A link of the form

```
http://localhost:9500/knowledge/ui/entity/<id>#bundle=H4sIA…
```

**already works today with zero mediator.** The redirector exists for three
soft reasons: (a) a clickable HTTPS link that doesn't look "broken" in chat,
(b) the install CTA for recipients who don't have sinain yet, (c) the port
input when the recipient's core isn't on 9500.

### Pre-existing defect found during this review (fix regardless of option)

`ensurePeerJsLoaded()` sets `crossOrigin = "anonymous"` and its comment
promises a pinned SRI hash — but **`s.integrity` is never assigned**. The CDN
(touchpoint 3) can currently inject arbitrary JS into the page that holds the
knowledge graph and the local API. Either add the SRI attribute or (better,
Option C) stop loading from a CDN at all.

## Options

### Option A — localhost-direct links (kills touchpoint 1)

Flip the default share URL from the redirector to the recipient's own core:

```
before  https://sinain.duckdns.org/share.html?entity=foo&port=9500#bundle=…
after   http://localhost:9500/knowledge/ui/entity/foo#bundle=…
```

- `SINAIN_SHARE_BASE_URL` keeps working as an *opt-in* (set it → old behavior,
  including any self-hosted redirector). Only the **default** changes:
  empty → localhost-direct instead of duckdns.
- Old links keep working forever (share.html stays deployed; nothing breaks).
- The `?port=` indirection disappears in the default mode. Port mismatch
  (sender on 9500, recipient on 9700) makes the link dead until the recipient
  edits the port in the URL — acceptable: non-default ports are an expert
  setting, and the Shares view can show a hint. Note the redirector can't be
  beaten here anyway: it only knows the *sender's* port too.
- Losses: install CTA for non-users, link previews. Mitigation: the share
  toast can offer "copy public link instead" when `SHARE_BASE_URL` is set.

Effort: ~10 lines in `renderKnowledgeUiV2()` + `buildShareUrl()`, docs.

### Option B — large-bundle transfer without peerjs.com (touchpoint 2)

WebRTC fundamentally needs *a* rendezvous channel when both peers are behind
NAT. Three sub-options, not mutually exclusive.

> **Important framing for huge chunks:** large bundles already use peer mode
> (WebRTC DataChannel) today, and that path **never touches our redirector**
> for bytes *or* signaling — bytes go browser-to-browser, signaling goes via
> peerjs.com. So **Option A alone removes `sinain.duckdns.org` from the
> huge-chunk path entirely.** Option B is only about replacing the *remaining*
> external party (peerjs.com) for those large transfers. See "Why can't the
> recipient send the answer automatically?" below before choosing B2 vs B3.

#### Why can't the recipient send the answer code automatically?

This is the crux, and it determines B2-vs-B3. To complete a WebRTC connection
the recipient must return an **SDP answer + ICE candidates** (its network
coordinates) to the sender. For the recipient's *client* to deliver that
automatically, it needs a network path to the sender — but the sender is
`localhost:9500` behind a NAT, **not addressable from the internet**.
Establishing that path is *exactly what the SDP exchange is for*. So you need
the connection to send the thing that creates the connection — a chicken-and-egg
that cannot be broken without a meeting point both machines reach unprompted.

There are exactly three ways to deliver the answer, no fourth:

1. **A rendezvous both reach unprompted** — a server, or a commodity
   content-blind relay (Nostr/BitTorrent). **Automatic.** This is B2. (It's a
   mediator, just not one *we* run.)
2. **The human carries it** (paste-back over the same chat that carried the
   link). **Zero infrastructure, manual.** This is B3 — the chat app is a real
   back-channel, but the client has no API into it, so the human is the
   transport.
3. **Reuse the delivery channel programmatically** — only if that app exposes
   an API the client can call (e.g. a Telegram bot). Re-introduces that app as
   a third party; out of scope.

**"Automatic" and "zero rendezvous" are mutually exclusive for NAT'd peers** —
a property of internet addressing, not a sinain limitation. Therefore: **for
huge chunks delivered automatically, B2 is the answer, not B3.** B3 is only
correct when literally-zero-third-parties outranks the manual step (e.g. the
LAN/offline case, where no rendezvous is needed at all because host candidates
reach directly).

#### B1. Raise the fragment threshold (make peer mode rare)

`SINAIN_SHARE_INLINE_MAX_BYTES` is 6000 **raw** bytes; after gzip+base64url a
6KB bundle is a ~2.5–3KB URL. The binding constraint is the delivery channel,
not the browser (Chrome handles >1MB URLs; Safari ~64KB):

| Channel | Practical URL limit |
|---|---|
| Telegram message | 4096 chars total |
| Slack message | 4000 chars (40k for snippets) |
| WhatsApp / iMessage / email | effectively unlimited (>60KB) |
| QR code | ~3KB |

A modest default raise (6000 → 16000 raw ≈ 6–8KB URL) keeps Telegram/Slack
borderline but makes WhatsApp/email/iMessage shares serverless for the vast
majority of single-entity bundles. Could be smarter: try fragment first, show
URL length in the toast, let the user fall back to peer mode if their channel
chokes. Effort: config default + toast copy.

#### B2. Decentralized rendezvous (Trystero)

Replace peerjs with [Trystero](https://github.com/dmotz/trystero) (MIT,
~10KB), which brokers WebRTC over commodity, content-blind public
infrastructure — Nostr relays (default), BitTorrent trackers, MQTT, or IPFS.
The share token becomes the room name; bundle bytes flow over the same
DataChannel as today.

- No server *we* operate; no account anywhere; relays are interchangeable and
  multi-homed (it announces to several at once, so no single relay sees all
  handshakes — and none sees content).
- Same NAT success profile as today (STUN-only; ~80–90%).
- Still "a third party saw two IPs meet in a random-named room" — better than
  one fixed company (peerjs.com), not zero.
- Effort: medium — replace `ensurePeerJsLoaded`/`newPeer`/connect plumbing on
  both sender and recipient paths; vendor the lib (see C); keep the
  `shared_docs` lifecycle as-is (token, statuses, resume all transfer 1:1).

#### B3. Two-paste manual signaling (zero third parties)

Serverless WebRTC by carrying the SDP in the share artifacts themselves:

1. Sender clicks Share → core creates an `RTCPeerConnection`, waits for ICE
   gathering to complete (non-trickle), gzips the **offer** into the link:
   `http://localhost:9500/knowledge/ui/entity/foo#offer=…`
2. Recipient opens the link → their SPA generates the **answer**, shows it as
   a short copyable code.
3. Recipient sends that code back over whatever channel carried the link;
   sender pastes it into the Shares view → DataChannel opens, bundle flows.

- **No third party, ever.** On a shared LAN it works with host candidates
  alone — fully offline. Over the internet it needs a STUN lookup (stateless,
  content-blind, any public server) for the reflexive address.
- UX cost: one extra paste-back step, and the sender must be at their machine
  during the exchange (offers embed candidates, so long-lived "waiting"
  shares need re-issue — SDP doesn't expire per se but NAT bindings do).
- Effort: medium — no library needed at all (raw RTCPeerConnection is ~80
  lines for this flow); replaces peerjs entirely in this mode.

### Option C — vendor the WebRTC lib (kills touchpoint 3)

Whatever B decides, stop loading JS from jsdelivr at runtime: ship
`peerjs.min.js` (or trystero) inside sinain-core and serve it from
`/knowledge/ui/assets/`. Removes the CDN from both threat and availability
models, fixes the missing-SRI hole as a side effect, and makes peer shares
work in CDN-blocked networks. (B3 needs no library at all — strongest form.)

## Comparison

| | duckdns sees | peerjs.com sees | CDN risk | Works offline/LAN | UX cost |
|---|---|---|---|---|---|
| Today | entity, port, IPs | IPs, peer IDs | yes (no SRI) | no | — |
| A + C | **nothing** | IPs, peer IDs (large only) | **gone** | fragment: yes | none |
| A + B1 + C | **nothing** | rare | **gone** | mostly | URL length |
| A + B2 + C | **nothing** | **gone** (Nostr relays see IPs meet) | **gone** | no | none |
| A + B3 + C | **nothing** | **gone** (nothing at all) | **gone** | **yes** | paste-back step |

## Recommendation & phasing

**Primary use case is huge chunks shared automatically.** That rules out
fragment mode (B1 can't carry them) and rules out B3 as the *default* (manual
paste-back). Huge chunks need peer mode + an automatic rendezvous; the only
question is whose. So:

1. **Phase 1 (this iteration): A + B2 + C.**
   - **A** — localhost-direct links by default; `sinain.duckdns.org` exits the
     path entirely (it was never in the byte/signaling path for peer mode
     anyway — only the clickable-link rewrite).
   - **B2** — replace peerjs.com with Trystero over Nostr: huge chunks transfer
     **automatically** (no paste-back) over a decentralized, content-blind
     rendezvous we don't operate. The share token → room name; the existing
     `shared_docs` token/status/resume lifecycle ports 1:1.
   - **C** — vendor the lib so no CDN can inject JS into the graph page.
   - Net: **no infrastructure we run, and no fixed company**, for arbitrarily
     large shares, with today's automatic UX preserved.
2. **Phase 2: B3 as an optional "fully offline / zero-third-party" toggle.**
   Wins the LAN/colleague and air-gapped cases (no rendezvous needed — host
   candidates connect directly), at the cost of the paste-back step. Not the
   default precisely because it's manual.
3. **B1 (raise fragment cap) is a cheap independent win** for *small* shares —
   ship it alongside Phase 1 so small concepts stay link-only, but it does not
   address the huge-chunk requirement.

`SINAIN_SHARE_BASE_URL`, `SINAIN_PEERJS_HOST`, `SINAIN_SHARE_INLINE_MAX_BYTES`
all keep their semantics; only defaults move (and `SINAIN_PEERJS_HOST` is
superseded by a Trystero relay-list var under B2). The duckdns redirector
stays up for old links until usage hits zero, then retires with the Caddy
block.

## Open questions

- Should the Share button expose mode choice (local / public / offline) or
  stay automatic on size? Leaning: automatic, with an "options" affordance in
  the toast.
- Signed bundles (sender authenticity) — orthogonal, but B3's paste-back step
  is a natural place to bind a fingerprint if we ever want it.
- `recipient_hint` column in `shared_docs` is unused by the UI — could label
  who a share was for, which matters more once links look like opaque
  localhost URLs.
