// Cloudflare Worker — first-party logged download redirect for sinain.com.
//
// Why this exists:
//   The landing page's client-side analytics (Umami) is invisible to the
//   privacy-conscious audience Sinain attracts — they block trackers, so a
//   real macOS download by such a user registers NOTHING in Umami while still
//   incrementing GitHub's (bot-inflated, lagged) download_count. Neither
//   number is trustworthy on its own.
//
//   Routing the download button through this Worker gives a count that is:
//     • unblockable  — it's a navigation/302, not a JS tracker
//     • first-party  — served from sinain.com, nothing for blockers to match
//     • bot-filterable — we see the User-Agent and classify human vs bot
//
// Route:  sinain.com/download/macos  ->  302  ->  newest macos-v* Sinain.dmg
//
// It resolves the target at request time (mirroring tools/site/set-dmg-link.sh:
// newest published `macos-v*` release), so it never needs touching on release.

const REPO = "anthillnet/sinain-hud";
const ASSET = "Sinain.dmg";
const RESOLVE_TTL = 600; // seconds to cache the resolved latest-DMG URL

// Heuristic bot detection. Real browsers always send a UA; link unfurlers,
// crawlers and scanners self-identify here. Raw UA is logged regardless, so
// classification can be revisited later from the logs.
const BOT_UA =
  /bot\b|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora link preview|pinterest|vkshare|w3c_validator|redditbot|linkedinbot|slackbot|telegrambot|twitterbot|discordbot|whatsapp|preview|headless|phantomjs|curl\/|wget\/|python-requests|go-http-client|libwww-perl|httpclient|scrapy|axios\/|node-fetch|okhttp|java\//i;

function classify(ua) {
  if (!ua) return "bot"; // no UA == not a real browser
  return BOT_UA.test(ua) ? "bot" : "human";
}

// Resolve the newest published macos-v* release's Sinain.dmg URL, cached at the
// edge so we stay far under GitHub's unauthenticated API rate limit.
async function resolveDmgUrl(ctx) {
  const cache = caches.default;
  const cacheKey = new Request("https://resolve.internal/macos-dmg");
  const cached = await cache.match(cacheKey);
  if (cached) return await cached.text();

  // Safe fallback if the API call fails for any reason.
  let url = `https://github.com/${REPO}/releases/latest/download/${ASSET}`;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases?per_page=30`,
      {
        headers: {
          "User-Agent": "sinain-download-redirect",
          Accept: "application/vnd.github+json",
        },
        cf: { cacheTtl: RESOLVE_TTL, cacheEverything: true },
      },
    );
    if (res.ok) {
      const releases = await res.json();
      const latest = releases.find(
        (r) => r.tag_name && r.tag_name.startsWith("macos-v") && !r.draft,
      );
      if (latest) {
        url = `https://github.com/${REPO}/releases/download/${latest.tag_name}/${ASSET}`;
      }
    }
  } catch (_) {
    /* keep fallback */
  }

  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(url, {
        headers: { "Cache-Control": `max-age=${RESOLVE_TTL}` },
      }),
    ),
  );
  return url;
}

// Best-effort, non-atomic KV counters — fine for analytics magnitude.
// Read them later with: wrangler kv key get --binding DL_COUNTERS "<key>"
async function tally(env, kind) {
  if (!env.DL_COUNTERS) return;
  const day = new Date().toISOString().slice(0, 10);
  const keys = [`total:all`, `total:${kind}`, `day:${day}:all`, `day:${day}:${kind}`];
  for (const key of keys) {
    const cur = parseInt((await env.DL_COUNTERS.get(key)) || "0", 10);
    await env.DL_COUNTERS.put(key, String(cur + 1));
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/download/macos")) {
      return new Response("Not found", { status: 404 });
    }

    const ua = request.headers.get("user-agent") || "";
    const kind = classify(ua);
    const cf = request.cf || {};

    // Structured log line — stream live with `wrangler tail`, or persist via
    // Cloudflare Logpush. This is where you SEE every download, UA and all.
    console.log(
      JSON.stringify({
        evt: "download_redirect",
        asset: "macos-dmg",
        kind,
        ua,
        referer: request.headers.get("referer") || "",
        country: cf.country || "",
        colo: cf.colo || "",
        ts: new Date().toISOString(),
      }),
    );

    ctx.waitUntil(tally(env, kind));

    const target = await resolveDmgUrl(ctx);
    return Response.redirect(target, 302);
  },
};
