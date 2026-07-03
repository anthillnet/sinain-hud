/**
 * Integration test for the supervised single-consumer AgentLoop.
 *
 * Drives the REAL AgentLoop + REAL analyzer against a fake OpenRouter endpoint
 * whose behavior we flip at runtime, asserting the three failure modes the
 * redesign exists to fix:
 *   1. wedged tick (analyzer never responds) → watchdog recovers the loop
 *   2. event flood (faster than debounce)    → a tick still runs (no starvation)
 *   3. persistent failure                     → bounded retry, then recovery
 *
 * Run: npx tsx test/loop-resilience.test.ts
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AgentLoop, type AgentLoopDeps } from "../src/agent/loop.js";
import { FeedBuffer } from "../src/buffers/feed-buffer.js";
import { SenseBuffer } from "../src/buffers/sense-buffer.js";
import type { AnalysisConfig } from "../src/types.js";

// ── tiny assert harness ──
let failures = 0;
function ok(cond: boolean, msg: string) {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${msg}`);
  if (!cond) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(50);
  }
  console.log(`    (timed out after ${timeoutMs}ms waiting for: ${label})`);
  return false;
}

// ── fake analyzer endpoint ──
type Mode = "fast" | "hang" | "error";
let mode: Mode = "fast";
let requests = 0;
const openSockets = new Set<http.ServerResponse>();

const server = http.createServer((req, res) => {
  requests++;
  if (mode === "hang") { openSockets.add(res); return; } // never respond
  if (mode === "error") { res.writeHead(500); res.end("boom"); return; }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    model: "fake",
    usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 },
    choices: [{ message: { content: JSON.stringify({ hud: `tick #${requests}`, digest: `digest ${requests}` }) } }],
  }));
});

function makeLoop(endpoint: string) {
  const feedBuffer = new FeedBuffer(100);
  const senseBuffer = new SenseBuffer(60, 5);
  let hudUpdates = 0;
  const cfg: AnalysisConfig = {
    enabled: true, provider: "openrouter", model: "fake", visionModel: "fake",
    endpoint, apiKey: "test", maxTokens: 100, temperature: 0.3, fallbackModels: [],
    timeout: 1000, pushToFeed: true,
    debounceMs: 300, maxIntervalMs: 1500, cooldownMs: 300, maxAgeMs: 120_000,
    historyLimit: 50, regionsEnabled: false,
    tickDeadlineMs: 1000, // short so the watchdog fires fast in the test
  };
  const deps: AgentLoopDeps = {
    feedBuffer, senseBuffer, agentConfig: cfg, escalationMode: "selective",
    situationMdPath: path.join(os.tmpdir(), `sit-${Date.now()}.md`),
    onAnalysis: () => {}, onHudUpdate: () => { hudUpdates++; }, shouldWriteSituation: () => false,
  };
  const loop = new AgentLoop(deps);
  // pushing a sense event + notifying = "new context arrived"
  const feed = () => {
    senseBuffer.push({ type: "text", ts: Date.now(), ocr: `screen ${Math.random()}`, meta: { app: "Test", ssim: 0.1 } as any });
    loop.onNewContext(false);
  };
  return { loop, cfg, feed, stats: () => loop.getStats() as any, hud: () => hudUpdates };
}

async function main() {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const endpoint = `http://127.0.0.1:${port}/chat/completions`;

  // ── Test 1: normal operation produces a digest ──
  console.log("\nTest 1: normal tick produces a digest");
  {
    mode = "fast"; requests = 0;
    const { loop, feed, stats } = makeLoop(endpoint);
    loop.start();
    feed();
    const got = await until(() => stats().totalCalls >= 1, 4000, "first tick");
    ok(got, "a tick completed");
    ok(stats().lastDigest != null, "digest is populated (not null)");
    ok(stats().state === "idle" || stats().state === "scheduled", `state healthy (${stats().state})`);
    loop.stop();
  }

  // ── Test 2: event flood does NOT starve the loop ──
  console.log("\nTest 2: event flood (every 50ms < debounce 300ms) still ticks within maxWait");
  {
    mode = "fast"; requests = 0;
    const { loop, feed, stats } = makeLoop(endpoint);
    loop.start();
    let flooding = true;
    (async () => { while (flooding) { feed(); await sleep(50); } })();
    // Under the OLD design the debounce reset every 50ms and never fired.
    // Here the maxWait ceiling (1500ms) guarantees a tick.
    const got = await until(() => stats().totalCalls >= 1, 4000, "tick under flood");
    flooding = false;
    ok(got, "a tick ran despite continuous sub-debounce events (no starvation)");
    loop.stop();
  }

  // ── Test 3: wedged tick → per-tick deadline aborts it (watchdog is the
  //    backstop if abort itself fails — not reachable through the real
  //    analyzer, which always honors the signal) → loop resumes ──
  console.log("\nTest 3: analyzer hangs forever → tick deadline aborts the wedge → recovery");
  {
    mode = "hang"; requests = 0;
    const { loop, feed, stats } = makeLoop(endpoint);
    loop.start();
    feed();
    // Wait for a tick to be in-flight and then get stuck past the deadline.
    const stuck = await until(() => stats().state === "running" || stats().inFlightForMs != null, 3000, "tick in-flight");
    ok(stuck, "a tick went in-flight against the hung endpoint");
    // tickDeadline 1000ms + watchdog grace 10000ms + interval 5000ms → recover within ~16s.
    const recovered = await until(() => (stats().ticksTimedOut as number) >= 1, 20000, "deadline/watchdog timeout");
    ok(recovered, "wedged tick was aborted by its deadline (ticksTimedOut >= 1)");
    ok((stats().consecutiveFailures as number) >= 1, "failure surfaced (consecutiveFailures >= 1)");
    // Now let the endpoint recover; the fresh consumer should produce a digest.
    mode = "fast";
    // release the held sockets so nothing lingers
    for (const s of openSockets) { try { s.destroy(); } catch {} }
    openSockets.clear();
    feed();
    const healed = await until(() => (stats().totalCalls as number) >= 1, 8000, "post-recovery tick");
    ok(healed, "loop resumed and produced a tick after recovery (self-healing)");
    loop.stop();
  }

  // ── Test 4: persistent errors → bounded retry, no hot loop, then recovery ──
  console.log("\nTest 4: persistent 500s → retries with cooldown, then recovers");
  {
    mode = "error"; requests = 0;
    const { loop, cfg, feed, stats } = makeLoop(endpoint);
    loop.start();
    feed();
    const retried = await until(() => requests >= 2, 6000, "at least 2 retries");
    ok(retried, "loop retried after failure (self-healing re-arm)");
    await sleep(1200);
    const reqAfter = requests;
    await sleep(1200);
    const delta = requests - reqAfter;
    // cooldown 300ms + debounce 300ms ⇒ at most a handful per second, NOT a hot loop.
    ok(delta <= 8, `retry is rate-limited, not a hot loop (${delta} reqs in ~1.2s)`);
    ok(stats().state === "degraded" || (stats().consecutiveFailures as number) >= 1, `degraded state visible (${stats().state})`);
    mode = "fast";
    feed();
    const healed = await until(() => (stats().totalCalls as number) >= 1, 6000, "recovery tick");
    ok(healed, "loop recovered to a successful tick");
    loop.stop();
  }

  // ── cleanup ──
  for (const s of openSockets) { try { s.destroy(); } catch {} }
  server.close();
  console.log(`\n${failures === 0 ? "ALL PASS ✓" : `${failures} FAILURE(S) ✗`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
