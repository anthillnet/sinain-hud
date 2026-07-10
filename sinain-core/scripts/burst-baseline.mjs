/**
 * Burst-lane spend baseline (perf/burst-instrumentation).
 *
 * Pulls the REAL feed + sense buffers from a running core (GET /sense, /feed),
 * freezes them, re-anchors to now, and replays the actual burst gestures
 * (enrich / summon-30 / summon-60 / voice-seed) through the instrumented
 * window-ops against the real Cerebras endpoint. Prints the burst-metrics
 * snapshot: real tokensIn/out + latency + prefill composition + L1/L2 headroom.
 *
 * A frozen buffer makes this reproducible — re-run after each optimization and
 * diff the snapshot to measure the delta on identical input.
 *
 *   npm run build
 *   CEREBRAS_API_KEY=... node scripts/burst-baseline.mjs [--core http://127.0.0.1:9500] [--clip "text"]
 */
import { assembleWindow, summonBrief, enrichFocus } from "../dist/capture/window-ops.js";
import { burstMetrics } from "../dist/capture/burst-metrics.js";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const CORE = arg("--core", "http://127.0.0.1:9500");
const CLIP = arg("--clip", "a clipboard item the user copied while working");

async function getJson(path) {
  const r = await fetch(`${CORE}${path}`);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

const sd = await getJson("/sense");
const fd = await getJson("/feed");
const sense = Array.isArray(sd) ? sd : (sd.events || sd.senseEvents || []);
const feed  = Array.isArray(fd) ? fd : (fd.messages || fd.feed || fd.items || []);
if (sense.length === 0) { console.error("no sense events — is the stack capturing?"); process.exit(2); }

// Freeze + re-anchor newest→now so queryByTime windows select the same slice.
const maxTs = Math.max(...sense.map(e => e.ts), ...feed.map(e => e.ts || 0));
const shift = Date.now() - maxTs;
for (const e of sense) e.ts += shift;
for (const e of feed)  e.ts += shift;

const feedBuffer = {
  queryByTime: (since) => feed.filter(e => e.ts >= since).sort((a, b) => a.ts - b.ts),
  queryBySource: (src, since) => feed.filter(e => e.source === src && e.ts >= since),
};
const senseBuffer = {
  queryByTime: (since) => sense.filter(e => e.ts >= since).sort((a, b) => a.ts - b.ts),
  appHistory: (since) => sense.filter(e => e.ts >= since).map(e => ({ app: (e.meta || {}).app || "", ts: e.ts })),
};

const burst = {
  enabled: true, provider: "cerebras",
  model: process.env.BURST_MODEL || "gemma-4-31b",
  endpoint: process.env.BURST_ENDPOINT || "https://api.cerebras.ai/v1/chat/completions",
  apiKey: process.env.CEREBRAS_API_KEY || process.env.BURST_API_KEY || "",
  maxTokens: 700, timeoutMs: 20000,
};
if (!burst.apiKey) { console.error("set CEREBRAS_API_KEY"); process.exit(2); }

const rec = (gesture, r, stats, cacheKey) => burstMetrics.record({
  gesture, tokensIn: r.tokensIn, tokensOut: r.tokensOut, latencyMs: r.latencyMs, cacheKey, stats,
});

try { const { result, stats } = await enrichFocus(burst, feedBuffer, senseBuffer, CLIP); rec("enrich", result, stats, "sinain-enrich-v3"); }
catch (e) { console.error("enrich:", String(e).slice(0, 160)); }

for (const [minutes, label] of [[30, "summon"], [60, "summon60"]]) {
  try { const slice = assembleWindow(feedBuffer, senseBuffer, minutes); const { result } = await summonBrief(burst, slice, minutes); rec(label, result, slice.stats, "sinain-summon-v1"); }
  catch (e) { console.error(`${label}:`, String(e).slice(0, 160)); }
}
// voice-seed shares the summon path — measured at 30m for parity.
try { const slice = assembleWindow(feedBuffer, senseBuffer, 30); const { result } = await summonBrief(burst, slice, 30); rec("voice-seed", result, slice.stats, "sinain-summon-v1"); }
catch (e) { console.error("voice-seed:", String(e).slice(0, 160)); }

console.log("\n=== burst baseline snapshot ===");
console.log(JSON.stringify(burstMetrics.snapshot(), null, 1));
