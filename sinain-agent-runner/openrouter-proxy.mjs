// OpenRouter injecting proxy for reasoning-model compatibility.
//
// Problem it solves:
//   DeepSeek V4 Flash (and similar thinking models) emit `reasoning` in
//   responses and REQUIRE `reasoning_content` echoed back in subsequent
//   assistant-message history. openclaude (Claude-Code-compat CLI) strips
//   the field when reconstructing history -> DeepSeek 400s on every multi-turn
//   MCP flow.
//
// How it works:
//   Listens on :11435, forwards to https://openrouter.ai.
//
//   MODE=preserve (default): intercepts responses (streaming or not),
//     extracts reasoning + tool_call ids, caches (tool_call_id -> reasoning).
//     On subsequent requests, walks messages[] and injects cached
//     reasoning_content into assistant messages that have tool_calls but no
//     reasoning_content. Keeps thinking mode on, preserves model quality.
//
//   MODE=off: hard-disables thinking by injecting `reasoning:{enabled:false}`
//     into every /chat/completions body. Legacy behavior; use as an escape
//     hatch if preserve mode misbehaves.
//
//   Fallback: if MODE=preserve but any assistant-with-tool_calls lacks both
//     reasoning_content AND cache hit, this request disables reasoning for
//     itself only. Avoids 400 on cache miss (e.g. proxy restart mid-session).
//
// Config:
//   REASONING_MODE=preserve|off   (default: preserve)
//   OPENROUTER_PROXY_PORT=11435   (default: 11435)
//   OPENROUTER_PROXY_LOG=/tmp/openrouter-proxy.log
//
// Point openclaude at the proxy in .env:
//   OPENAI_BASE_URL=http://localhost:11435/api/v1

import http from "http";
import https from "https";
import { appendFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";

// Exported for testing — default values from env or hardcoded defaults.
export const DEFAULT_LOG = "/tmp/openrouter-proxy.log";
export const DEFAULT_UPSTREAM_HOST = "openrouter.ai";
export const DEFAULT_UPSTREAM_PORT = 443;
export const DEFAULT_LISTEN_PORT = 11435;
export const DEFAULT_CACHE_MAX = 1000;

const LOG = process.env.OPENROUTER_PROXY_LOG || DEFAULT_LOG;
const UPSTREAM_HOST = "openrouter.ai";
const UPSTREAM_PORT = 443;
const LISTEN_PORT = parseInt(process.env.OPENROUTER_PROXY_PORT || String(DEFAULT_LISTEN_PORT), 10);
const MODE = (process.env.REASONING_MODE || "preserve").toLowerCase();
const CACHE_MAX = parseInt(process.env.OPENROUTER_PROXY_CACHE_MAX || String(DEFAULT_CACHE_MAX), 10);

// tool_call_id -> reasoning_content. Insertion-order Map = simple LRU.
const cache = new Map();

function cacheSet(id, reasoning) {
  if (cache.has(id)) cache.delete(id);
  cache.set(id, reasoning);
  while (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
}

const log = (msg) => appendFileSync(LOG, msg);

writeFileSync(LOG, `# openrouter proxy started ${new Date().toISOString()} mode=${MODE} port=${LISTEN_PORT} cacheMax=${CACHE_MAX}\n`);

// Rewrite outgoing /chat/completions body based on MODE + cache state.
function rewriteRequest(body) {
  let json;
  try { json = JSON.parse(body.toString("utf8")); }
  catch { return { body, action: "passthrough-parse-fail" }; }

  if (MODE === "off") {
    if (!json.reasoning) json.reasoning = { enabled: false };
    return { body: Buffer.from(JSON.stringify(json)), action: "disable-thinking" };
  }

  // MODE=preserve: walk history, inject cached reasoning_content
  let injected = 0;
  let orphaned = 0;
  if (Array.isArray(json.messages)) {
    for (const msg of json.messages) {
      const needsReasoning =
        msg.role === "assistant" &&
        Array.isArray(msg.tool_calls) &&
        msg.tool_calls.length > 0 &&
        !msg.reasoning_content &&
        !msg.reasoning;
      if (!needsReasoning) continue;
      const firstId = msg.tool_calls[0]?.id;
      if (firstId && cache.has(firstId)) {
        msg.reasoning_content = cache.get(firstId);
        injected++;
      } else {
        orphaned++;
      }
    }
  }

  if (orphaned > 0) {
    // Fallback: cache miss on a turn that needs echo-back. Disable thinking
    // for THIS request only so DeepSeek doesn't 400. Next response will seed
    // cache again. Injected assistant messages that WERE recovered stay as-is.
    json.reasoning = { enabled: false };
    return {
      body: Buffer.from(JSON.stringify(json)),
      action: `fallback-disable (injected=${injected}, orphaned=${orphaned})`,
    };
  }

  if (injected > 0) {
    return { body: Buffer.from(JSON.stringify(json)), action: `preserve (injected=${injected})` };
  }

  // No assistant-with-tool_calls needing reasoning — first request of a
  // session, or request with only user messages. Pass through unchanged.
  return { body, action: "preserve (no-op)" };
}

// Non-streaming response: extract reasoning + tool_call_ids from one JSON.
function captureNonStreaming(body) {
  try {
    const json = JSON.parse(body.toString("utf8"));
    const msg = json.choices?.[0]?.message;
    if (!msg) return 0;
    const reasoning = msg.reasoning || msg.reasoning_content;
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!reasoning || !toolCalls.length) return 0;
    for (const tc of toolCalls) if (tc.id) cacheSet(tc.id, reasoning);
    return toolCalls.length;
  } catch { return 0; }
}

// Streaming response: accumulate reasoning text + tool_call ids across SSE chunks.
// On stream end, associate the full reasoning with every observed tool_call id.
function parseSSEChunk(chunk, state) {
  state.buffer += chunk.toString("utf8");
  const events = state.buffer.split("\n\n");
  state.buffer = events.pop(); // last may be incomplete, keep for next chunk

  for (const evt of events) {
    for (const line of evt.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.reasoning === "string") state.reasoning += delta.reasoning;
        if (typeof delta.reasoning_content === "string") state.reasoning += delta.reasoning_content;
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (tc.id && !state.toolCallIds.includes(tc.id)) state.toolCallIds.push(tc.id);
          }
        }
      } catch { /* partial JSON across chunks; next chunk completes it */ }
    }
  }
}

