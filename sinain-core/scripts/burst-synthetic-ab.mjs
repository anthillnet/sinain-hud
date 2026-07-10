/**
 * Synthetic A/B for the deterministic burst levers (volatile-line dedup,
 * same-app event merge, brief memoization). Replays IDENTICAL synthetic
 * buffers through the pre-change assembly (window-ops-old, compiled from
 * HEAD) and the new one, and prints the char deltas. No network for the
 * assembly A/B; the memo test stubs fetch and counts calls.
 *
 * Synthetic profile mirrors the measured baseline shape (BASELINE-BURST-SPEND):
 * OCR-dense frames where most lines are stable UI chrome, a few volatile
 * lines (clock / progress / counters) mutate every frame, and a trickle of
 * genuinely novel content.
 */
import * as newOps from "../dist/capture/window-ops.js";

// Optional A/B leg: compile a reference window-ops to dist/capture/
// window-ops-old.js (e.g. `git show <ref>:sinain-core/src/capture/window-ops.ts
// > src/capture/window-ops-old.ts && npm run build`). Without it the script
// still runs every invariant check against the current build.
const oldOps = await import("../dist/capture/window-ops-old.js").catch(() => null);

// ── synthetic buffers (duck-typed: only the methods assembleWindow uses) ──
const NOW = Date.now();
const chrome = [
  "File Edit Selection View Go Run Terminal Window Help",
  "EXPLORER src capture window-ops.ts burst-client.ts voice-session.ts",
  "PROBLEMS OUTPUT DEBUG CONSOLE TERMINAL PORTS",
  "main ← → sinain-core npm run dev",
];
const events = [];
let novelId = 0;
for (let i = 0; i < 120; i += 1) {
  const ts = NOW - (59.5 - i * 0.5) * 60_000; // 120 frames over the last hour
  const app = i % 40 < 30 ? "Zed" : "Chrome";
  const title = app === "Zed" ? "window-ops.ts — sinain-hud" : "Cerebras docs";
  const clockH = String(9 + Math.floor(i / 30)).padStart(2, "0");
  const clockM = String((i * 2) % 60).padStart(2, "0");
  const lines = [
    ...chrome,
    `${clockH}:${clockM} 78% ⚡ 12.${i}s`,             // volatile: clock/progress
    `Ln ${40 + i}, Col ${i % 20} Spaces: 2 UTF-8`,     // volatile: cursor position
    `tokens in ${19_000 + i * 13} out ${200 + i}`,      // volatile: counters
  ];
  // Realistic novel content: distinct WORDS per line (code/prose is
  // letter-distinct across frames, unlike volatile counters). Identifier is
  // the novelId spelled in letters so masking can't collide two novel lines.
  const spell = (n) => "n" + String(n).split("").map((d) => "abcdefghij"[+d]).join("");
  if (i % 3 === 0) lines.push(`function ${spell(novelId)}_handler() reads the ${spell(novelId++)} buffer`);
  // Same-frame table of digit-differing rows: distinct content, must survive.
  if (i === 90) lines.push("port 9500 core", "port 9501 bridge", "port 9502 memoryd");
  events.push({
    ts,
    ocr: lines.join("\n"),
    ocrLines: lines.map((t, j) => ({ text: t, bbox: [10, 20 * j, 400, 12] })),
    meta: { app, windowTitle: title, ssim: 0.5 },
  });
}
const senseBuffer = {
  queryByTime: (since) => events.filter((e) => e.ts >= since),
  appHistory: (since) => events.filter((e) => e.ts >= since).map((e) => ({ ts: e.ts, app: e.meta.app })),
};
const feedBuffer = {
  queryByTime: (since) => [{ ts: NOW - 20 * 60_000, text: "let's check the token counts on this", source: "audio" }].filter((i) => i.ts >= since),
  queryBySource: (src, since) => (src === "audio" ? [{ ts: NOW - 20 * 60_000 }].filter((i) => i.ts >= since) : []),
};

