#!/usr/bin/env node
// Cerebras backend test stand for SinainHUD.
//
// Standalone, zero-dependency (global fetch, Node 18+). Proves the Cerebras
// cloud backend works end-to-end the same way sinain-core's analyzer talks to
// it: OpenAI-compatible POST /v1/chat/completions, Bearer auth, a two-output
// {hud, digest} JSON contract.
//
// Usage:
//   CEREBRAS_API_KEY=csk-... node tools/cerebras-test-stand/check.mjs
//   CEREBRAS_API_KEY=csk-... node tools/cerebras-test-stand/check.mjs qwen-3-32b
//   CEREBRAS_MODEL=gpt-oss-120b CEREBRAS_API_KEY=csk-... node tools/cerebras-test-stand/check.mjs
//
// Exit 0 = backend reachable and produced parseable sinain-style output.
// Exit 1 = misconfigured / unreachable / contract failure.

const BASE = process.env.CEREBRAS_BASE_URL || "https://api.cerebras.ai/v1";
const KEY = process.env.CEREBRAS_API_KEY || process.env.ANALYSIS_API_KEY || "";
const MODEL = process.argv[2] || process.env.CEREBRAS_MODEL || "gpt-oss-120b";

const c = {
  reset: "\x1b[0m", dim: "\x1b[2m", red: "\x1b[31m",
  green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m",
};
const ok = (m) => console.log(`${c.green}✓${c.reset} ${m}`);
const info = (m) => console.log(`${c.cyan}•${c.reset} ${m}`);
const warn = (m) => console.log(`${c.yellow}!${c.reset} ${m}`);
const fail = (m) => { console.error(`${c.red}✗ ${m}${c.reset}`); process.exit(1); };

if (!KEY) {
  fail("CEREBRAS_API_KEY is not set. Get a key at https://cloud.cerebras.ai and:\n" +
       "    export CEREBRAS_API_KEY=csk-...\n" +
       "  then re-run this script.");
}

