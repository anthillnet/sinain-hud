# download-redirect

Cloudflare Worker behind `https://sinain.com/download` — the site's DMG
download CTA. It 302s to the current `Sinain.dmg` on GitHub Releases and logs
every hit, giving trustworthy download stats.

## Why

GitHub's asset `download_count` is an unfilterable all-time total: link
scanners (Facebook, Safe Browsing deep-scan, AV gateways), `curl`-style bots,
and partial range requests all increment it (verified empirically — only HEAD
requests are excluded, and the counter updates in ~15-min batches). Observed
inflation on FB-campaign traffic: ~3–4 counted fetches per real human click.

## What it does

- Resolves the DMG version at request time: `RELEASE_VERSIONS.json` on main
  is the pin; if that version's DMG isn't published yet, falls back to the
  newest published `macos-v*` release (same contract as the retired
  `tools/site/set-dmg-link.sh`). Cached 5 min. Releases need no site
  re-deploy and no CTA bump.
- Logs one Workers Analytics Engine row per request: user-agent, referer,
  country, resolved tag, and a kind classification — `human`, `bot`, or
  `updater` (the in-app self-update, UA `sinain-hud-updater/<ver>`).
  **No IPs stored.**
- `?tag=macos-vX.Y.Z` pins the redirect to an exact release (used by the
  updater so a stale pin or API fallback can never hand it a different
  version than its check validated). Malformed tags fall back to normal
  resolution.
- Version-check uses the releases *metadata* API, never the asset URL, so
  resolution can't inflate GitHub's counter.

## Deploy

```bash
cd tools/download-redirect
npx wrangler deploy   # route: sinain.com/download* (zone sinain.com)
```

Requires Workers Analytics Engine enabled on the account (one-time dashboard
toggle).

## Query stats

Analytics Engine SQL API (90-day retention), e.g. humans vs bots last 7 days:

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/analytics_engine/sql" \
  -H "Authorization: Bearer <API_TOKEN>" \
  -d "SELECT index1 AS kind, count() AS hits FROM sinain_downloads
      WHERE timestamp > NOW() - INTERVAL '7' DAY GROUP BY kind"
```

Columns: `blob1` ua, `blob2` referer, `blob3` country, `blob4` tag,
`index1` kind (`human`/`bot`/`updater`), `double1` non-human flag.
Live debugging: `npx wrangler tail sinain-download-redirect`.