// ── A/B: assembly chars (the deterministic proxy for prefill tokens) ──
delete process.env.SINAIN_BURST_MAX_CHARS;
process.env.SINAIN_BURST_MAX_CHARS = "10000000"; // uncap: measure pre-cap volume
for (const minutes of [10, 30, 60]) {
  const b = newOps.assembleWindow(feedBuffer, senseBuffer, minutes);
  if (oldOps) {
    const a = oldOps.assembleWindow(feedBuffer, senseBuffer, minutes);
    const pct = (100 * (a.text.length - b.text.length) / a.text.length).toFixed(1);
    console.log(`window ${String(minutes).padStart(2)}m: old ${String(a.text.length).padStart(6)} ch (${a.lineCount} lines) → new ${String(b.text.length).padStart(6)} ch (${b.lineCount} lines)  −${pct}%`);
  } else {
    console.log(`window ${String(minutes).padStart(2)}m: ${b.text.length} ch (${b.lineCount} lines) — no old build, skipping A/B`);
  }
}

// Sanity: every genuinely novel content line must survive the new assembly.
const b60 = newOps.assembleWindow(feedBuffer, senseBuffer, 60);
const missing = [];
const spellCheck = (n) => "n" + String(n).split("").map((d) => "abcdefghij"[+d]).join("");
for (let i = 0; i < novelId; i += 1) if (!b60.text.includes(`${spellCheck(i)}_handler()`)) missing.push(i);
console.log(missing.length === 0 ? `novel-content check: all ${novelId} unique lines survived` : `LOST ${missing.length}/${novelId} novel lines: ${missing.slice(0, 5)}`);
// Same-frame digit-differing rows (table) must ALL survive.
const tableRows = ["port 9500 core", "port 9501 bridge", "port 9502 memoryd"].filter((r) => b60.text.includes(r));
console.log(`same-frame table rows survived: ${tableRows.length}/3`);
// And cross-frame volatile lines are represented once, not per-frame.
const volatileCount = (b60.text.match(/Ln \d+, Col/g) || []).length;
const oldVolatile = oldOps ? (oldOps.assembleWindow(feedBuffer, senseBuffer, 60).text.match(/Ln \d+, Col/g) || []).length : "n/a";
console.log(`volatile "Ln x, Col y" lines in new window: ${volatileCount} (want 1; old: ${oldVolatile})`);

// ── memo: second identical summon must not hit the network ──
let fetches = 0;
globalThis.fetch = async () => {
  fetches += 1;
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: '{"timeline":[{"at":"-5m","what":"editing window-ops"}],"goal":"cut burst spend","problems":[],"entities":["window-ops.ts"]}' } }],
      usage: { prompt_tokens: 4200, completion_tokens: 42 },
    }),
  };
};
const cfg = { enabled: true, apiKey: "test", model: "m", endpoint: "http://stub", provider: "cerebras", maxTokens: 600, timeoutMs: 5000 };
const slice = newOps.assembleWindow(feedBuffer, senseBuffer, 30);
const r1 = await newOps.summonBrief(cfg, slice, 30);
const r2 = await newOps.summonBrief(cfg, slice, 30);
console.log(`memo: fetches=${fetches} (want 1), second cached=${r2.result.cached === true}, briefs identical=${JSON.stringify(r1.brief) === JSON.stringify(r2.brief)}`);

// ── parse-retry: a truncated-JSON first response must trigger ONE retry with
// a different seed, and the brief must come from the retry ──
let prCalls = 0;
globalThis.fetch = async () => {
  prCalls += 1;
  const content = prCalls === 1
    ? '{"timeline":[{"at":"-2m","what":"truncated mid-str'  // unterminated (seen live)
    : '{"timeline":[{"at":"-2m","what":"rescued by retry"}],"goal":"g","problems":[],"entities":["e"]}';
  return { ok: true, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 4200, completion_tokens: 42 } }) };
};
const pr = await newOps.summonBrief(cfg, slice, 30, 7777);  // fresh seed → no memo hit
console.log(`parse-retry: fetches=${prCalls} (want 2), brief rescued=${pr.brief.timeline[0]?.what === "rescued by retry"}`);
// Both attempts failing must still throw (callers show the error state).
globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"broken":"' } }], usage: {} }) });
let threw = false;
try { await newOps.summonBrief(cfg, slice, 30, 8888); } catch { threw = true; }
console.log(`parse-retry both fail: threw=${threw} (want true)`);