const headers = { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" };

console.log(`${c.bold}Cerebras test stand${c.reset} ${c.dim}(${BASE})${c.reset}\n`);

// ── 1. Auth + model discovery: GET /v1/models ───────────────────────────────
async function listModels() {
  info("Listing models (GET /v1/models) ...");
  let res;
  try {
    res = await fetch(`${BASE}/models`, { headers });
  } catch (e) {
    fail(`Network error reaching ${BASE}/models — ${e.message}`);
  }
  if (res.status === 401) fail("401 Unauthorized — CEREBRAS_API_KEY is invalid or expired.");
  if (!res.ok) fail(`GET /models returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const ids = (data.data || []).map((m) => m.id).sort();
  ok(`Authenticated. ${ids.length} model(s) available:`);
  for (const id of ids) console.log(`    ${id === MODEL ? c.green + id + " (selected)" + c.reset : id}`);
  if (ids.length && !ids.includes(MODEL)) {
    warn(`Selected model "${MODEL}" is not in the list above — the chat call may 404. ` +
         `Pass a valid id as the first arg, e.g.  node check.mjs ${ids[0]}`);
  }
  console.log("");
  return ids;
}

// ── 2. Analysis round-trip: the same shape sinain's analyzer sends ──────────
async function analysisRoundTrip() {
  // Mirrors agent/analyzer.ts callOpenRouter: system+user messages, the
  // two-output {hud, digest} JSON contract that the rest of the pipeline parses.
  const systemPrompt =
    "You are SinainHUD's context analyzer. Given the user's current screen/audio " +
    "context, reply with a JSON object and nothing else: " +
    '{"hud": "<one short line of advice, <=12 words>", "digest": "<2-3 sentence richer summary>"}.';
  const userPrompt =
    "Context: The user is reading the Cerebras inference API quickstart and is " +
    "wiring it into a Node app as an OpenAI-compatible backend. Their terminal " +
    "shows a 401 error from a chat completions call.";

  info(`Chat completion (POST /v1/chat/completions, model=${MODEL}) ...`);
  const start = Date.now();
  let res;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 800,
        temperature: 0.3,
      }),
    });
  } catch (e) {
    fail(`Network error on chat completion — ${e.message}`);
  }
  const latencyMs = Date.now() - start;
  if (!res.ok) fail(`chat/completions returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || "";
  const u = data.usage || {};
  ok(`Response in ${latencyMs}ms — ${u.prompt_tokens ?? "?"} in / ${u.completion_tokens ?? "?"} out tokens`);
  if (typeof u.total_tokens === "number" && latencyMs > 0) {
    const tps = Math.round((u.completion_tokens || 0) / (latencyMs / 1000));
    info(`~${tps} output tokens/sec`);
  }
  // sinain relies on usage.cost from OpenRouter; Cerebras doesn't return one.
  if (typeof u.cost !== "number") {
    info("usage.cost absent (expected for Cerebras) — CostTracker will report $0 for these ticks.");
  }

  // Validate the two-output JSON contract the way analyzer.ts does.
  console.log(`\n${c.dim}--- raw model output ---${c.reset}\n${raw}\n${c.dim}------------------------${c.reset}\n`);
  let parsed;
  try {
    const jsonStr = raw.replace(/^```\w*\s*\n?/, "").replace(/\n?\s*```\s*$/, "").trim();
    parsed = JSON.parse(jsonStr);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) { try { parsed = JSON.parse(match[0]); } catch { /* ignore */ } }
  }
  if (!parsed || typeof parsed.hud !== "string") {
    fail("Model output did not parse into the {hud, digest} contract sinain expects. " +
         "The backend works, but this model may need a stronger JSON-following prompt or a different model.");
  }
  ok("Parsed sinain {hud, digest} contract:");
  console.log(`    ${c.bold}hud:${c.reset}    ${parsed.hud}`);
  console.log(`    ${c.bold}digest:${c.reset} ${parsed.digest ?? "(none)"}`);
}

// ── 3. ROI/region lane: the exact shape region-detector.ts sends in cloud mode ─
async function regionLaneRoundTrip() {
  // Mirrors agent/region-detector.ts callModel (useCloud path): a focused JSON
  // prompt that picks on-screen lines, with response_format json_object — the
  // OpenAI-compatible structured-output mode Cerebras supports.
  const systemPrompt =
    "You pick the on-screen line(s) at the CENTER of what the user is doing, so an " +
    "assistant can offer to help. Return JSON only. Input: numbered screen lines, " +
    '"[L<id>] text". For each, return {"line": <id>, "issue": "<=8 words", "tip": ' +
    '"concrete next step", "action": "fix"|"explain"|"research"}. Max 2. Skip pure ' +
    'chrome (menus, toolbars). Shape: {"regions":[...]}.';
  const userPrompt =
    "Active app: Terminal\nScreen lines:\n" +
    "[L1] $ node check.mjs\n" +
    "[L2] Error: chat/completions returned HTTP 402 payment_required\n" +
    "[L3] File  Edit  View  Window  Help";

  info(`Region/ROI lane (response_format=json_object, model=${MODEL}) ...`);
  const start = Date.now();
  let res;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 512,   // mirrors REGION_SLM_MAX_TOKENS cerebras default (256 truncates this verbose model)
        response_format: { type: "json_object" },
      }),
    });
  } catch (e) {
    fail(`Network error on region call — ${e.message}`);
  }
  const latencyMs = Date.now() - start;
  if (!res.ok) {
    fail(`region call returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}\n` +
         "  (If this is the only failure, this model may not support response_format=json_object.)");
  }
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || "";
  const finish = data.choices?.[0]?.finish_reason;
  if (finish === "length") {
    warn(`finish_reason=length — output truncated at max_tokens (${data.usage?.completion_tokens} out). ` +
         "Pretty-printed JSON from a large model overflows the 256-token region cap.");
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { /* below */ }
  // region-detector accepts {regions:[...]}, a bare array, or a single {line,...}.
  const regions = Array.isArray(parsed?.regions) ? parsed.regions
    : Array.isArray(parsed) ? parsed
    : (parsed && parsed.line !== undefined) ? [parsed] : null;
  if (!regions) {
    fail(`Region lane output didn't parse into a regions shape (finish_reason=${finish}). Full raw:\n${raw}`);
  }
  ok(`Region/ROI lane OK in ${latencyMs}ms — ${regions.length} region(s):`);
  for (const r of regions.slice(0, 2)) {
    console.log(`    ${c.bold}L${r.line}${c.reset} [${r.action ?? "?"}] ${r.issue ?? ""} → ${r.tip ?? ""}`);
  }
}

await listModels();
await analysisRoundTrip();
console.log("");
await regionLaneRoundTrip();
console.log(`\n${c.green}${c.bold}PASS${c.reset} — Cerebras is reachable and speaks both sinain lanes (analyzer + ROI).`);
console.log(`${c.dim}Run sinain-core against it with tools/cerebras-test-stand/.env.cerebras.example${c.reset}`);
