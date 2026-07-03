# sinain.com download redirect (Cloudflare Worker)

A first-party, logged, bot-filtering 302 redirect for the macOS download button.

```
sinain.com/download/macos  →  302  →  newest macos-v* Sinain.dmg on GitHub
```

## Why

Client-side analytics (Umami) is blocked by the privacy-minded users Sinain
attracts, so real downloads by those users register **nothing** in Umami while
still bumping GitHub's bot-inflated `download_count`. This Worker sits in the
download path itself, so it counts **every** human (blockers can't stop a
navigation) and records the User-Agent so bots can be filtered out.

| Signal | Counts privacy/blocked humans? | Counts bots? | Per-request UA? |
|---|---|---|---|
| Umami `download-macos` | ❌ no (blockable) | ❌ no | n/a |
| GitHub `download_count` | ✅ yes | ❌ also counts them | ❌ no |
| **This Worker** | ✅ yes | flagged & separable | ✅ yes |

## Deploy (one-time — requires Cloudflare account access)

From `tools/download-redirect/`:

```bash
npm i -g wrangler            # if not installed
wrangler login              # or: export CLOUDFLARE_API_TOKEN=...

# 1. Create the counter store and paste its id into wrangler.toml:
wrangler kv namespace create DL_COUNTERS

# 2. Ship it:
wrangler deploy

# 3. Verify the route is live (expect a 302 to ...github.com/.../Sinain.dmg):
curl -sI https://sinain.com/download/macos | grep -i -E 'HTTP/|location'
```

> ⚠️ **Do not repoint the website button until the route above returns a 302.**
> The landing-page CTA must keep pointing at the direct GitHub URL until this
> Worker is confirmed live, or the download button will 404 in production.

## Read the numbers

```bash
# Cumulative real-vs-bot split:
wrangler kv key get --binding DL_COUNTERS "total:human"
wrangler kv key get --binding DL_COUNTERS "total:bot"
wrangler kv key get --binding DL_COUNTERS "total:all"

# A given day:
wrangler kv key get --binding DL_COUNTERS "day:2026-06-17:human"

# Live per-download detail (UA, referrer, country):
wrangler tail --format pretty
```

For durable detail beyond live tail, enable **Cloudflare Logpush** on the zone
to ship the `console.log` lines to R2/S3.

## After it's live

Repoint the landing-page CTA from the direct GitHub URL to
`https://sinain.com/download/macos`. That change also touches
`tools/site/set-dmg-link.sh` (its GitHub-URL rewrite/grep would otherwise fail
the Firebase deploy), so it's done as a coordinated follow-up — see the main
task notes.
