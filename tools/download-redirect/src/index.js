// sinain.com/download — logged redirect to the current macOS DMG on GitHub Releases.
//
// Why: GitHub's asset download_count is an unfilterable all-time total that
// bots (FB link scanner, Safe Browsing deep-scan, AV gateways) and partial
// range requests inflate several-fold. This worker 302s to the DMG and
// records one data point per request with user-agent + country, so humans
// and bots can be told apart. No IPs stored.
//
// Version resolution mirrors the old tools/site/set-dmg-link.sh contract:
// RELEASE_VERSIONS.json on main is the pin; if its DMG isn't published yet
// (release still building) fall back to the newest published macos-v*
// release so the link never 404s mid-release. Resolution is cached 5 min.
// The published-check uses the releases metadata API, never the asset URL,
// so resolution itself can't inflate the download counter.

const REPO = 'anthillnet/sinain-hud';
const PIN_URL = `https://raw.githubusercontent.com/${REPO}/main/RELEASE_VERSIONS.json`;
const RESOLVED_TAG_CACHE_KEY = 'https://cache.sinain.internal/resolved-macos-tag';
const CACHE_TTL = 300;
const GH_HEADERS = { 'User-Agent': 'sinain-download-redirect', 'Accept': 'application/vnd.github+json' };

const BOT_UA = /bot|crawl|spider|scan|preview|fetch|curl|wget|python|go-http|okhttp|facebookexternalhit|facebookcatalog|meta-external|slack|discord|telegram|whatsapp|twitterbot|safebrowsing|virustotal|headless/i;

// True iff the release exists and has an uploaded Sinain.dmg. Throws on API
// failure (rate limit etc.) so the caller can distinguish "not published"
// from "couldn't check".
async function dmgPublished(tag) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, { headers: GH_HEADERS });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`github api ${res.status}`);
  const rel = await res.json();
  return (rel.assets || []).some((a) => a.name === 'Sinain.dmg' && a.state === 'uploaded');
}

async function newestPublishedTag() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, { headers: GH_HEADERS });
  if (!res.ok) throw new Error(`github api ${res.status}`);
  const releases = await res.json();
  const tag = releases.find(
    (r) => !r.draft && !r.prerelease && r.tag_name.startsWith('macos-v')
      && (r.assets || []).some((a) => a.name === 'Sinain.dmg' && a.state === 'uploaded'),
  )?.tag_name;
  if (!tag) throw new Error('no published macos-v release found');
  return tag;
}

async function resolveTag(env) {
  const cache = caches.default;
  const cached = await cache.match(RESOLVED_TAG_CACHE_KEY);
  if (cached) return cached.text();

  let pinned = null;
  try {
    const res = await fetch(PIN_URL, { headers: { 'User-Agent': GH_HEADERS['User-Agent'] } });
    if (res.ok) {
      const ver = (await res.json()).dmg;
      if (ver) pinned = `macos-v${ver}`;
    }
  } catch (e) {
    console.log(`pin fetch failed: ${e.message}`);
  }

  let tag;
  try {
    if (pinned && (await dmgPublished(pinned))) tag = pinned;
    else tag = await newestPublishedTag();
  } catch (e) {
    // API unavailable (likely rate-limited from a shared CF egress IP):
    // trust the pin if we have it, else the deploy-time fallback.
    console.log(`publish check failed: ${e.message}`);
    tag = pinned || env.FALLBACK_TAG;
  }

  await cache.put(
    RESOLVED_TAG_CACHE_KEY,
    new Response(tag, { headers: { 'Cache-Control': `max-age=${CACHE_TTL}` } }),
  );
  return tag;
}

export default {
  async fetch(request, env, ctx) {
    const ua = request.headers.get('user-agent') || '(none)';
    const referer = request.headers.get('referer') || '(none)';
    const country = request.cf?.country || '??';
    const isBot = BOT_UA.test(ua) || request.method === 'HEAD';

    const tag = await resolveTag(env);
    const target = `https://github.com/${REPO}/releases/download/${tag}/Sinain.dmg`;

    // One row per request: [ua, referer, country, tag], double1 = isBot.
    if (env.DOWNLOADS) {
      env.DOWNLOADS.writeDataPoint({
        blobs: [ua.slice(0, 256), referer.slice(0, 256), country, tag],
        doubles: [isBot ? 1 : 0],
        indexes: [isBot ? 'bot' : 'human'],
      });
    }
    console.log(JSON.stringify({ kind: isBot ? 'bot' : 'human', country, ua, referer, tag }));

    return Response.redirect(target, 302);
  },
};
