#!/usr/bin/env node
// Edge authorizer for the MCP tunnel — Caddy `forward_auth` target.
// Validates the ChatGPT-presented JWT against the request Host, so only tokens
// minted FOR this handle reach the tunnel. See DESIGN-CHATGPT-MCP-TUNNEL.md §3.3.
//
// 204 → allow (Caddy proceeds to reverse_proxy → frps vhost).
// 401 + WWW-Authenticate → ChatGPT discovers the AS via protected-resource metadata.

import http from "node:http";
import crypto from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { jwsVerify, handleFromHost, resourceForHandle, PUBLIC_HOST_SUFFIX } from "./lib.mjs";

const PORT = Number(process.env.AUTHZ_PORT || 18796);
const KEY_DIR = process.env.AS_KEY_DIR || "/mnt/openclaw-state/sinain-mcp-tunnel";
const PUB_PATH = join(KEY_DIR, "as-ed25519-public.pem");

// Hot-reload the AS public key (it can rotate); cache by mtime.
let cached = { mtimeMs: 0, key: null };
function asPublicKey() {
  const st = statSync(PUB_PATH);
  if (st.mtimeMs !== cached.mtimeMs) {
    cached = { mtimeMs: st.mtimeMs, key: crypto.createPublicKey(readFileSync(PUB_PATH, "utf8")) };
  }
  return cached.key;
}

function deny(res, host) {
  const meta = `https://${host}/.well-known/oauth-protected-resource`;
  res.writeHead(401, {
    "www-authenticate": `Bearer resource_metadata="${meta}"`,
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

const server = http.createServer((req, res) => {
  try {
    const host = (req.headers["x-forwarded-host"] || req.headers["host"] || "").toString();
    const handle = handleFromHost(host);
    if (!handle) return deny(res, host.split(":")[0] || `unknown${PUBLIC_HOST_SUFFIX}`);

    const auth = (req.headers["authorization"] || "").toString();
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return deny(res, host.split(":")[0]);

    const claims = jwsVerify(m[1], asPublicKey());
    const expected = resourceForHandle(handle);
    const scopeOk = typeof claims?.scope === "string" && claims.scope.split(/\s+/).includes("mcp");
    const audOk = claims && (claims.resource === expected || claims.aud === expected);
    if (!claims || !scopeOk || !audOk) return deny(res, host.split(":")[0]);

    res.writeHead(204, { "x-mcp-handle": handle });
    res.end();
  } catch (err) {
    console.error("[authz] error:", err?.message || err);
    if (!res.headersSent) { res.writeHead(401).end(); }
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`sinain mcp-authz listening on http://127.0.0.1:${PORT} (AS pub ${PUB_PATH})`);
});