// Exported request handler — pure function, no side effects at module load.
// Auto-start path at bottom wraps this in http.createServer() when run directly.
export function handler(clientReq, clientRes) {
  const ts = new Date().toISOString();
  let reqBody = Buffer.alloc(0);
  clientReq.on("data", (c) => { reqBody = Buffer.concat([reqBody, c]); });
  clientReq.on("end", () => {
    const isChat = clientReq.url.includes("/chat/completions");

    let outBody = reqBody;
    let action = "passthrough";
    if (isChat && reqBody.length > 0) {
      const r = rewriteRequest(reqBody);
      outBody = r.body;
      action = r.action;
    }

    log(
      `\n========== ${ts} ${clientReq.method} ${clientReq.url} ` +
      `(${action}, cache=${cache.size}) ==========\n` +
      `REQUEST (${outBody.length} bytes):\n${outBody.toString("utf8").slice(0, 4000)}\n` +
      `---------- RESPONSE ----------\n`
    );

    const fwdHeaders = { ...clientReq.headers };
    delete fwdHeaders.host;
    fwdHeaders["content-length"] = outBody.length;

    const upReq = https.request(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        method: clientReq.method,
        path: clientReq.url,
        headers: fwdHeaders,
      },
      (upRes) => {
        clientRes.writeHead(upRes.statusCode, upRes.headers);
        const ct = upRes.headers["content-type"] || "";
        const isStream = ct.includes("text/event-stream");
        const state = { buffer: "", reasoning: "", toolCallIds: [] };
        let collected = Buffer.alloc(0);

        upRes.on("data", (chunk) => {
          clientRes.write(chunk);
          log(chunk.toString("utf8"));
          if (MODE === "preserve" && isChat) {
            if (isStream) parseSSEChunk(chunk, state);
            else collected = Buffer.concat([collected, chunk]);
          }
        });
        upRes.on("end", () => {
          clientRes.end();
          if (MODE === "preserve" && isChat) {
            let cached = 0;
            if (isStream) {
              if (state.reasoning && state.toolCallIds.length) {
                for (const id of state.toolCallIds) cacheSet(id, state.reasoning);
                cached = state.toolCallIds.length;
              }
            } else {
              cached = captureNonStreaming(collected);
            }
            if (cached > 0) {
              log(`\n[cache] stored reasoning (${state.reasoning.length || "n/a"} chars) for ${cached} tool_call(s)\n`);
            }
          }
          log(`========== END ${upRes.statusCode} (cache size=${cache.size}) ==========\n`);
        });
      }
    );
    upReq.on("error", (err) => {
      log(`PROXY ERROR: ${err.message}\n`);
      clientRes.writeHead(502);
      clientRes.end("proxy error: " + err.message);
    });
    upReq.write(outBody);
    upReq.end();
  });
}

// Test helpers — small, pure, stateful.
export function getCacheSize() { return cache.size; }
export function clearCache() { cache.clear(); }

// Core function exports for testing (names only; no `export function` on
// the actual declarations to avoid duplicate-export errors).
export {
  cacheSet,
  cache,
  rewriteRequest,
  captureNonStreaming,
  parseSSEChunk,
};

// Only auto-start when run directly, not when imported as a module.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  http.createServer(handler).listen(LISTEN_PORT, () => {
    console.log(`openrouter proxy: http://localhost:${LISTEN_PORT} → https://${UPSTREAM_HOST} (mode=${MODE})`);
    console.log(`logs: ${LOG}`);
  });
}
